/**
 * Acting Agent (v0.8.0 Step 2) — Hermes-style 3-layer MoA's acting layer.
 *
 * Architecture (porting Hermes' design):
 *
 *   ┌─── Step 1: Ref fan-out (N refs, equal-mode, see moaRunner.ts)
 *   │     Refs receive workspace context + user prompt, produce advisory text.
 *   │     Output: side-channel (OutputChannel or inline markdown).
 *   ▼
 *   ┌─── Step 2: Aggregator synthesis (current moaRunner.ts)
 *   │     Aggregator reads all ref outputs + user prompt, produces guidance.
 *   │     Output: this is NOT the final user answer anymore (v0.8.0 change).
 *   ▼
 *   ┌─── Step 3: Acting Agent (THIS FILE)
 *   │     Acting agent receives aggregator guidance + user prompt, plus a tool
 *   │     registry (read_file / find_files / apply_patch / run_in_terminal /
 *   │     etc.). Multi-turn loop: model decides when to call tools, executes
 *   │     them, integrates results, continues until no more tool calls.
 *   │     Output: FINAL user-facing Markdown answer.
 *   ▼
 *   User sees the acting agent's final synthesis.
 *
 * What the user sees in chat:
 *   - Ref thinking (progress indicators, OutputChannel for details)
 *   - Aggregator synthesis (progress: "Aggregator synthesizing...")
 *   - Acting agent tool calls (progress: "Acting: reading file X...")
 *   - Acting agent final Markdown response (stream.markdown)
 *
 * What enters chat history (vscode.lm records only markdown()):
 *   - The acting agent's final Markdown answer
 *   - Tool calls are NOT recorded as markdown (only progress + OutputChannel)
 */

import * as vscode from 'vscode';
// v0.14.7: 1213 outgoing dump 需要 fs + path
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/**
 * Acting agent 最大工具调用迭代数（兜底硬上限，防止死循环）。
 * 实际多数任务会在 LLM 自主判断后更早收敛。
 */
const MAX_ACTING_ITERATIONS = 12;

/**
 * Recon agent 默认最大工具调用迭代数。
 * v0.13.0: 默认从 8 提升到 50，并允许通过 `moa.maxReconIterations` 配置覆盖。
 * 实际收敛靠早停机制（工具签名重复、信息饱和、LLM 自主停止），
 * 此常量仅作为最终兜底，避免极端情况下失控。
 */
const DEFAULT_MAX_RECON_ITERATIONS = 50;

/**
 * v0.13.0 起，不再按工具名前缀过滤 —— 所有 vscode.lm 注册的工具对 recon 可见，
 * 由下方黑名单按"动作语义"过滤。这样 MCP / GCMP / 第三方扩展提供的 read-only
 * 工具（如学术搜索、Web 搜索、OCR）能自然进入 recon 工具集，无需改代码适配。
 *
 * 设计哲学：recon 是 agent，让它自己读 tool.description 决定用哪个，
 * 而不是硬编码工具名前缀。这样扩展性更好。
 */

/**
 * 硬黑名单：recon 模式绝对禁用的工具（按动作语义正则匹配）。
 *
 * 命中即屏蔽，无例外。覆盖：
 *   - 文件写入/修改/删除（applyPatch / insertEdit / replaceString / rename / write / create / delete / remove / move）
 *   - 代码格式化/修复类（format / fix / sort / organize —— 它们会改文件）
 *   - Git 副作用（stash / commit / push / merge / reset / rebase）
 *   - 系统级副作用（install）
 *   - 浏览器自动化（drag / click / hover / typeInPage / navigatePage / handleDialog —— 这些会触发真实网站副作用）
 *
 * 注：浏览器自动化纳入硬黑名单的理由是 recon 不应该自动触发真实网站操作
 * （如表单提交、删除按钮点击）。如需网页信息，应使用 web search / fetch 类只读工具。
 */
const RECON_BLACKLIST_HARD: RegExp[] = [
  // —— 文件写入/修改 ——
  /apply.?patch/i,
  /insert.?edit/i,
  /replace.?string/i,
  /rename/i,
  /write/i,
  /create/i,
  /move/i,
  // —— 文件删除 ——
  /delete/i,
  /remove/i,
  // —— 代码格式化/修复（会改文件）——
  /format/i,
  /fix/i,
  /sort/i,
  /organize/i,
  // —— Git 副作用 ——
  /stash/i,
  /commit/i,
  /push/i,
  /merge/i,
  /reset/i,
  /rebase/i,
  // —— 系统级副作用 ——
  /install/i,
  // —— 浏览器自动化（避免触发真实网站副作用）——
  /drag/i,
  /click/i,
  /hover/i,
  /type.?in.?page/i,
  /navigate.?page/i,
  /handle.?dialog/i,
];

/**
 * 软黑名单：默认禁用，但可通过 `moa.reconAllowTerminal` 配置开启。
 *
 * 包含 terminal 类工具 —— 它们既能跑 read-only 命令（npm test, tsc, git log），
 * 也能跑破坏性命令（rm -rf, git push --force）。默认禁用，安全为先；
 * debug 工作流需要时由用户显式开启。
 */
const RECON_BLACKLIST_SOFT: RegExp[] = [
  /run.?in.?terminal/i,
  /send.?to.?terminal/i,
  /kill.?terminal/i,
];

/**
 * 判断一个工具在 recon 模式下是否只读（可用）。
 *
 * @param name 工具名（如 copilot_applyPatch / mcp_gitkraken_commit）
 * @param allowTerminal 是否允许 terminal 类工具（默认 false，从配置读取）
 */
function isReadOnlyTool(name: string, allowTerminal: boolean = false): boolean {
  const hardHit = RECON_BLACKLIST_HARD.some((p) => p.test(name));
  if (hardHit) return false;
  if (!allowTerminal && RECON_BLACKLIST_SOFT.some((p) => p.test(name))) {
    return false;
  }
  return true;
}

/**
 * Result returned by the acting agent loop.
 */
export interface ActingAgentResult {
  /** Final Markdown response that was streamed to the user. */
  output: string;
  /** Number of tool-call iterations executed. */
  iterations: number;
  /** Number of successful tool calls. */
  toolCallsSucceeded: number;
  /** Number of failed tool calls. */
  toolCallsFailed: number;
  /** True if the agent stopped because it hit the iteration cap. */
  hitIterationCap: boolean;
  /**
   * v0.9.0: Captured tool calls (populated when captureToolResults=true).
   * Used by moaRunner to build the recon summary from recon's tool results.
   * Empty array when captureToolResults is false.
   *
   * v0.14.2 KEY INVARIANT: this array is APPEND-ONLY and never cleared on
   * error. Even if sendRequest or the response stream crashes mid-iteration,
   * all tool calls captured *before* the crash remain here. moaRunner relies
   * on this to salvage partial recon content when the LLM API fails
   * transiently (e.g. GLM 1213, DeepSeek 429, etc.).
   */
  capturedToolCalls: CapturedToolCall[];
  /**
   * v0.14.2: Non-empty if the agent exited due to an unrecoverable error
   * (LLM API crash, stream exception, etc.). Empty/undefined = clean exit.
   *
   * When this is set, `capturedToolCalls` may still contain useful partial
   * data — callers should check `capturedToolCalls.length > 0` before
   * discarding the result.
   */
  error?: string;
}

