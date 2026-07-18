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
   */
  capturedToolCalls: CapturedToolCall[];
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

    let response: vscode.LanguageModelChatResponse;
    try {
      response = await actingModel.sendRequest(
        messages,
        { tools, toolMode: vscode.LanguageModelChatToolMode.Auto },
        token
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // v0.9.1 defensive: distinguish transient (network/1213/rate-limit)
      // from structural errors. Transient → wait + retry once. Structural →
      // break out and let outer code (moaRunner) fall back to aggregator.
      const isTransient = /1213|429|500|502|503|504|timeout|ETIMEDOUT|ECONNRESET|rate.?limit/i.test(msg);
      if (isTransient && iterations === 0 && !readOnly) {
        // First iteration only — retry transient errors once before giving up.
        stream.progress(`[${progressPrefix}] transient error on first send: ${msg.substring(0, 100)} — retrying in 800ms...`);
        await new Promise((r) => setTimeout(r, 800));
        continue;  // Re-enter while loop, iterations stays at 0.
      }
      if (finalOutput.length === 0) {
        // No output yet — fallback to aggregator guidance directly.
        stream.markdown(`**[${progressPrefix} ${readOnly ? 'recon' : 'acting'} agent error]**: ${msg}\n\n---\n\n**Fallback** — showing aggregator guidance:\n\n${aggregatorGuidance}`);
      } else {
        stream.markdown(`\n\n**[${progressPrefix} ${readOnly ? 'recon' : 'acting'} agent error after partial output]**: ${msg}`);
      }
      finalOutput += `\n\n[error: ${msg}]`;
      break;
    }

    // Collect text + tool calls from this iteration.
    let iterationText = '';
    const toolCalls: vscode.LanguageModelToolCallPart[] = [];

    for await (const part of response.stream) {
      if (part instanceof vscode.LanguageModelTextPart) {
        iterationText += part.value;
      } else if (part instanceof vscode.LanguageModelToolCallPart) {
        toolCalls.push(part);
      }
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
        if (captureResults) {
          let resultText = '';
          for (const c of result.content) {
            if (c instanceof vscode.LanguageModelTextPart) {
              resultText += c.value;
            } else {
              // Non-text parts (JSON etc.) — stringify as best-effort.
              try {
                resultText += JSON.stringify(c);
              } catch {
                resultText += `[non-text part: ${String(c)}]`;
              }
            }
          }
          capturedToolCalls.push({
            name: call.name,
            input: call.input,
            resultText,
          });
        }

        // Add tool result as a User message with ToolResultPart.
        // The callId must match the original ToolCallPart.callId.
        const resultPart = new vscode.LanguageModelToolResultPart(call.callId, result.content);
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
 * v0.13.0 重要变更：去工具名硬编码，按"能力"描述工具。
 *
 * 设计哲学：
 *   - Recon 是 agent，应该自己读 tool.description 决定用哪个，而不是被告诉"用 copilot_X"
 *   - 写死工具名（copilot_readProjectStructure / copilot_grep 等）会破坏移植性：
 *     换了 MCP 供应商、用户禁用 Copilot、新装第三方扩展，硬编码就失效
 *   - 正确做法是描述"你需要什么样的能力"，让 LLM 自己从可用工具列表里挑
 *
 * 工具发现机制：VSCode 会把所有可用工具的 name + description + inputSchema
 * 注入到 LLM 上下文，recon 自己看就行。
 *
 * 关键设计点：
 *   - 明确禁止 analysis/answers —— recon 只收集信息
 *   - 鼓励使用任何 read-only 工具（本地 + web + MCP）
 *   - 输出通过 captureToolResults 捕获，不进 chat history
 *   - missingHints 非空时优先填补这些缺口
 */
function buildReconSystemPrompt(missingHints?: string[]): string {
  const base = [
    'You are the RECON agent in a Mixture of Agents (MoA) pipeline.',
    'Your role is strictly INFORMATION COLLECTION — you do NOT analyze, summarize, or answer the user\'s question.',
    '',
    '# Available capabilities',
    '',
    'You have access to a variety of READ-ONLY tools registered in the current VSCode session.',
    'These may include (but are not limited to):',
    '  - Local file system: project tree, directory listing, file finding, text search, file reading',
    '  - Code intelligence: compile/lint errors, symbol usages, code search',
    '  - Web capabilities (when MCP/GCMP extensions provide them):',
    '    web search, academic search, web page fetching, content extraction',
    '  - External knowledge APIs: chemical/biological/genomic databases, etc.',
    '',
    'IMPORTANT: Do NOT assume specific tool names. Read the tool list yourself and pick by capability.',
    'If a capability you need is missing (e.g. no web search tool available), skip that path gracefully.',
    '',
    '# Your role in the pipeline',
    '',
    'Downstream reference advisors are pure reasoning layer — they see ONLY what you collect, not the workspace.',
    'You are the SOLE information source for the entire MoA pipeline.',
    '  - If you don\'t collect it, refs can\'t reason about it.',
    '  - If you collect irrelevant noise, refs get distracted.',
    '  - Quality and relevance over quantity.',
    '',
    '# Decision framework (adapt to the actual question)',
    '',
    'Judge the nature of the user\'s question, then decide what to gather:',
    '',
    '  1. CODE / WORKSPACE question (e.g. "refactor this module", "find this bug")',
    '     → Use project structure tools first to understand layout, then targeted',
    '       search to locate relevant code, then file reading tools with line ranges',
    '       to read specific sections. Avoid reading whole large files.',
    '',
    '  2. RESEARCH / LITERATURE question (e.g. "analyze hibernation biology")',
    '     → Judge whether refs need external grounding:',
    '       - If web/academic search tools are available AND the question needs',
    '         latest data (papers, APIs, news): use them to gather 2-4 key sources.',
    '       - If the question is about general knowledge refs already have:',
    '         return immediately with no tool calls. Refs can reason directly.',
    '',
    '  3. MIXED question (e.g. "research X then apply to my code")',
    '     → Gather both: code context + relevant external references.',
    '       Keep external content concise (cite source, ~2-5KB per source).',
    '',
    '  4. CONCEPTUAL / ABSTRACT question (e.g. "what is X?", "compare A vs B")',
    '     → Do NOT call any tools. Return empty output. Refs handle this best.',
    '',
    '# Adaptive behaviors (use judgment, don\'t follow rigidly)',
    '',
    '  - For large files: prefer line-range reads over whole-file reads to save tokens.',
    '    Most file reading tools accept startLine/endLine or similar parameters.',
    '  - For ambiguous references (function names, class names): locate first with',
    '    search/grep, then read the specific definition + surrounding context.',
    '  - For multi-file investigations: use project structure tools once at the start,',
    '    then targeted searches — avoid listing the same directory twice.',
    '  - For web content: prefer API-based search tools over browser automation.',
    '    If you accidentally trigger a browser tool, stop — that path is for acting agent.',
    '',
    '# Stop conditions (any one triggers exit)',
    '',
    '  - You\'ve gathered enough relevant context for refs to reason → stop.',
    '  - The question is conceptual → return immediately (no tool calls).',
    '  - You can\'t find relevant files after 2-3 discovery attempts → stop,',
    '    refs will work with whatever you have or flag gaps in their JSON output.',
    '  - You notice yourself calling the same tool with the same input repeatedly',
    '    (you\'re stuck) → stop and let refs flag what\'s still missing.',
    '',
    '# Output protocol',
    '',
    'Do NOT produce a final answer or summary in text.',
    'Your tool calls themselves are the output — their results are captured automatically',
    'and fed to downstream stages.',
    '',
    'Match the language of the user\'s question when deciding what to read/search.',
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