/**
 * Filter `vscode.lm.tools` down to the ones the acting/recon agent may call.
 *
 * v0.8.0: 原方案用 `copilot_` 前缀过滤，仅暴露 Copilot 自带工具。
 * v0.13.0: 移除前缀过滤，让所有 vscode.lm 注册的工具可见（含 MCP / GCMP），
 *          recon 模式下用黑名单按"动作语义"防御性过滤。
 *
 * 设计理由：
 *   - Agent 化：让 LLM 自己读 tool.description 决定用哪个，提升泛化能力
 *   - 扩展性：用户安装新 MCP / 第三方扩展无需改代码
 *   - 防御纵深：黑名单按正则匹配"写入/破坏性"动作，不依赖工具名前缀
 *
 * @param readOnly When true, 只返回 read-only 工具（recon 模式）。Default false.
 * @param allowTerminal recon 模式下是否允许 terminal 类工具。Default false.
 *                     仅在 readOnly=true 时生效。
 */
function getActingTools(readOnly: boolean = false, allowTerminal: boolean = false): vscode.LanguageModelChatTool[] {
  const allTools = vscode.lm.tools;
  return allTools
    .filter((t) => !readOnly || isReadOnlyTool(t.name, allowTerminal))
    .map((t) => ({
      name: t.name,
      description: t.description ?? '',
      inputSchema: t.inputSchema ?? undefined,
    }));
}

/**
 * Options for {@link runActingAgent}.
 *
 * v0.9.0: extracted to support the recon variant without duplicating the
 * ~150-line tool-calling loop body.
 */
export interface ActingAgentOptions {
  /**
   * Optional override for the initial system message. If omitted, a default
   * "you are the acting agent" prompt is used.
   */
  systemPrompt?: string;
  /** Restrict tool registry to read-only tools. Default false. */
  readOnly?: boolean;
  /** Override the iteration cap (default 12, recon uses 8). */
  maxIterations?: number;
  /**
   * Optional progress label prefix. Default "MoA".
   * Recon uses "MoA recon" to distinguish in the UI.
   */
  progressPrefix?: string;
  /**
   * If true, capture all tool results as structured entries for downstream
   * use (recon summary extraction). Default false.
   */
  captureToolResults?: boolean;
}

/**
 * Captured tool invocation entry (when captureToolResults=true).
 * Used by moaRunner to build the recon summary from recon's tool calls.
 */
export interface CapturedToolCall {
  name: string;
  input: unknown;
  /** Plain-text representation of the tool result content. */
  resultText: string;
  /**
   * v0.14.6: Per-part diagnostic metadata. Records the constructor name
   * of each content part + length, so dumpCapturedToolCall can surface
   * what part types a tool actually returned (helps diagnose tools like
   * copilot_fetchWebPage that return non-TextPart rich-content parts).
   */
  partDiagnostics?: Array<{ kind: string; length: number; source: string }>;
}

/**
 * v0.14.6: Recursively extract text content from non-TextPart objects.
 *
 * Background: copilot_fetchWebPage (and similar Copilot built-in tools)
 * return content parts that are NOT LanguageModelTextPart — they are
 * rich-content / PromptTSX parts whose JSON.stringify output is a deeply
 * nested tree ($mid / value / node / ctor / ctorName / children...).
 * Naively JSON.stringifying such parts floods recon content with structural
 * noise, burying the actual text (abstracts, page content) inside a
 * `text` field many levels deep.
 *
 * Strategy (in priority order):
 *   1. Direct string field: value / text / content / markdown
 *   2. Recursive descent: walk `children` arrays and nested `value`/`node`
 *      objects, collecting every leaf `text` field. This matches the
 *      Copilot rich-content tree shape: `{value:{node:{children:[{children:[{text:"..."}]}]}}}`.
 *   3. Fallback: return empty text + a diagnostic source string (the JSON
 *      is NOT inlined into resultText — it would pollute downstream
 *      reasoning; dumpCapturedToolCall records it separately for diagnosis).
 *
 * @returns Extracted text + source descriptor for diagnostics.
 */
function extractTextFromNonTextPart(obj: unknown): { text: string; source: string } {
  if (obj === null || obj === undefined) {
    return { text: '', source: 'null' };
  }
  if (typeof obj === 'string') {
    return { text: obj, source: 'string' };
  }
  if (typeof obj !== 'object') {
    return { text: String(obj), source: typeof obj };
  }

  const o = obj as Record<string, unknown>;

  // 1. Direct string field (priority order: value > text > content > markdown)
  for (const field of ['value', 'text', 'content', 'markdown']) {
    const v = o[field];
    if (typeof v === 'string' && v.length > 0) {
      return { text: v, source: `.${field}` };
    }
  }

  // 2. Recursive descent: collect all leaf `.text` fields in the tree.
  //    Covers Copilot rich-content tree: {value:{node:{children:[...]}}, children:[...]}
  const texts: string[] = [];
  const seen = new WeakSet<object>();  // guard against cycles

  const collect = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    if (seen.has(node as object)) return;
    seen.add(node as object);

    const n = node as Record<string, unknown>;

    // Leaf text — collect if it's a non-empty string.
    // Use a strict check: node must NOT have `children` (avoid duplicating
    // container-level text that's just a label).
    if (typeof n.text === 'string' && n.text.length > 0 && !Array.isArray(n.children)) {
      texts.push(n.text);
    }

    if (Array.isArray(n.children)) {
      for (const child of n.children) collect(child);
    }

    // Nested single-child wrappers: value/node/content/markdown that hold objects.
    for (const field of ['value', 'node', 'content']) {
      const child = n[field];
      if (child && typeof child === 'object') collect(child);
    }
  };

  collect(o);

  if (texts.length > 0) {
    return { text: texts.join('\n'), source: `recursive-text(${texts.length} leaves)` };
  }

  // 3. Fallback: no text extracted. Do NOT inline JSON into resultText —
  //    return empty text + diagnostic source (dumpCapturedToolCall will
  //    record the JSON separately under "## Result (raw fallback)").
  return { text: '', source: 'no-text-extracted' };
}

// ─────────────────────────────────────────────────────────────────────────
// v0.14.12: 相对路径自动转绝对路径
//
// 背景：
//   recon/acting agent 调用 copilot_readFile / copilot_grep_search 等
//   工具时，LLM 经常给出相对路径（如 "GSEAlens/man/foo.Rd"）。VSCode
//   的 copilot_* 工具用 process.cwd() 解析相对路径，而 process.cwd()
//   是 VSCode 可执行文件所在目录（如 "D:\...\Microsoft VS Code\"），
//   不是 workspace root。结果全部 ENOENT。
//
// 修复：
//   在 invokeTool 调用前拦截 input，对路径类字段做规范化：
//     1. 绝对路径 → 原样保留
//     2. 相对路径 → 智能匹配 workspace folder：
//        a. 路径首段匹配某 workspace folder 名 → 拼到该 folder 后
//        b. 否则 → 拼到第一个 workspace folder 后
//     3. 路径里含 \ 或 / → 统一规范化（path.resolve）
//
// 多 workspace 场景：
//   用户有 5 个 workspace folders，路径 "GSEAlens/man/foo.Rd" 首段是
//   "GSEAlens"，匹配名为 "GSEAlens" 的 folder → 拼成
//   "<workspace_root>/GSEAlens/man/foo.Rd"。
// ─────────────────────────────────────────────────────────────────────────

/** 工具 input 中常见的路径字段名（覆盖 copilot_* 与 gcmp_* 等）。 */
const PATH_INPUT_FIELDS = [
  'filePath',
  'path',
  'file',
  'fileName',
  'includePattern',
  'excludePattern',
  'folder',
  'directory',
  'dir',
  'query',          // copilot_grep_search 的 query 也可能是路径
  'pattern',        // 同上
];

/** 检测字符串是否为绝对路径（跨平台：Windows 盘符 / POSIX / UNC）。 */
function isAbsolutePath(p: string): boolean {
  if (!p || typeof p !== 'string') return false;
  // Windows: C:\, C:/, D:\, etc.  — /^[A-Za-z]:[\\/]/
  // POSIX: /...
  // UNC: \\server\share
  return /^(?:[A-Za-z]:[\\/]|[\\/]|[A-Za-z]:[\\/])/.test(p) || p.startsWith('/') || p.startsWith('\\');
}

/**
 * 把一个相对路径解析成绝对路径（相对合适的 workspace folder）。
 *
 * 智能匹配策略：
 *   1. 取路径首段（第一个 / 或 \ 之前的部分）
 *   2. 遍历 workspace.workspaceFolders，找 name 匹配的
 *   3. 匹配到 → 拼成 `<folder.fsPath>/<相对路径>`
 *   4. 都不匹配 → 拼到第一个 workspace folder（典型 fallback）
 *   5. 没有 workspace → 返回原样（让工具自己处理，至少不 worse）
 */
function resolveRelativeToWorkspace(relPath: string): string {
  if (!relPath || typeof relPath !== 'string' || isAbsolutePath(relPath)) {
    return relPath;
  }

  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return relPath;  // 无 workspace 兜底
  }

  // 取首段（统一处理 / 和 \）
  const normalizedRel = relPath.replace(/\\/g, '/');
  const firstSeg = normalizedRel.split('/')[0]?.toLowerCase();

  // 1. 精确匹配 workspace folder name
  if (firstSeg) {
    for (const f of folders) {
      if (f.name.toLowerCase() === firstSeg) {
        return path.resolve(f.uri.fsPath, relPath);
      }
    }
    // 2. 首段是 folder name 的前缀（如 "GSEAlens/man/..." 匹配 folder "GSEAlens"）
    //    上一条已覆盖，这里额外防御：folder name 拼接路径形式
    for (const f of folders) {
      if (normalizedRel.toLowerCase().startsWith(f.name.toLowerCase() + '/')) {
        return path.resolve(f.uri.fsPath, relPath.substring(f.name.length + 1));
      }
    }
  }

  // 3. Fallback：拼到第一个 workspace folder
  return path.resolve(folders[0].uri.fsPath, relPath);
}

/**
 * 规范化工具调用的 input —— 对所有路径类字段做相对→绝对转换。
 *
 * 返回新的 input 对象（不修改原对象）。同时返回一个 diagnostic 字符串
 * （用于 progress 日志，让用户看到路径被改写了）。
 */
function normalizeToolInput(
  toolName: string,
  input: unknown
): { input: unknown; rewritten: string[] } {
  if (!input || typeof input !== 'object') {
    return { input, rewritten: [] };
  }

  const original = input as Record<string, unknown>;
  const rewritten: string[] = [];
  const changed = false;
  const result: Record<string, unknown> = { ...original };

  for (const field of PATH_INPUT_FIELDS) {
    const v = result[field];
    if (typeof v !== 'string' || v.length === 0) continue;

    // skip glob patterns (含 * ? [])  —— 只对纯路径字段做规范化
    if (/[*?\[\]]/.test(v)) continue;

    if (!isAbsolutePath(v)) {
      const resolved = resolveRelativeToWorkspace(v);
      if (resolved !== v) {
        result[field] = resolved;
        rewritten.push(`${field}: "${v}" → "${resolved}"`);
      }
    }
  }

  return { input: result, rewritten };
}

/**
 * Run the acting agent loop.
 *
 * @param actingModel     The LanguageModelChat to use as acting agent
 *                        (usually same as aggregator per v0.8.0 design).
 * @param aggregatorGuidance  The aggregator's synthesized guidance (NOT shown
 *                            to the user directly; injected as context).
 * @param userPrompt      The original user question.
 * @param toolInvocationToken  From the ChatRequest — required for tools to
 *                             associate with the chat session.
 * @param stream          Chat response stream (progress for tool calls,
 *                        markdown for the final answer).
 * @param token           Cancellation token.
 * @param options         v0.9.0: optional overrides (systemPrompt, readOnly, etc.)
 */
export async function runActingAgent(
  actingModel: vscode.LanguageModelChat,
  aggregatorGuidance: string,
  userPrompt: string,
  toolInvocationToken: vscode.ChatParticipantToolToken | undefined,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
  options?: ActingAgentOptions
): Promise<ActingAgentResult> {
  const readOnly = options?.readOnly ?? false;
  const maxIter = options?.maxIterations ?? MAX_ACTING_ITERATIONS;
  const progressPrefix = options?.progressPrefix ?? 'MoA';
  const captureResults = options?.captureToolResults ?? false;

  // v0.13.0: recon 模式下读取 terminal 类工具是否允许（默认 false）
  const config = vscode.workspace.getConfiguration('moa');
  const allowTerminal = readOnly && (config.get<boolean>('reconAllowTerminal') ?? false);

  const tools = getActingTools(readOnly, allowTerminal);
  stream.progress(
    `[${progressPrefix}] ${readOnly ? 'recon' : 'acting'} agent: ${formatModel(actingModel)}, ` +
    `${tools.length} tool(s) available` +
    (readOnly ? (allowTerminal ? ' (read-only + terminal)' : ' (read-only)') : '')
  );

  // Build the initial message: either a custom system prompt (recon) or the
  // default acting-agent prompt (v0.8.0).
  const initialMessage = options?.systemPrompt
    ? `${options.systemPrompt}\n\n=== AGGREGATOR GUIDANCE ===\n${aggregatorGuidance}\n\n=== ORIGINAL USER QUESTION ===\n${userPrompt}`
    : [
        'You are the acting agent in a Mixture of Agents (MoA) process.',
        '',
        'Earlier, multiple reference advisors analyzed the user\'s question and an aggregator synthesized their advice. Use that guidance below to inform your actions.',
        '',
        'You CAN call tools (read files, search code, edit files, run commands) as needed. Use tools when the user\'s question requires concrete action (e.g. "refactor this file", "find usages"). Skip tools and answer directly when the question is conceptual.',
        '',
        '=== AGGREGATOR GUIDANCE (synthesized from N reference advisors) ===',
        aggregatorGuidance,
        '',
        '=== ORIGINAL USER QUESTION ===',
        userPrompt,
      ].join('\n');

  const messages: vscode.LanguageModelChatMessage[] = [
    vscode.LanguageModelChatMessage.User(initialMessage),
  ];

  let iterations = 0;
  let toolCallsSucceeded = 0;
  let toolCallsFailed = 0;
  let finalOutput = '';
  const capturedToolCalls: CapturedToolCall[] = [];

  // v0.14.2: Error state — if the loop exits due to an unrecoverable error,
  // this captures the message. The function NEVER throws; instead it returns
  // a partial result with `error` set and `capturedToolCalls` populated
  // with whatever was collected before the crash. moaRunner can then salvage
  // the partial recon content instead of discarding everything.
  let loopError: string | undefined;

  // v0.14.2: Guard against double-retry on transient errors. The first
  // transient failure (1213/429/network) triggers a single retry; if the
  // retry also fails, we exit with the error rather than looping forever.
  let transientRetried = false;

  // v0.13.0: 早停状态变量（仅 recon 模式启用）
  // - lastToolSignature: 上一轮工具调用集合的 hash，用于检测重复
  // - consecutiveStagnant: 连续"原地踏步"轮数
  // - previousReconSize: 上一轮 capturedToolCalls 累计字符数，用于检测信息饱和
  // - saturatedRounds: 连续"信息饱和"轮数
  let lastToolSignature = '';
  let consecutiveStagnant = 0;
  let previousReconSize = 0;
  let saturatedRounds = 0;
  // 早停阈值（从配置读取，便于调参）
  const earlyStopStagnant = config.get<number>('reconEarlyStopStagnant') ?? 2;
  const earlyStopSaturated = config.get<number>('reconEarlyStopSaturated') ?? 200;
  const earlyStopMinIterations = 5;  // 至少跑 5 轮才启用饱和检测

  while (iterations < maxIter) {
    if (token.isCancellationRequested) break;

    // ── v0.14.2: sendRequest + stream 全部包进 try ────────────────────
    // 原设计：sendRequest 在 try 内，但 `for await (response.stream)` 在 try 外。
    // 这导致 GLM 的 1213 错误（在 stream 中途返回）直接冒泡到 moaRunner，
    // 整段 capturedToolCalls 被丢弃。
    //
    // 现设计：sendRequest 和 stream 同在一个 try 内；任何异常都捕获，
    // transient 错误（1213/429/network）首次重试一次，再次失败或非 transient
    // 则 set loopError 并 break。capturedToolCalls 保留所有已收集的内容。
    //
    // 同时：recon 模式（readOnly=true）现在也支持 transient retry ——
    // 去掉了原来的 `!readOnly` 条件，因为 recon 是最需要保护的场景。
    let response: vscode.LanguageModelChatResponse | null = null;
    let iterationText = '';
    const toolCalls: vscode.LanguageModelToolCallPart[] = [];

    try {
      response = await actingModel.sendRequest(
        messages,
        { tools, toolMode: vscode.LanguageModelChatToolMode.Auto },
        token
      );

      // v0.14.2: stream 现在也在 try 内 —— GLM 1213 / DeepSeek 429 等错误
      // 会在 stream 中途异步抛出，必须在这里捕获。
      for await (const part of response.stream) {
        if (part instanceof vscode.LanguageModelTextPart) {
          iterationText += part.value;
        } else if (part instanceof vscode.LanguageModelToolCallPart) {
          toolCalls.push(part);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isTransient = /1213|429|500|502|503|504|timeout|ETIMEDOUT|ECONNRESET|rate.?limit/i.test(msg);
      // v0.14.6: 1213 是 provider SDK 层"prompt 参数异常"错误（典型于 GLM）。
      // 重试同样的 messages + tools schema 不会改变结果，反而浪费 token + 时间。
      // 直接跳过重试，进入诊断流程。
      const is1213 = /1213/.test(msg);

      // v0.14.2: 去掉了 `!readOnly` 条件 —— recon 模式也重试。
      // 只重试一次（transientRetried guard），且只在首次迭代（避免污染已建立的工具链）。
      // v0.14.6: 1213 跳过重试（schema 不兼容重试无意义）。
      if (isTransient && !is1213 && iterations === 0 && !transientRetried) {
        transientRetried = true;
        stream.progress(
          `[${progressPrefix}] transient error on first iteration: ${msg.substring(0, 100)} ` +
          `— retrying in 800ms (attempt 2/2)...`
        );
        await new Promise((r) => setTimeout(r, 800));
        continue;  // Re-enter while loop, iterations stays at 0.
      }

      // v0.14.6: 1213 专门诊断 —— dump messages + tools schema 概要，
      // 附加到 loopError 末尾（PARTIAL RECOVERY 路径会落盘到 refChannel）。
      let diagnosticSuffix = '';
      if (is1213) {
        const msgSummary = messages.map((m, i) => {
          let size = 0;
          let partCount = 0;
          const content = (m as { content?: unknown }).content;
          if (Array.isArray(content)) {
            for (const part of content) {
              partCount++;
              if (part && typeof part === 'object') {
                const p = part as { value?: unknown; text?: unknown };
                if (typeof p.value === 'string') size += p.value.length;
                else if (typeof p.text === 'string') size += p.text.length;
                else size += 200;  // 非文本 part 估算
              } else if (typeof part === 'string') {
                size += part.length;
              }
            }
          }
          const role = (m as { role?: unknown }).role;
          return `  msg[${i}] role=${String(role)} parts=${partCount} size~${size}`;
        }).join('\n');

        const toolsSummary = tools.map((t) => {
          const schema = t.inputSchema ? JSON.stringify(t.inputSchema) : '';
          const hasAdvanced = /\$ref|oneOf|anyOf|allOf/.test(schema);
          const hasRecursive = /"items":\s*\{\s*"\$ref"/.test(schema);
          const flags =
            (hasAdvanced ? '+ADV' : '') +
            (hasRecursive ? '+RECURSE' : '');
          return `  ${t.name} schemaSize=${schema.length}${flags}`;
        }).join('\n');

        diagnosticSuffix =
          `\n\n--- 1213 DIAGNOSTICS ---\n` +
          `Error class: provider SDK rejected prompt or tools schema.\n` +
          `Likely causes (in order of probability):\n` +
          `  1. A tool's inputSchema uses features the provider SDK can't serialize\n` +
          `     ($ref, oneOf, anyOf, recursive items). See tools summary below —\n` +
          `     any tool flagged +ADV or +RECURSE is suspect.\n` +
          `  2. Provider-specific tool calling limitation (some providers reject\n` +
          `     tool arrays with too many entries, or schemas above a size cap).\n` +
          `  3. Provider rejects system-prompt-as-user-message pattern.\n\n` +
          `Messages summary (${messages.length} message(s)):\n${msgSummary}\n\n` +
          `Tools summary (${tools.length} tool(s)):\n${toolsSummary}\n\n` +
          `SUGGESTION: switch moa.reconModel to a different provider (e.g. DeepSeek-V4)\n` +
          `to confirm whether the issue is provider-specific.`;

        stream.progress(
          `[${progressPrefix}] 1213 SDK error — diagnostics appended to error log. ` +
          `${messages.length} msgs, ${tools.length} tools. ` +
          `Likely tool schema incompatibility — see PARTIAL RECOVERY log.`
        );

        // v0.14.7: 完整 dump outgoing messages 到磁盘，用于精确定位 1213 根因。
        // 文件路径：${os.tmpdir()}/moa_1213_dump/outgoing_<timestamp>.json
        // 内容：每条 message 的 content parts（含 ctor name / keys / innerContent
        // 元数据），每个 tool 的 inputSchema + $ref/oneOf 标记。
        try {
          const dumpDir = path.join(os.tmpdir(), 'moa_1213_dump');
          if (!fs.existsSync(dumpDir)) fs.mkdirSync(dumpDir, { recursive: true });
          const ts = new Date().toISOString().replace(/[:.]/g, '-');
          const dumpFile = path.join(dumpDir, `outgoing_${ts}.json`);

          const msgsDump = messages.map((m, i) => {
            const content = (m as { content?: unknown }).content;
            const role = (m as { role?: unknown }).role;
            return {
              idx: i,
              role: String(role),
              content: Array.isArray(content)
                ? content.map((p: unknown, j: number) => {
                    const part = p as Record<string, unknown>;
                    const ctor = (part as { constructor?: { name?: string } })?.constructor?.name ?? typeof p;
                    const entry: Record<string, unknown> = {
                      partIdx: j,
                      ctor,
                      keys: part && typeof part === 'object' ? Object.keys(part).slice(0, 15) : [],
                    };
                    if (typeof part.value === 'string') {
                      entry.valuePreview = part.value.substring(0, 300);
                      entry.valueLength = part.value.length;
                    }
                    if (typeof part.text === 'string') {
                      entry.textPreview = part.text.substring(0, 300);
                      entry.textLength = part.text.length;
                    }
                    if (typeof part.callId === 'string') entry.callId = part.callId;
                    if (typeof part.name === 'string') entry.name = part.name;
                    // ToolResultPart 内层 content（关键诊断点：是否为空数组）
                    if (Array.isArray(part.content)) {
                      entry.innerContentType = 'array';
                      entry.innerContentLength = part.content.length;
                      entry.innerContent = (part.content as unknown[]).map((ic: unknown, k: number) => {
                        const inner = ic as Record<string, unknown>;
                        const innerCtor = (inner as { constructor?: { name?: string } })?.constructor?.name ?? typeof ic;
                        const innerEntry: Record<string, unknown> = {
                          innerIdx: k,
                          ctor: innerCtor,
                        };
                        if (typeof inner.value === 'string') {
                          innerEntry.valuePreview = (inner.value as string).substring(0, 200);
                        }
                        if (typeof inner.text === 'string') {
                          innerEntry.textPreview = (inner.text as string).substring(0, 200);
                        }
                        return innerEntry;
                      });
                    }
                    return entry;
                  })
                : typeof content === 'string'
                  ? [{ asString: content.substring(0, 500) }]
                  : [],
            };
          });

          const toolsDump = tools.map((t) => {
            const schemaStr = t.inputSchema ? JSON.stringify(t.inputSchema) : '';
            return {
              name: t.name,
              schemaSize: schemaStr.length,
              hasRef: /\$ref/.test(schemaStr),
              hasOneOf: /oneOf/.test(schemaStr),
              hasAnyOf: /anyOf/.test(schemaStr),
              hasAllOf: /allOf/.test(schemaStr),
              hasRecursiveItems: /"items":\s*\{\s*"\$ref"/.test(schemaStr),
              schemaPreview: schemaStr.substring(0, 500),
            };
          });

          const dump = {
            timestamp: ts,
            error: msg,
            modelId: actingModel.id,
            iterations,
            capturedToolCallsCount: capturedToolCalls.length,
            toolsCount: tools.length,
            tools: toolsDump,
            messagesCount: messages.length,
            messages: msgsDump,
            note: 'This dump captures the OUTGOING request that triggered 1213. Key things to check: 1) any message with empty content array (indicates a ToolResultPart got empty innerContent — path A confirmed). 2) Any tool with hasRef/hasOneOf/hasRecursiveItems=true (path C confirmed). 3) If all clean → likely GLM server-side bug with thinking + tool_results combination (path B).',
          };

          fs.writeFileSync(dumpFile, JSON.stringify(dump, null, 2), 'utf8');
          diagnosticSuffix += `\n\nOutgoing request dumped to: ${dumpFile}`;
        } catch (dumpErr) {
          const dumpMsg = dumpErr instanceof Error ? dumpErr.message : String(dumpErr);
          diagnosticSuffix += `\n\nDump failed: ${dumpMsg}`;
        }
      }

      // 非 transient，或已重试过 —— 记录 error 并 break（保留已 captured 内容）。
      loopError = msg + diagnosticSuffix;
      stream.progress(
        `[${progressPrefix}] ${readOnly ? 'recon' : 'acting'} agent error after ${capturedToolCalls.length} ` +
        `captured tool call(s): ${msg.substring(0, 120)}`
      );
      if (finalOutput.length === 0 && !readOnly) {
        stream.markdown(`**[${progressPrefix} agent error]**: ${msg}\n\n---\n\n**Fallback** — showing aggregator guidance:\n\n${aggregatorGuidance}`);
      }
      finalOutput += `\n\n[error: ${msg}]`;
      break;
    }

    // If model emitted text AND no tool calls, this is the final answer.
    if (toolCalls.length === 0) {
      finalOutput += iterationText;
      // For recon: do NOT stream text to user — recon output is captured
      // via capturedToolCalls for downstream summary extraction. Only the
      // final aggregator/acting output should hit stream.markdown.
      if (!readOnly) {
        stream.markdown(iterationText);
      }
      break;
    }

    // Model wants to call tools. Show progress (does NOT enter chat history).
    // First emit any text the model produced alongside the tool call.
    if (iterationText.trim().length > 0) {
      finalOutput += iterationText;
      if (!readOnly) {
        stream.markdown(iterationText);
      }
    }

    iterations++;
    stream.progress(
      `[${progressPrefix}] ${readOnly ? 'recon' : 'acting'} iteration ${iterations}/${maxIter}: ` +
      `${toolCalls.length} tool call(s)`
    );

    // Add the assistant message with tool calls to the conversation.
    // API contract: LanguageModelChatMessage.Assistant can hold ToolCallPart.
    const assistantMsg = vscode.LanguageModelChatMessage.Assistant('');
    for (const call of toolCalls) {
      assistantMsg.content.push(call);
    }
    messages.push(assistantMsg);

    // Execute each tool call and add the result as a User message.
    for (const call of toolCalls) {
      const shortName = call.name.length > 40 ? call.name.substring(0, 37) + '...' : call.name;

      // v0.14.12: 相对路径自动转绝对路径
      // LLM 经常把 "GSEAlens/man/foo.Rd" 这种相对路径直接传给 copilot_readFile，
      // 但 copilot_* 工具用 process.cwd()（VSCode 可执行文件目录）解析相对路径，
      // 导致全部 ENOENT。这里在调用前规范化：相对 → 绝对（基于 workspace folder）。
      const { input: normalizedInput, rewritten: pathRewrites } = normalizeToolInput(
        call.name,
        call.input
      );
      // 用规范化后的 input 覆盖 call.input（影响后续 capturedToolCalls 记录、
      // shortInput 显示、以及实际 invokeTool 调用）
      if (pathRewrites.length > 0) {
        (call as { input?: unknown }).input = normalizedInput;
        stream.progress(
          `[${progressPrefix}] ${readOnly ? 'recon' : 'acting'} path normalization: ` +
          pathRewrites.join('; ').substring(0, 200)
        );
      }

      const shortInput = JSON.stringify(call.input).substring(0, 100);
      stream.progress(`[${progressPrefix}] ${readOnly ? 'recon' : 'acting'} tool: ${shortName}(${shortInput})`);

      try {
        if (!toolInvocationToken) {
          throw new Error('No toolInvocationToken in ChatRequest (cannot execute tools)');
        }
        // API signature: invokeTool(name, { input, toolInvocationToken }, token)
        const result = await vscode.lm.invokeTool(
          call.name,
          { input: call.input, toolInvocationToken },
          token
        );

        // Capture plain-text representation of the result (for recon summary).
        // v0.14.7: 同时规范化 result.content，确保透传给 ToolResultPart 的 parts 都是
        // TextPart / ImagePart（GCMP LY 函数能处理的类型）。
        //
        // 背景：copilot_fetchWebPage 等 Copilot 内置工具返回 PromptTSX 富文本 part，
        // 这些 part 不是 LanguageModelTextPart。原代码直接透传 raw result.content
        // 给 ToolResultPart，导致 GCMP LY 函数处理时落入"未知 part 类型"分支，
        // 静默丢弃 → tool_result.content = [] → 第二轮 sendRequest 时 GLM /api/anthropic
        // 兼容层校验失败，返回 code:1213 "未正常接收到 prompt 参数"。
        //
        // 修复策略：复用 extractTextFromNonTextPart 把未知 part 转成 TextPart，
        // 确保每个 tool_result 至少有 1 个 TextPart。
        //
        // 类型说明：result.content 是 vscode.LMToolResult['content']，类型是
        // LanguageModelTextPart | LanguageModelImagePart 等的并集。ImagePart 在
        // 公开 @types/vscode 类型定义中可能未导出，但运行时存在 —— 这里用 ctor.name
        // 字符串判断，不依赖类型系统。
        let resultText = '';
        const partDiagnostics: Array<{ kind: string; length: number; source: string }> = [];
        const normalizedContent: (vscode.LanguageModelTextPart | Record<string, unknown>)[] = [];

        for (const c of result.content) {
          const partCtorName = (c as { constructor?: { name?: string } })?.constructor?.name;
          if (c instanceof vscode.LanguageModelTextPart) {
            resultText += c.value;
            normalizedContent.push(c);
            partDiagnostics.push({ kind: 'TextPart', length: c.value.length, source: '.value' });
          } else if (partCtorName === 'LanguageModelImagePart' || partCtorName === 'ImagePart') {
            // ImagePart 在 @types/vscode 中可能未导出为 public 类型，
            // 但运行时存在且 GCMP LY 函数有专门分支处理。保留原样。
            normalizedContent.push(c as Record<string, unknown>);
            partDiagnostics.push({ kind: 'ImagePart', length: 0, source: 'image' });
          } else {
            // v0.14.6: 非 TextPart 智能提取 —— 递归收集 .text / .value 字段，
            // 避免 copilot_fetchWebPage 等工具的 JSON 序列化噪音淹没真实内容。
            const kind = partCtorName ?? typeof c;
            const extracted = extractTextFromNonTextPart(c);
            if (extracted.text.length > 0) {
              resultText += extracted.text;
              // v0.14.7: 关键修复 —— 把提取出来的文本包成新的 TextPart，
              // 替换原始的未知 part 类型。这样 GCMP LY 函数处理时不再落入
              // "未知 part" 分支被静默丢弃。
              normalizedContent.push(new vscode.LanguageModelTextPart(extracted.text));
            }
            // 即使没提取到文本也记录诊断（kind + source 帮助排查）
            partDiagnostics.push({ kind, length: extracted.text.length, source: extracted.source });
          }
        }

        // v0.14.7: 极端兜底 —— 如果规范化后 normalizedContent 为空（所有 part 都
        // 是未知类型且 extractTextFromNonTextPart 都没提取到），强制塞一个占位
        // TextPart，避免 ToolResultPart.content=[] 触发 GLM 1213。
        if (normalizedContent.length === 0) {
          const placeholder = `[tool ${call.name} returned ${result.content.length} part(s) but none could be converted to text]`;
          normalizedContent.push(new vscode.LanguageModelTextPart(placeholder));
          resultText = placeholder;
          partDiagnostics.push({ kind: 'Placeholder', length: placeholder.length, source: 'fallback' });
        }

        if (captureResults) {
          capturedToolCalls.push({
            name: call.name,
            input: call.input,
            resultText,
            partDiagnostics,
          });
        }

        // Add tool result as a User message with ToolResultPart.
        // The callId must match the original ToolCallPart.callId.
        // v0.14.7: 使用 normalizedContent 而非 raw result.content，避免 GLM 1213。
        // 类型断言：normalizedContent 元素是 TextPart 或被保留的 ImagePart（透传），
        // 都是 LanguageModelToolResultPart 接受的类型。
        const resultPart = new vscode.LanguageModelToolResultPart(
          call.callId,
          normalizedContent as vscode.LanguageModelTextPart[]
        );
        const resultMsg = vscode.LanguageModelChatMessage.User('');
        resultMsg.content.push(resultPart);
        messages.push(resultMsg);

        toolCallsSucceeded++;
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        const truncated = errMsg.length > 200 ? errMsg.substring(0, 200) + '...' : errMsg;
        stream.progress(`[${progressPrefix}] ${readOnly ? 'recon' : 'acting'} tool ${shortName} FAILED: ${truncated}`);

        // Even on failure, we must add a tool result so the model can recover.
        // API contract: ToolResultPart with error content.
        const errorResult = new vscode.LanguageModelToolResultPart(
          call.callId,
          [new vscode.LanguageModelTextPart(`Tool error: ${errMsg}`)]
        );
        const errorMsg = vscode.LanguageModelChatMessage.User('');
        errorMsg.content.push(errorResult);
        messages.push(errorMsg);

        toolCallsFailed++;
      }
    }

    // ── v0.13.0: 早停检测（仅 recon 模式启用）─────────────────────────
    // 三层防御：
    //   1. 工具签名重复：连续 N 轮用同样工具+同样输入 → 死循环，立即停
    //   2. 信息饱和：iterations > 5 后单轮新增信息 < 阈值 → 没新发现，停
    //   3. LLM 自主停止：上面的 toolCalls.length===0 分支已处理（自然退出）
    //
    // 注：acting 模式（readOnly=false）不启用早停，因为 acting agent 的
    // 工具调用本就是任务执行本身，"重复"可能是合理的迭代修复。
    if (readOnly) {
      // 1. 计算本轮工具签名（name + input 摘要）
      const currentSig = toolCalls
        .map((c) => {
          const inputStr = JSON.stringify(c.input).substring(0, 80);
          return `${c.name}:${inputStr}`;
        })
        .sort()  // 排序保证顺序无关
        .join('|');
      if (currentSig === lastToolSignature) {
        consecutiveStagnant++;
      } else {
        consecutiveStagnant = 0;
      }
      lastToolSignature = currentSig;

      // 2. 计算本轮新增信息量（capturedToolCalls 累计字符数差）
      if (captureResults && iterations > earlyStopMinIterations) {
        const currentSize = capturedToolCalls.reduce((s, c) => s + c.resultText.length, 0);
        const delta = currentSize - previousReconSize;
        if (delta < earlyStopSaturated) {
          saturatedRounds++;
        } else {
          saturatedRounds = 0;
        }
        previousReconSize = currentSize;
      }

      // 3. 触发早停
      if (consecutiveStagnant >= earlyStopStagnant) {
        stream.progress(
          `[${progressPrefix}] recon 早停：连续 ${consecutiveStagnant} 轮工具签名重复（疑似死循环）`
        );
        break;
      }
      if (saturatedRounds >= earlyStopStagnant) {
        stream.progress(
          `[${progressPrefix}] recon 早停：连续 ${saturatedRounds} 轮新增信息 < ${earlyStopSaturated} 字符（信息饱和）`
        );
        break;
      }
    }
    // ── 早停检测结束 ─────────────────────────────────────────────────
  }

  const hitIterationCap = iterations >= maxIter;
  if (hitIterationCap) {
    if (!readOnly) {
      stream.markdown(`\n\n*[${progressPrefix} acting agent stopped at iteration cap (${maxIter}). Final output may be incomplete.]*`);
    } else {
      stream.progress(`[${progressPrefix}] recon hit iteration cap (${maxIter}) — proceeding with partial recon`);
    }
  }

  return {
    output: finalOutput,
    iterations,
    toolCallsSucceeded,
    toolCallsFailed,
    hitIterationCap,
    capturedToolCalls,  // v0.9.0: always returned; empty if captureToolResults=false
    // v0.14.2: 如果 loop 因错误退出，记录 error。即使有 error，
    // capturedToolCalls 仍可能含有 partial 内容 —— 调用方应检查 length。
    error: loopError,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// v0.9.0: Recon agent — Phase 0 of the recon → ref → aggregator → acting pipeline.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Result of the recon phase. Captured file contents are extracted from the
 * underlying ActingAgentResult.capturedToolCalls by moaRunner.
 */
export interface ReconResult {
  /** Raw recon agent result (for transparency / debugging). */
  raw: ActingAgentResult;
  /**
   * Structured summary built from captured tool calls. This is what gets
   * injected into ref prompts. Format: "=== RECON SUMMARY ===\n<files>\n..."
   * Built by moaRunner.extractReconSummary(), not here.
   */
  summaryText: string;
}

/**
 * Recon-only system prompt.
 *
 * v0.13.0: 去工具名硬编码，按"能力"描述工具。
 * v0.14.2: 大幅强化 —— recon 不再"克制"，对研究类问题主动拉摘要/详情。
 *          核心变化：
 *          - 区分任务类型（代码 vs 研究），研究任务主动深化
 *          - 对每条文献/资源，主动调用 extract_content 类工具拉摘要正文
 *          - refs 上下文负担极低（单轮无历史），可以塞 50-100k 内容
 *          - recon 自己也是单轮无历史，可以放心多调工具
 *
 * 设计哲学：
 *   - Recon 是 agent，应该自己读 tool.description 决定用哪个
 *   - recon + refs 都是"单轮无对话历史"的轻上下文场景
 *   - 现代 LLM 都是 1M 上下文，refs 拿到 50k 完全无压力
 *   - 信息越丰富，refs 分析质量越高
 */
function buildReconSystemPrompt(missingHints?: string[]): string {
  const base = [
    'You are the RECON agent in a Mixture of Agents (MoA) pipeline.',
    '',
    '# Your role',
    '',
    'You are the SOLE information gatekeeper for downstream stages:',
    '  - Reference advisors (refs) are pure reasoning — they see ONLY what you collect.',
    '  - Refs cannot call tools, browse, or access files.',
    '  - The aggregator and acting agent build on refs\' analysis.',
    '',
    'Your job: gather information rich enough that refs can give GROUNDED, DETAILED analysis.',
    'You do NOT analyze or answer — you gather. Quality of downstream analysis depends entirely on you.',
    '',
    '# Downstream capacity (why you should not be conservative)',
    '',
    '  - Refs are single-turn (no chat history accumulation).',
    '  - Modern LLMs handle 100K-1M tokens. Refs can easily process 50-200KB of recon data.',
    '  - Your own context is also single-turn — feel free to call many tools.',
    '  - More relevant information = richer downstream analysis.',
    '',
    'Bottom line: do NOT ration information. If a resource looks relevant, fetch it in full.',
    '',
    '# Available capabilities',
    '',
    'You have access to READ-ONLY tools registered in the current VSCode session.',
    'Read each tool\'s description to understand its capability. Common categories include:',
    '',
    '  - **Local file system**: project tree, directory listing, file reading (with line ranges),',
    '    text search, code intelligence (errors, usages, symbol lookup).',
    '  - **Web & knowledge capabilities** (when MCP/GCMP extensions provide them):',
    '    * General web search, academic search, news search',
    '    * Specialist databases: PubMed, arXiv, bioRxiv, Semantic Scholar, OpenAlex, Crossref',
    '    * Content extraction from URLs (DOI, PMID, arXiv ID, journal pages)',
    '    * Domain APIs: UniProt, ChEMBL, gnomAD, GTEx, Ensembl, etc.',
    '    * General web page fetching (for blog posts, documentation, tutorials)',
    '',
    'Use BOTH local and web tools as appropriate for the question. Many questions benefit',
    'from combining code context (local) with external references (web).',
    '',
    'Do NOT hardcode tool names. Pick by CAPABILITY — read descriptions and choose.',
    '',
    '# Judge the question, then gather accordingly',
    '',
    'You decide what kind of context this question needs. Some patterns:',
    '',
    '  - **Code/workspace focus**: "refactor X", "find bug in Y", "how does Z work in my code"',
    '    → Gather code structure + relevant files (with line ranges for large files) + symbol usages.',
    '',
    '  - **Research/literature focus**: "analyze X mechanism", "review Y topic", "what is known about Z"',
    '    → Gather literature: search → fetch abstracts/full text for each relevant paper.',
    '',
    '  - **Conceptual**: "what is X?", "compare A vs B"',
    '    → If X/A/B are stable general knowledge refs already know: minimal gathering needed.',
    '    → If they involve recent research, specific data, or live APIs: gather like research.',
    '',
    '  - **Mixed**: "apply paper X to my code", "is this approach industry-standard?"',
    '    → Combine: external references + local code context.',
    '',
    '  - **Data lookup**: "what\'s the expression of gene X in tissue Y?"',
    '    → Use domain databases (GTEx, etc.) to fetch actual records, not just IDs.',
    '',
    'These are examples, not exhaustive categories. Use judgment.',
    '',
    '# What counts as "good" recon content',
    '',
    'The goal is INFORMATION SUBSTANCE, not a specific byte count.',
    '',
    'GOOD recon content has:',
    '  - Full text or abstracts of relevant resources (not just identifiers/titles)',
    '  - Specific data points, numbers, quotes — the kind refs can cite',
    '  - Clear provenance (source URL, paper title, file:line)',
    '  - Coverage of the main aspects the question asks about',
    '',
    'BAD recon content (avoid):',
    '  - A bare list of identifiers (PMIDs, DOIs, file paths) with no actual content',
    '    — refs cannot reason about an ID. Always fetch the actual abstract/text.',
    '  - One-sentence summaries of resources you didn\'t actually open',
    '  - The first search result page when deeper content is available',
    '',
    '# Aggressive gathering patterns',
    '',
    'When a resource looks relevant, fetch it in depth:',
    '  - Found a relevant paper? Get its abstract, and if available, key full-text sections.',
    '  - Found a relevant doc page? Fetch the actual content, not just the URL.',
    '  - Found a relevant file? Read the actual code, not just list the path.',
    '  - Found a database record? Get the full record fields, not just the ID.',
    '',
    'For research questions with multiple relevant sources, fetch ALL of them — don\'t stop at 2-3.',
    'For recent developments, prioritize web/preprint sources over stale textbook knowledge.',
    '',
    '# Iteration awareness',
    '',
    'This may be round 1 of N. If you\'re given "missing hints" (below), prioritize filling',
    'those specific gaps first. Otherwise, gather broadly on round 1 — refs will flag',
    'gaps and the next round will target them.',
    '',
    '# Stop conditions',
    '',
    'Stop when ANY of these is true:',
    '  - You\'ve gathered substantive content covering the question\'s main aspects.',
    '  - Additional searches return mostly duplicates of what you have.',
    '  - You\'ve tried 2-3 different search angles without finding new relevant material.',
    '  - You notice yourself repeating the same tool call with the same input.',
    '',
    'Do NOT stop just because you have "a list" — refs need the actual content, not pointers.',
    '',
    '# Output protocol',
    '',
    'Do NOT produce a final answer or textual summary.',
    'Your tool calls themselves are the output — their results are captured automatically.',
    '',
    'Match the language of the user\'s question for search queries',
    '(Chinese question → can search in English for broader coverage, then prefer',
    'Chinese sources when quality is equivalent).',
    '',
    '# Path handling (v0.14.12+)',
    '',
    'When calling file-reading or search tools, prefer ABSOLUTE paths. The runtime',
    'auto-resolves relative paths against the workspace root, but explicit absolute',
    'paths are more robust and easier to debug. If you see a workspace folder name',
    '(e.g. "GSEAlens/", "src/") in a path, prefix it with the workspace root.',
    '',
    'For multi-workspace setups, paths like "GSEAlens/man/foo.Rd" will be matched',
    'against workspace folder names — so relative paths starting with a folder name',
    'are fine. But when in doubt, use the absolute form.',
  ];

  if (missingHints && missingHints.length > 0) {
    base.push(
      '',
      '# PRIORITY: Fill these gaps from ref advisors FIRST',
      '',
      'In the previous recon round, reference advisors indicated they need MORE information on:',
      missingHints.map((h, i) => `${i + 1}. ${h}`).join('\n'),
      '',
      'Interpretation guide (adapt to actual tool capabilities):',
      '  - File path (e.g. "src/foo.ts" or "src/foo.ts:120-150")',
      '    → use a file reading tool with that path (and line range if given)',
      '  - Function/class name (e.g. "funcName", "ClassName")',
      '    → use a code search tool to locate, then read with line range',
      '  - Vague description (e.g. "how authentication works")',
      '    → use a semantic code search tool with the description as query',
      '  - External reference (e.g. "latest paper on X", "API docs for Y")',
      '    → use web search / academic search tools if available',
      '',
      'Prioritize filling these specific gaps. Discovery (find_files etc.) is allowed but secondary — these hints are guaranteed to be needed.'
    );
  }

  return base.join('\n');
}

/**
 * Run the recon phase (v0.9.0 Phase 0).
 *
 * This is a thin wrapper around {@link runActingAgent} with:
 *   - readOnly tools only
 *   - A recon-specific system prompt
 *   - captureToolResults=true (so moaRunner can build the summary)
 *   - Lower iteration cap (8 vs 12) — recon should be faster than acting
 *   - Progress prefix "MoA recon" for UI clarity
 *
 * @param reconModel       Model to use (usually aggregator model, like acting).
 * @param userPrompt       Original user question.
 * @param toolInvocationToken From ChatRequest.
 * @param stream           Chat response stream.
 * @param token            Cancellation token.
 * @param missingHints     Optional hints from previous sufficiency gate
 *                         (Phase 1.5 loop-back). Empty on first recon round.
 */
export async function runReconAgent(
  reconModel: vscode.LanguageModelChat,
  userPrompt: string,
  toolInvocationToken: vscode.ChatParticipantToolToken | undefined,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
  missingHints?: string[]
): Promise<ReconResult> {
  const systemPrompt = buildReconSystemPrompt(missingHints);

  // v0.13.0: 最大轮数从配置读取（默认 50，兜底硬上限）
  const config = vscode.workspace.getConfiguration('moa');
  const maxReconIter = config.get<number>('maxReconIterations') ?? DEFAULT_MAX_RECON_ITERATIONS;

  const raw = await runActingAgent(
    reconModel,
    '',  // no aggregator guidance in recon — guidance is empty
    userPrompt,
    toolInvocationToken,
    stream,
    token,
    {
      systemPrompt,
      readOnly: true,
      maxIterations: maxReconIter,
      progressPrefix: 'MoA recon',
      captureToolResults: true,
    }
  );

  // Summary text is built by moaRunner (which owns the workspace context
  // and knows the character budget). Here we just return an empty stub.
  return {
    raw,
    summaryText: '',
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Internal helpers.
// ─────────────────────────────────────────────────────────────────────────

function formatModel(m: { name: string; vendor?: string }): string {
  const v = (m.vendor ?? '').trim();
  return v ? `${m.name} [${v}]` : m.name;
}
