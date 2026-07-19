/**
 * MoA Runner — bridges the chat participant to PowerShell MoA scripts.
 *
 * Two execution strategies are wired up here:
 *
 * 1. P2b — Call `MoaWrapper.ps1` via `pwsh`. Hermes handles the actual
 *    fan-out / aggregation, so this extension just pipes stdout into the
 *    chat response stream.
 *
 * 2. P1 — Native subagent simulation. We pick 3 chat models available via
 *    `vscode.lm.selectChatModels`, run them in parallel, then call an
 *    aggregator model to fuse the perspectives.
 *
 * P2a (ACP protocol) is detected but not implemented in this skeleton —
 * it requires a separate "ACP client" extension to be running.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import type { MoaPath, MoaRunResult, RefModelConfig } from './types';
import { buildWorkspaceContext } from './workspaceContext';
import { runActingAgent, runReconAgent } from './actingAgent';
import type { CapturedToolCall } from './actingAgent';
import { getActivePresetConfig } from './presetConfig';
// v0.13.0: L3 summarizer（孙代理）—— 仅在使用时动态 import，避免影响启动
import { shouldTriggerL3 } from './l3Summarizer';

// ─────────────────────────────────────────────────────────────────────────
// v0.12.4: Module-level reconContext passing (replaces broken config key).
//
// moa_analyze tool needs to pass pre-collected reconContext to runP1Fanout
// so refs see the caller's file contents instead of running Phase 0 recon.
//
// Previously this used `config.update('callerReconContext', ...)` which fails
// on VSCode 1.90+ because the key isn't declared in package.json — error:
//   "没有注册配置 moa.callerReconContext，因此无法写入 用户设置"
//
// Module-level variable is cleaner: same-process, no global state pollution,
// no package.json declaration needed. Set via setCallerReconContext().
// ─────────────────────────────────────────────────────────────────────────

let _callerReconContext = '';
let _callerReconSources: string[] = [];

/**
 * Set the caller-supplied reconContext (called by moa_analyze tool).
 * Pass empty string to clear.
 */
export function setCallerReconContext(context: string, sources: string[]): void {
  _callerReconContext = context;
  _callerReconSources = sources;
}

/**
 * Lazily-created OutputChannel for thinking-mode ref output.
 *
 * v0.7.3: persists across the extension lifetime so the user can scroll back
 * through past @moa turns' ref outputs. Each turn is delimited by a header
 * with timestamp + prompt + summary.
 */
let _refOutputChannel: vscode.OutputChannel | undefined;
function getRefOutputChannel(): vscode.OutputChannel {
  if (!_refOutputChannel) {
    _refOutputChannel = vscode.window.createOutputChannel('MoA Bridge — Ref Output');
  }
  return _refOutputChannel;
}

/** v0.7.3: returns the OutputChannel if thinking-mode is active, else undefined. */
function createOutputChannel(): vscode.OutputChannel | undefined {
  return getRefOutputChannel();
}

/**
 * Format a model for display in chat output: "Name [vendor]".
 *
 * v0.7.2: vendor suffix is critical when multiple vendors register the same
 * model name (e.g. "GLM-5.2 (CodingPlan)" exists under both gcmp.zhipu and
 * gcmp.volcengine). Without it the user can't tell which instance is
 * actually being called — this caused real misconfiguration in v0.7.0.
 *
 * If vendor is missing/empty, falls back to just the name.
 */
function formatModel(m: { name: string; vendor?: string }): string {
  const v = (m.vendor ?? '').trim();
  return v ? `${m.name} [${v}]` : m.name;
}

/**
 * Run MoA via the P1 native path (vscode.lm).
 *
 * v0.8.0: Three-layer Hermes architecture.
 *   Layer 1: N reference advisors (equal-mode, Hermes `_REFERENCE_SYSTEM_PROMPT`)
 *            — see SHARED_REF_PROMPT_DEFAULT below. Workspace context is injected.
 *   Layer 2: Aggregator synthesizes ref outputs into guidance (Hermes synth_prompt).
 *   Layer 3: Acting agent (NEW in v0.8.0) — takes aggregator guidance + tool
 *            registry, runs a multi-turn tool-calling loop to actually
 *            accomplish the user's task (read files, edit, run commands).
 *
 * Pre-v0.8.0, the aggregator's output was the final user-facing answer.
 * v0.8.0 changes this: aggregator output becomes guidance for the acting
 * agent, and the acting agent produces the final answer (with tool support).
 *
 * Disable with `moa.enableActingAgent: false` to fall back to the v0.7.x
 * 2-layer behavior.
 */
export async function runP1Fanout(
  prompt: string,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
  toolInvocationToken?: vscode.ChatParticipantToolToken
): Promise<MoaRunResult> {
  const start = Date.now();

  // v0.14.3: 初始化 recon dump（落盘 audit + 给 acting agent 后续读取）
  const startedAt = new Date();
  const taskSha = computeTaskSha(prompt, startedAt);
  const dumpDir = getReconDumpDir(taskSha);
  const dumpMetaState: ReconDumpMeta = {
    taskSha,
    prompt,
    startedAt: startedAt.toISOString(),
    reconRoundsUsed: 0,
    refCount: 0,
    totalChars: 0,
  };
  if (dumpDir) {
    stream.progress(`[MoA] recon dump: .moa_cache/recon/${taskSha}/`);
  }

  // Pick any models the user has available.
  const allCandidates = await vscode.lm.selectChatModels({});

  // Filter out placeholder/pseudo models (e.g. VSCode's "Auto" selector).
  const PLACEHOLDER_NAMES = new Set(['auto', 'automatic', 'default', '']);
  const realCandidates = allCandidates.filter(
    (m) => !PLACEHOLDER_NAMES.has(m.name.toLowerCase().trim())
  );

  // ---------- Resolve ref configuration ----------
  // v0.7.0: Look up by m.id (unique) first; fall back to m.name substring
  // for backward compat with configs saved by v0.6.x or earlier. This handles
  // the "same model name under multiple vendors" case correctly — only the
  // exact-id match wins.
  const config = vscode.workspace.getConfiguration('moa');

  // v0.14.14: 统一通过 preset 配置读取（替代直接读 moa.refModels）。
  // getActivePresetConfig() 解析顺序：
  //   1. moa.presets[activePreset] —— 新机制
  //   2. legacy flat config (refModels+aggregator+reconModel+l3Summarizer) —— 向后兼容
  //   3. { isEmpty: true } —— 未配置
  const activePreset = getActivePresetConfig();
  if (activePreset.isEmpty) {
    throw new Error(
      'No preset configured. Run "Moa: Configure Models" to set up refs/aggregator/recon/L3, ' +
        'or "Moa: Switch Preset" if you have saved presets.'
    );
  }
  const refModelsCfg: RefModelConfig[] = activePreset.refModels;
  stream.progress(
    `[MoA] active preset: "${activePreset.activeName}"${activePreset.fromLegacy ? ' (legacy)' : ''} (${refModelsCfg.length} refs configured)`
  );

  const refsToUse: { model: vscode.LanguageModelChat; label: string }[] = [];

  for (const cfg of refModelsCfg) {
    // Primary: exact match on m.id (v0.7.0 saved configs).
    let match = realCandidates.find((m) => (m.id ?? '') === cfg.model);
    // Fallback: substring match on m.name (v0.6.x compat — picks the FIRST match).
    if (!match) {
      match = realCandidates.find((m) => m.name.toLowerCase().includes(cfg.model.toLowerCase()));
    }
    if (match) {
      refsToUse.push({ model: match, label: cfg.role || match.name });
    } else {
      stream.markdown(
        `**[config]** Ref "${cfg.role || cfg.model}" → model "${cfg.model}" not found in available models, skipping.\n\n`
      );
    }
  }
  stream.progress(`[MoA] using moa.refModels: ${refsToUse.length}/${refModelsCfg.length} matched`);

  if (refsToUse.length === 0) {
    throw new Error(
      'No usable reference models. Run "Moa: Configure Models" to set up refs, ' +
        'or check that your configured model substrings match real vscode.lm model names.'
    );
  }
  // Cap at 8 refs max (safety valve; UI also caps at 8).
  const MAX_REFS = 8;
  const probePool = refsToUse.length > MAX_REFS ? refsToUse.slice(0, MAX_REFS) : refsToUse;
  stream.progress(
    `[MoA] probing ${probePool.length} model(s): ${probePool.map((r) => `${r.label}→${formatModel(r.model)}`).join(', ')}`
  );

  // ─────────────────────────────────────────────────────────────────────────
  // Built-in reference advisor system prompt.
  //
  // v0.14.2: 大幅松绑研究/学术任务的约束。
  //
  // 核心变化：
  //   - 区分 CODE 任务 vs RESEARCH 任务（运行时检测）
  //   - CODE 任务保持严格"只看 recon data"（防止编造 API）
  //   - RESEARCH 任务允许 refs 动用训练知识补充分析（明确分层标注）
  //   - 不再硬性禁止"基于训练知识的推论"——LLM 的训练知识本身是有价值的
  //
  // 设计哲学：
  //   - refs 单轮无历史，上下文负担极低，可以塞 50-100KB
  //   - 现代 LLM 训练知识丰富，完全禁止使用反而是浪费
  //   - 关键是分层：recon data vs 训练知识要明确标注
  //   - 让 aggregator 来做最终判断（aggregator 会综合多个 refs 的观点）
  // ─────────────────────────────────────────────────────────────────────────
  const SHARED_REF_PROMPT_DEFAULT = [
    'You are a reference advisor in a Mixture of Agents (MoA) process. You are NOT the acting agent and you do NOT execute anything: you cannot call tools, run commands, browse, or access files. A separate aggregator model will synthesize your advice with other advisors and produce the final response.',
    '',
    '## Your context',
    '',
    'You see three things:',
    '  1. This system prompt.',
    '  2. The RECON DATA block — everything the recon agent collected for this question.',
    '  3. The user question.',
    '',
    'The recon agent has already judged what is relevant and gathered it for you.',
    'You do NOT see the workspace, open files, or project tree directly — recon did that work.',
    '',
    '## Your job',
    '',
    'Give your most intelligent analysis of the user\'s question:',
    '  - Use the RECON DATA as your primary grounding (it was collected for you).',
    '  - Combine it with your own training knowledge when that adds value.',
    '  - Surface the best answer, concrete reasoning, pitfalls, and anything missed.',
    '  - Disagree with the framing if appropriate.',
    '',
    '## Source labeling (when mixing recon + training)',
    '',
    'When you state a non-obvious fact, mark where it came from:',
    '  - "[recon: ...]" — from the RECON DATA block',
    '  - "[training: ...]" — from your training data',
    '  - "[inference: ...]" — your logical deduction',
    '',
    'This helps the aggregator weigh sources and lets the user verify claims.',
    'For plainly obvious statements no label is needed.',
    '',
    '## If recon data seems insufficient',
    '',
    'You have two options depending on the question:',
    '  - For questions where your training knowledge can credibly fill the gap:',
    '    proceed with training knowledge, labeled. Provide your best analysis.',
    '  - For questions that absolutely need specific files/data you don\'t see:',
    '    set sufficient=false and list SPECIFIC items in "missing" (file paths,',
    '    symbols, paper IDs, data points). The recon agent will fetch them next round.',
    '',
    'Use your judgment — don\'t reflexively flag missing for everything.',
    '',
    'Respond with your advice directly — no preamble, no disclaimers about tools.',
    'Your response is private guidance to the aggregator, not a user-facing answer.',
    '',
    'Match the language of the user\'s question (Chinese question → Chinese advice).',
  ].join('\n');
  const sharedRefPrompt =
    config.get<string>('sharedRefPrompt') ?? SHARED_REF_PROMPT_DEFAULT;

  type RefResult = {
    model: vscode.LanguageModelChat;
    name: string;
    label: string;
    text: string;
  };
  const successes: RefResult[] = [];
  const failures: { name: string; msg: string }[] = [];

  // v0.7.3: Ref output mode (moa.refDisplayMode).
  //   - "thinking" (default, Hermes-style): refs shown only as progress
  //     indicators ("Ref advisor_1 / DeepSeek-V4-Flash thinking...") in the
  //     chat UI. The detailed ref content goes to the MoA Bridge OutputChannel
  //     for the user to inspect on demand. Crucially, this means ref content
  //     does NOT enter chat history (vscode.lm only records markdown() calls
  //     as ChatResponseTurn content). The next @moa or @workspace request
  //     will only see the aggregator's synthesis — matching Hermes' design
  //     where ref outputs are side-channel advisory calls.
  //   - "verbose": legacy behavior — refs stream directly into chat as
  //     markdown (visible inline AND recorded in history). Use this if you
  //     want Copilot to reference individual ref opinions in follow-ups.
  const refDisplayMode = config.get<'thinking' | 'verbose'>('refDisplayMode') ?? 'thinking';
  // v0.14.14: 真正读取 parallelRefs 配置（之前从未被读取过）
  // 默认 true —— 并行 fan-out，wall-clock = 最慢的 ref
  // 设为 false 时退化为串行（老行为）
  const parallelRefs = config.get<boolean>('parallelRefs') ?? true;
  const refChannel = refDisplayMode === 'thinking' ? createOutputChannel() : undefined;
  if (refChannel) {
    refChannel.appendLine(`=== @moa request @ ${new Date().toISOString()} ===`);
    refChannel.appendLine(`Prompt: ${prompt}`);
    refChannel.appendLine(`Mode: ${refDisplayMode}, Refs: ${probePool.length}, Parallel: ${parallelRefs}`);
    refChannel.appendLine('');
  }

  // v0.12.5 DESIGN CHANGE: refs are now PURE REASONING LAYER.
  //
  // Pre-v0.12.5: refs were force-fed workspace context (active editor +
  // open docs + project tree) on every call. This polluted the ref prompt
  // with irrelevant info — refs are supposed to analyze what recon gives
  // them, not blindly see whatever the user happens to have open.
  //
  // Post-v0.12.5 (Hermes true alignment):
  //   - recon is the ONLY information source for refs
  //   - if recon succeeded: refs see only reconSummary + user question
  //   - if recon failed/disabled and no callerReconContext: refs get bare prompt
  //     (they can still reason about the abstract task — just not grounded)
  //   - workspace context (active editor / tree / open docs) is NOT injected
  //     to refs anymore; recon agent itself decides what's relevant by
  //     calling copilot_readProjectStructure / copilot_listDirectory as needed
  //
  // For research/literature tasks (no files to read), recon naturally returns
  // empty/minimal summary → refs analyze the abstract question directly.
  // For code tasks, recon reads the relevant files and refs see ONLY those.
  //
  // wsContextText is still built (for recon agent's own use if it wants to
  // call copilot_readProjectStructure etc.) but no longer force-fed to refs.
  const wsContext = await buildWorkspaceContext();
  // NOTE: wsContext is now only used for the recon agent's tool environment,
  // not injected into ref prompts. Kept for backward-compat logging only.
  if (refChannel) {
    refChannel.appendLine('--- Workspace context (available to recon agent only, NOT injected to refs) ---');
    refChannel.appendLine('(refs are pure reasoning layer — see only reconSummary + user question)');
    refChannel.appendLine('');
  }

  // ─────────────────────────────────────────────────────────────────────────
  // v0.9.0: Resolve aggregator model EARLY (recon reuses it).
  // Original v0.8.0 resolved aggregator after refs; we now need it before Phase 0.
  // v0.14.14: 改为读 activePreset.aggregator（不再直接 config.get('aggregator')）
  // ─────────────────────────────────────────────────────────────────────────
  const aggCfg = activePreset.aggregator;
  let aggregator: vscode.LanguageModelChat = probePool[0].model;
  if (aggCfg?.model) {
    let aggMatch = realCandidates.find((m) => (m.id ?? '') === aggCfg.model);
    if (!aggMatch) {
      aggMatch = realCandidates.find((m) =>
        m.name.toLowerCase().includes(aggCfg.model!.toLowerCase())
      );
    }
    if (aggMatch) aggregator = aggMatch;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // v0.14.0: Resolve recon model — 可独立配置，空时 fallback 到 aggregator
  // v0.14.14: 改为读 activePreset.reconModel
  //
  // 设计：
  //   - 读 activePreset.reconModel.model（vscode.lm m.id）
  //   - 空字符串 / 未配置 → 复用 aggregator（保持 v0.13.x 行为）
  //   - 配置了 → 用对应模型（用于"aggregator 用 GLM-5.2，recon 用 DeepSeek" 等场景）
  //
  // 决策顺序：精确 id 匹配 → name 子串 → fallback 到 aggregator
  // ─────────────────────────────────────────────────────────────────────────
  const reconCfg = activePreset.reconModel;
  let reconModel: vscode.LanguageModelChat = aggregator;  // 默认 = aggregator
  if (reconCfg?.model && reconCfg.model.trim().length > 0) {
    let reconMatch = realCandidates.find((m) => (m.id ?? '') === reconCfg.model);
    if (!reconMatch) {
      reconMatch = realCandidates.find((m) =>
        m.name.toLowerCase().includes(reconCfg.model!.toLowerCase())
      );
    }
    if (reconMatch) {
      reconModel = reconMatch;
    } else {
      // 配置了但找不到匹配模型 —— 警告并 fallback
      stream.progress(
        `[MoA] reconModel="${reconCfg.model}" 未找到匹配模型，fallback 到 aggregator`
      );
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // v0.9.0: Phase 0 (Recon) + Phase 1 (Ref fan-out) + Phase 1.5 (Sufficiency gate)
  //
  // Multi-round loop:
  //   for round in 1..maxRounds:
  //     Phase 0:  recon agent collects files relevant to user's question
  //     Phase 1:  refs analyze (with recon data + JSON output: sufficient/missing/analysis)
  //     Phase 1.5: if majority of refs say sufficient=true → break, go to aggregator
  //                else: collect missing hints, loop back to Phase 0
  //
  // When enableRecon=false: skip Phase 0 entirely; run Phase 1 once (no JSON
  // sufficiency check — preserve v0.8.0 behavior for users who disable recon).
  //
  // When callerReconContext is set (v0.10.2: from moa_analyze tool), we use it
  // as the initial recon summary for round 1 — this lets the calling LLM
  // pre-collect files via copilot_readFile and pass the contents in directly.
  //
  // Recon reuses the aggregator model (consistent with v0.8.0 acting agent).
  // ─────────────────────────────────────────────────────────────────────────
  const enableRecon = config.get<boolean>('enableRecon') ?? true;
  const maxReconRoundsRaw = config.get<number>('maxReconRounds') ?? 3;
  const maxReconRounds = Math.max(1, Math.min(5, maxReconRoundsRaw));
  // v0.14.5: reconContextChars 不再作上限 —— 只读取用于 meta 审计。
  // 原设计假设下游 LLM 上下文紧张，但 refs 单轮无历史 + 1M 上下文模型，
  // 即使 recon 收集到 1MB+ 也应该原样传递。
  // 如果 recon 真的爆了，说明检索方向出问题（噪声过多）——
  // 这是 LLM 应该意识到并处理的，不是靠截断救场。
  const reconContextChars = config.get<number>('reconContextChars') ?? 500000;
  const hasToolsEarly = vscode.lm.tools.filter((t) => t.name.startsWith('copilot_')).length > 0;
  const canRecon = enableRecon && hasToolsEarly && !!toolInvocationToken;
  const effectiveMaxRounds = canRecon ? maxReconRounds : 1;

  // v0.12.5 BUGFIX: When recon fails/produces-no-content, we previously did
  // `break` which exits the ENTIRE sufficiencyLoop — skipping ref fan-out.
  // User-reported symptom: "--- Recon round 1: NO USEFUL CONTENT ---" directly
  // followed by "--- Aggregator guidance ---" with NO ref output in between.
  //
  // Fix: use a "reconBroken" flag. When recon fails, set reconBroken=true and
  // continue to Phase 1 (refs run with empty reconSummary — that's fine for
  // research/literature tasks). Subsequent rounds skip Phase 0 (since recon
  // is broken) but still run refs + sufficiency gate.
  let reconBroken = false;

  // v0.10.2 / v0.12.4: Caller-supplied pre-collected context (from moa_analyze tool).
  // When present, this REPLACES the Phase 0 recon — we inject it directly into
  // the ref prompt as the "RECON DATA" block.
  //
  // v0.12.4: Read from module-level variable instead of config key — the old
  // config.update('callerReconContext', ...) approach fails on VSCode 1.90+
  // because the key isn't declared in package.json.
  const callerReconContext = _callerReconContext;
  const callerReconSources = _callerReconSources;

  let reconSummary = '';
  let missingHints: string[] | undefined = undefined;
  let reconRoundsUsed = 0;

  // If caller provided reconContext, prep it as the initial summary.
  // v0.14.5: 不再截断 —— 上层 agent 传多少全量注入 refs。
  if (callerReconContext && callerReconContext.trim().length > 0) {
    reconSummary = callerReconContext;
    if (refChannel) {
      refChannel.appendLine(
        `--- Using caller-supplied reconContext (${callerReconContext.length} chars ` +
        `from: ${callerReconSources.join(', ') || 'unspecified'}) ---`
      );
      refChannel.appendLine('');
    }
  }

  sufficiencyLoop:
  for (let round = 1; round <= effectiveMaxRounds; round++) {
    if (token.isCancellationRequested) break;

    // ── Phase 0: Recon ──────────────────────────────────────────────────
    // v0.10.2: Skip Phase 0 if caller already provided reconContext (round 1).
    // v0.12.5: Skip if recon is broken (failed earlier in this loop).
    if (canRecon && !reconBroken && !(round === 1 && reconSummary)) {
      stream.progress(
        `[MoA] Phase 0: recon round ${round}/${effectiveMaxRounds} ` +
        `${missingHints ? `(filling ${missingHints.length} hint(s))` : '(initial)'}...`
      );

      // v0.9.0 hotfix1: Two-pass — prefetch hints with explicit paths FIRST,
      // then let recon agent handle query-only hints + any new discoveries.
      let prefetched: Map<number, string> = new Map();
      if (missingHints && missingHints.length > 0) {
        prefetched = await prefetchFromHints(
          missingHints,
          toolInvocationToken!,
          stream,
          token
        );
        stream.progress(
          `[MoA] prefetched ${prefetched.size}/${missingHints.length} hint(s); recon agent handles the rest`
        );
      }

      // v0.14.2: 重构异常处理 —— runReconAgent 现在永不 throw，
      // 但仍保留 catch 做兜底防御。关键变化：
      //   1. 即使 recon.raw.error 非空，也尝试 extractReconSummary
      //   2. 只要 capturedToolCalls 有内容，就保住 partial recon
      //   3. extractReconSummary 自身异常也单独 catch
      let recon: Awaited<ReturnType<typeof runReconAgent>> | null = null;
      try {
        // v0.14.0: recon 用独立的 reconModel（fallback 到 aggregator）
        recon = await runReconAgent(
          reconModel,
          prompt,
          toolInvocationToken!,
          stream,
          token,
          // Pass prefetched hints to recon so it skips them and focuses on
          // the unresolved (query-only) ones + new discovery.
          (() => {
            if (!missingHints) return undefined;
            const hints = missingHints;  // local const for TS narrowing
            return hints
              .map((h, i) => (prefetched.has(i + 1) ? '' : h))
              .filter((s) => s.length > 0);
          })()
        );
      } catch (err) {
        // v0.14.2: runReconAgent 内部已全 catch，这里几乎是 dead code，
        // 但保留作为最后防线。在这种情况下，capturedToolCalls 不可得。
        const msg = err instanceof Error ? err.message : String(err);
        stream.progress(
          `[MoA] Phase 0: recon round ${round} CRASHED UNEXPECTEDLY (${msg.substring(0, 100)}) — ` +
          `disabling further recon, refs will run without recon data`
        );
        if (refChannel) {
          refChannel.appendLine(`--- Recon round ${round} CRASHED (defensive catch — this should not happen, please report) ---`);
          refChannel.appendLine(msg);
          refChannel.appendLine('');
        }
        reconBroken = true;
        recon = null;
      }

      if (recon) {
        const hasPartialContent = recon.raw.capturedToolCalls.length > 0 || prefetched.size > 0;
        const reconError = recon.raw.error;

        // v0.14.2: 即使有 error，只要 capturedToolCalls 有内容就尝试 extract
        // 这是修复"1213 错误时整段丢弃"的关键。
        let newReconSummary = '';
        if (hasPartialContent) {
          try {
            newReconSummary = await extractReconSummary(
              recon.raw.capturedToolCalls,
              prefetched,
              missingHints ?? [],
              reconContextChars,
              prompt,
              toolInvocationToken
            );
          } catch (extractErr) {
            // extractReconSummary 自身异常（如 L3 孙代理 crash）—— 不丢弃已 captured 的原始内容
            const extractMsg = extractErr instanceof Error ? extractErr.message : String(extractErr);
            stream.progress(
              `[MoA] Phase 0: extractReconSummary FAILED (${extractMsg.substring(0, 100)}) — ` +
              `falling back to raw captured content`
            );
            // Fallback: 直接拼接原始 capturedToolCalls（不做 L1/L2/L3 处理）
            // v0.14.5: 不截断 —— 原样全量拼接
            newReconSummary = recon.raw.capturedToolCalls
              .map((c) => `=== [${c.name}] ===\n${c.resultText}`)
              .join('\n\n');
          }
        }

        const reconWasUseful = newReconSummary.length > 100 || prefetched.size > 0;

        if (reconError && reconWasUseful) {
          // v0.14.2 新路径：recon 中途出错但保住了 partial 内容
          stream.progress(
            `[MoA] Phase 0: recon round ${round} hit error but RECOVERED ${newReconSummary.length} chars ` +
            `from ${recon.raw.capturedToolCalls.length} captured call(s) — refs will use partial recon. ` +
            `Error: ${reconError.substring(0, 80)}`
          );
          if (refChannel) {
            // v0.14.6: 完整 dump error（含 1213 诊断后缀），不再 substring(150)
            refChannel.appendLine(
              `--- Recon round ${round} PARTIAL RECOVERY (error below, full) ---`
            );
            refChannel.appendLine(
              `Recovered ${newReconSummary.length} chars from ${recon.raw.capturedToolCalls.length} ` +
              `captured tool call(s) + ${prefetched.size} prefetched hint(s). ` +
              `${recon.raw.toolCallsSucceeded} ok / ${recon.raw.toolCallsFailed} failed.`
            );
            refChannel.appendLine('=== ERROR (full) ===');
            refChannel.appendLine(reconError);
            refChannel.appendLine('=== END ERROR ===');
            const preview = newReconSummary.length > 2000
              ? newReconSummary.substring(0, 2000) + '\n... (truncated in log)'
              : newReconSummary;
            refChannel.appendLine(preview);
            refChannel.appendLine('');
          }
          reconSummary = newReconSummary;
          reconRoundsUsed = round;
          // 有 partial 内容时也 set reconBroken，避免下一轮再 trigger 同样的 error
          reconBroken = true;
          // v0.14.3: 落盘 capturedToolCalls + 完整 recon summary
          if (dumpDir) {
            recon.raw.capturedToolCalls.forEach((c, i) => dumpCapturedToolCall(dumpDir, i, c));
            dumpFullRecon(dumpDir, reconSummary);
            dumpMetaState.reconRoundsUsed = reconRoundsUsed;
            dumpMetaState.totalChars = reconSummary.length;
          }
        } else if (newReconSummary.trim() === '(no recon data captured)' || !reconWasUseful) {
          // 真的没有任何内容 —— 与原 v0.9.1 行为一致
          stream.progress(
            `[MoA] Phase 0: recon round ${round} produced no usable content ` +
            `(${recon.raw.toolCallsSucceeded} ok / ${recon.raw.toolCallsFailed} failed, ` +
            `${prefetched.size} prefetched) — proceeding without recon`
          );
          if (refChannel) {
            refChannel.appendLine(`--- Recon round ${round}: NO USEFUL CONTENT — disabling further recon, refs will run without recon data ---`);
            if (reconError) {
              refChannel.appendLine(`Underlying error: ${reconError}`);
            }
            refChannel.appendLine('');
          }
          reconBroken = true;
        } else {
          // 完全成功路径（原 v0.9.0 行为）
          reconSummary = newReconSummary;
          reconRoundsUsed = round;
          // v0.14.3: 落盘 capturedToolCalls + 完整 recon summary
          if (dumpDir) {
            recon.raw.capturedToolCalls.forEach((c, i) => dumpCapturedToolCall(dumpDir, i, c));
            dumpFullRecon(dumpDir, reconSummary);
            dumpMetaState.reconRoundsUsed = reconRoundsUsed;
            dumpMetaState.totalChars = reconSummary.length;
          }

          if (refChannel) {
            refChannel.appendLine(
              `--- Recon round ${round} (prefetched: ${prefetched.size}, ` +
              `recon tool calls: ${recon.raw.capturedToolCalls.length}, ` +
              `${recon.raw.toolCallsSucceeded} ok / ${recon.raw.toolCallsFailed} failed) ---`
            );
            const preview = reconSummary.length > 2000
              ? reconSummary.substring(0, 2000) + '\n... (truncated in log)'
              : reconSummary;
            refChannel.appendLine(preview);
            refChannel.appendLine('');
          }
        }
      }
    }

    // ── Phase 1: Ref fan-out ────────────────────────────────────────────
    // v0.12.5: refs are PURE REASONING LAYER. They see ONLY:
    //   1. sharedRefPrompt (Hermes system prompt)
    //   2. reconSummary (if any — the ONLY information source)
    //   3. user question
    // No workspace context, no active editor, no project tree.
    // If recon didn't gather enough, refs flag gaps in JSON "missing" field.
    //
    // v0.14.14: 真正实现 moa.parallelRefs
    //   - parallelRefs=true (默认): Promise.allSettled 并行 fan-out
    //     wall-clock = max(ref durations)，N 个 ref 理论上 N 倍速
    //   - parallelRefs=false: 串行（老行为，适合 provider 限流场景）
    //
    // pre-v0.14.14: parallelRefs 配置项存在但从未被读取，永远是串行。
    // v0.14.14 修复了这个挂着的开关，默认并行。
    successes.length = 0;  // Clear per-round; final round's analyses feed aggregator.

    // Build the ref prompt body ONCE (same for all refs — equal-mode MoA).
    // Each ref gets the same prompt; diversity comes from model differences.
    const refPromptBody = buildRefPromptBody(sharedRefPrompt, reconSummary, prompt);

    // Progress indicator for thinking mode (fired once per round, not per ref,
    // because in parallel mode we can't track individual progress).
    if (refDisplayMode === 'thinking') {
      const refLabels = probePool.map((r) => `${r.label}/${formatModel(r.model)}`).join(', ');
      stream.progress(
        `[MoA] Phase 1 round ${round}: ${probePool.length} ref(s) ${parallelRefs ? 'in parallel' : 'sequentially'} — ${refLabels}`
      );
    }

    if (parallelRefs) {
      // ── 并行路径 (v0.14.14 default) ──────────────────────────────────
      // Promise.allSettled: 所有 ref 同时发出，单个失败不影响其他。
      // wall-clock = 最慢的 ref 耗时（而非所有 ref 之和）。
      const tasks = probePool.map((ref) => runSingleRef(ref, refPromptBody, round, token));
      const results = await Promise.allSettled(tasks);

      // 按原顺序处理结果（保持 successes 顺序稳定，便于日志与 aggregator）
      for (let i = 0; i < probePool.length; i++) {
        const ref = probePool[i];
        const result = results[i];
        if (result.status === 'fulfilled' && result.value.ok) {
          const text = result.value.text;
          if (refDisplayMode === 'verbose') {
            stream.markdown(`**Ref [${ref.label} / ${formatModel(ref.model)} (round ${round})]**:\n\n${text}\n\n---\n\n`);
          } else {
            refChannel?.appendLine(`--- Ref ${ref.label} / ${formatModel(ref.model)} (round ${round}) ---`);
            refChannel?.appendLine(text);
            refChannel?.appendLine('');
          }
          successes.push({ model: ref.model, name: ref.model.name, label: ref.label, text });
          if (dumpDir) {
            dumpRefOutput(dumpDir, successes.length - 1, ref.label, ref.model.name, text, round);
          }
          stream.progress(`Ref ${ref.label} / ${formatModel(ref.model)} done (${text.length} chars, round ${round})`);
        } else if (result.status === 'fulfilled' && !result.value.ok) {
          // runSingleRef 内部捕获的错误
          const msg = result.value.error ?? 'unknown error';
          const shortMsg = msg.length > 150 ? msg.substring(0, 150) + '...' : msg;
          if (refDisplayMode === 'verbose') {
            stream.markdown(`**Ref [${ref.label} / ${formatModel(ref.model)} (round ${round})]**: [skipped] ${shortMsg}\n\n---\n\n`);
          } else {
            stream.progress(`Ref ${ref.label} / ${formatModel(ref.model)} FAILED (round ${round}): ${shortMsg}`);
            refChannel?.appendLine(`--- Ref ${ref.label} / ${formatModel(ref.model)} [FAILED round ${round}] ---`);
            refChannel?.appendLine(msg);
            refChannel?.appendLine('');
          }
          failures.push({ name: `${ref.label}/${ref.model.name}`, msg });
        } else if (result.status === 'rejected') {
          // Promise rejected (shouldn't happen — runSingleRef catches all)
          // 加 result.status === 'rejected' 类型保护，让 TS 知道这里是 rejected 分支
          const reason = (result as PromiseRejectedResult).reason;
          const msg = String(reason instanceof Error ? reason.message : reason);
          failures.push({ name: `${ref.label}/${ref.model.name}`, msg });
          stream.progress(`Ref ${ref.label} / ${formatModel(ref.model)} CRASHED (round ${round}): ${msg}`);
        }
      }
    } else {
      // ── 串行路径 (legacy behavior) ───────────────────────────────────
      // 逐个 await，单 ref 完成后才跑下一个。适合 provider 限流场景。
      for (const ref of probePool) {
        if (token.isCancellationRequested) break;
        if (refDisplayMode === 'thinking') {
          stream.progress(`Ref ${ref.label} / ${formatModel(ref.model)} thinking (round ${round})...`);
        }
        const result = await runSingleRef(ref, refPromptBody, round, token);
        if (result.ok) {
          const text = result.text;
          if (refDisplayMode === 'verbose') {
            stream.markdown(`**Ref [${ref.label} / ${formatModel(ref.model)} (round ${round})]**:\n\n${text}\n\n---\n\n`);
          } else {
            refChannel?.appendLine(`--- Ref ${ref.label} / ${formatModel(ref.model)} (round ${round}) ---`);
            refChannel?.appendLine(text);
            refChannel?.appendLine('');
            stream.progress(`Ref ${ref.label} / ${formatModel(ref.model)} done (${text.length} chars, round ${round})`);
          }
          successes.push({ model: ref.model, name: ref.model.name, label: ref.label, text });
          if (dumpDir) {
            dumpRefOutput(dumpDir, successes.length - 1, ref.label, ref.model.name, text, round);
          }
        } else {
          const msg = result.error ?? 'unknown error';
          const shortMsg = msg.length > 150 ? msg.substring(0, 150) + '...' : msg;
          if (refDisplayMode === 'verbose') {
            stream.markdown(`**Ref [${ref.label} / ${formatModel(ref.model)} (round ${round})]**: [skipped] ${shortMsg}\n\n---\n\n`);
          } else {
            stream.progress(`Ref ${ref.label} / ${formatModel(ref.model)} FAILED (round ${round}): ${shortMsg}`);
            refChannel?.appendLine(`--- Ref ${ref.label} / ${formatModel(ref.model)} [FAILED round ${round}] ---`);
            refChannel?.appendLine(msg);
            refChannel?.appendLine('');
          }
          failures.push({ name: `${ref.label}/${ref.model.name}`, msg });
        }
      }
    }

    // ── v0.14.14: 老 Phase 1 串行循环体已移除 ──
    // 原来 `for (const ref of probePool) { await ref.model.sendRequest(...) }` 的
    // prompt 构造 + sendRequest + 错误处理 整段 (~115 行) 被上方的
    // parallelRefs 分支 (Promise.allSettled) 和串行 fallback 分支替代。
    // Ref prompt 构造下沉到 buildRefPromptBody()，执行下沉到 runSingleRef()。

    // Surface OutputChannel so user can inspect ref detail (best-effort).
    if (refDisplayMode === 'thinking' && refChannel && (successes.length > 0 || failures.length > 0)) {
      refChannel.appendLine(`=== Round ${round} summary: ${successes.length} ok / ${failures.length} failed ===`);
      refChannel.show(true);
    }

    // All refs failed — degrade (same as v0.8.0).
    if (successes.length === 0) {
      stream.markdown(
        `**[MoA degraded]** All ${failures.length} configured ref(s) failed in round ${round}. ` +
          `This usually means expired/invalid subscriptions or unsupported models.\n\n` +
          `**Troubleshooting**:\n` +
          `- Run "Moa: Configure Models" to pick working models\n` +
          `- Failed: ${failures.map((f) => f.name).join(', ')}\n\n`
      );
      return {
        output: '[all refs failed]',
        elapsed: (Date.now() - start) / 1000,
        path: 'P1-degraded',
      };
    }

    // ── Phase 1.5: Sufficiency gate ────────────────────────────────────
    // Skip on last round or when recon disabled — just proceed.
    // v0.12.5: Also skip when reconBroken — no point looping back if recon
    // is disabled (refs would just keep saying "need more info" forever).
    if (!canRecon || round >= effectiveMaxRounds || reconBroken) {
      stream.progress(
        canRecon
          ? (reconBroken
              ? `[MoA] Phase 1.5: recon broken — single-round ref fan-out, proceeding to aggregator`
              : `[MoA] Phase 1.5: max rounds (${effectiveMaxRounds}) reached — proceeding with current ref outputs`)
          : `[MoA] recon disabled — single-round ref fan-out, proceeding`
      );
      break;
    }

    const parsedResults = successes.map((s) => ({
      ref: s,
      parsed: parseRefOutput(s.text),
    }));
    const sufficientCount = parsedResults.filter((r) => r.parsed.sufficient).length;
    const majoritySufficient = sufficientCount * 2 >= parsedResults.length;

    if (refChannel) {
      refChannel.appendLine(
        `--- Phase 1.5 (round ${round}): sufficiency ${sufficientCount}/${parsedResults.length} ` +
        `(${majoritySufficient ? 'PROCEED' : 'LOOP BACK'}) ---`
      );
      const allMissing = parsedResults.flatMap((r) => r.parsed.missing);
      if (allMissing.length > 0) {
        refChannel.appendLine(`Missing hints collected: ${Array.from(new Set(allMissing)).join('; ')}`);
      }
      refChannel.appendLine('');
    }

    if (majoritySufficient) {
      stream.progress(
        `[MoA] Phase 1.5: ${sufficientCount}/${parsedResults.length} refs sufficient — proceeding to aggregator`
      );
      break;
    }

    // Collect missing hints for next recon round (dedupe + cap at 10).
    const allMissing = parsedResults.flatMap((r) => r.parsed.missing);
    missingHints = Array.from(new Set(allMissing)).slice(0, 10);

    stream.progress(
      `[MoA] Phase 1.5: only ${sufficientCount}/${parsedResults.length} refs sufficient, ` +
      `${missingHints.length} hint(s) collected — looping back to recon (round ${round + 1})`
    );
  }  // end sufficiencyLoop

  stream.progress(
    `[MoA] recon rounds used: ${reconRoundsUsed}/${effectiveMaxRounds} ` +
    `(recon ${enableRecon ? 'enabled' : 'disabled'})`
  );
  stream.progress(
    `[MoA] aggregator: ${formatModel(aggregator)} (using ${successes.length}/${successes.length + failures.length} successful refs)`
  );

  // ─────────────────────────────────────────────────────────────────────────
  // v0.9.1: forceDirect mode — skip aggregator, go straight to acting agent.
  //
  // When the user has had repeated multi-model consultation failures (e.g.
  // all refs fail, or aggregator is dead), this gives a working single-model
  // path: acting agent gets user prompt + workspace context + tools, no MoA.
  // The acting agent still gets full tool access and the same iteration cap.
  // ─────────────────────────────────────────────────────────────────────────
  const forceDirect = config.get<boolean>('forceDirect') ?? false;
  const enableActingAgentEarly = config.get<boolean>('enableActingAgent') ?? true;
  const hasToolsFD = vscode.lm.tools.filter((t) => t.name.startsWith('copilot_')).length > 0;

  if (forceDirect && enableActingAgentEarly && hasToolsFD && toolInvocationToken) {
    stream.progress('[MoA] forceDirect=true — skipping ref/aggregator, acting directly with prompt + wsContext');
    if (refChannel) {
      refChannel.appendLine('=== forceDirect mode: skipping ref/aggregator pipeline ===');
      refChannel.appendLine('');
    }
    try {
      const directResult = await runActingAgent(
        aggregator,
        '(forceDirect mode: no aggregator guidance)',
        prompt,
        toolInvocationToken,
        stream,
        token
      );
      if (directResult.output.trim().length > 0) {
        return {
          output: directResult.output,
          elapsed: (Date.now() - start) / 1000,
          path: 'P1',
        };
      }
      // Empty output — fall through to normal pipeline below.
      stream.progress('[MoA] forceDirect produced empty output — falling through to normal pipeline');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      stream.progress(`[MoA] forceDirect FAILED: ${msg.substring(0, 120)} — falling through to normal pipeline`);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Aggregator prompt (Hermes `aggregate_moa_context` synth_prompt, adapted).
  // Source: https://github.com/NousResearch/hermes-agent/blob/main/agent/moa_loop.py
  //
  // Adapted for VSCode's 2-layer @moa: in Hermes, the aggregator produces
  // "guidance for the acting agent". In VSCode, @moa IS the terminal, so the
  // aggregator's output is the final user-facing answer. We keep Hermes's
  // emphasis on next steps, tool-use strategy, risks, and disagreements, but
  // frame it as a direct response (not "context for another agent").
  //
  // v0.9.0: Each ref's `text` may now be JSON-wrapped
  // {sufficient, missing, analysis}. We extract the `analysis` field via
  // parseRefOutput so the aggregator sees clean prose, not JSON scaffolding.
  // If parsing fails, the raw text is used (graceful degradation).
  //
  // Reference outputs are joined using Hermes's exact format:
  //   "Reference {idx} — {label}:\n{analysis}"
  // ─────────────────────────────────────────────────────────────────────────
  const joined = successes
    .map((r, i) => {
      const parsed = parseRefOutput(r.text);
      const body = parsed.parseFailed ? r.text : parsed.analysis;
      const missingNote = parsed.missing.length > 0
        ? `\n\n*(ref flagged missing info: ${parsed.missing.join('; ')}) *`
        : '';
      return `Reference ${i + 1} — ${r.label} (${r.name}):${missingNote}\n${body}`;
    })
    .join('\n\n');

  const aggMessages: vscode.LanguageModelChatMessage[] = [
    vscode.LanguageModelChatMessage.User(
      [
        'You are the aggregator in a Mixture of Agents process. Synthesize the reference responses below into a single coherent, actionable response to the user.',
        '',
        'Focus on:',
        '- The most accurate and complete answer to the user\'s question',
        '- Concrete next steps or recommendations (when applicable)',
        '- Key disagreements between the references, if any, and how to resolve them',
        '- Risks, pitfalls, or caveats the user should know about',
        '',
        'Do NOT simply list or quote each reference. Produce a unified response that preserves the strongest points from each advisor and resolves conflicts explicitly. Write in Markdown.',
        '',
        'Match the language of the user\'s question (Chinese question → answer in Chinese, English question → answer in English).',
        '',
        '=== OUTPUT DEPTH (agent judgment) ===',
        'Calibrate your synthesis depth to the question type:',
        '',
        '- RESEARCH/LITERATURE questions (reviews, mechanism analysis, "what is X"):',
        '  Produce a COMPREHENSIVE synthesis that preserves the richness of the refs.',
        '  When refs collectively offer 50K+ chars of grounded analysis, compressing',
        '  to a 2-paragraph brief DESTROYS value. Unpack the depth, preserve citations,',
        '  structure with ## subheadings for each dimension.',
        '',
        '- NARROW CODE questions: be concise and surgical.',
        '',
        '- Preserve specific citations, gene names, pathways, numbers from refs.',
        '- Do NOT over-summarize — the user asked a rich question and refs gave rich answers.',
        '- If refs disagree on a point, address the disagreement explicitly with reasoning.',
        '- Use Markdown headings (## / ###), tables, and lists where they add clarity.',
        '',
        '=== ORIGINAL USER QUESTION ===',
        prompt,
        '',
        '=== REFERENCE RESPONSES ===',
        joined,
      ].join('\n')
    ),
  ];

  let aggregated = '';
  try {
    // v0.14.9: 不显式设置 maxOutputTokens，靠 prompt 引导输出深度
    const aggResponse = await aggregator.sendRequest(aggMessages, {}, token);
    for await (const frag of aggResponse.text) {
      aggregated += frag;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Aggregator failed — fall back to first ref verbatim as guidance.
    aggregated = `(aggregator failed: ${msg})\n\nFallback guidance from first advisor:\n${successes[0].text}`;
  }

  // v0.14.3: 落盘 aggregator 输出
  if (dumpDir) {
    dumpAggregator(dumpDir, aggregated);
    dumpMetaState.refCount = successes.length;
  }

  // Write aggregated guidance to OutputChannel (for transparency) — it is
  // NOT shown directly in chat in v0.8.0 because it's now guidance for the
  // acting agent, not the final user-facing answer.
  if (refChannel) {
    refChannel.appendLine('--- Aggregator guidance (input to acting agent) ---');
    refChannel.appendLine(aggregated);
    refChannel.appendLine('');
  }

  // ─────────────────────────────────────────────────────────────────────────
  // v0.8.0: Layer 3 — Acting Agent (tool-calling loop).
  //
  // The aggregator's output is now GUIDANCE for the acting agent, not the
  // final answer. The acting agent:
  //   1. Reads the guidance + user prompt
  //   2. Decides whether to call tools (read_file, apply_patch, run_in_terminal, etc.)
  //   3. Multi-turn loop: execute tools, integrate results, continue
  //   4. Produces the FINAL user-facing Markdown answer
  //
  // Set `moa.enableActingAgent: false` to keep the v0.7.x 2-layer behavior
  // (aggregator output IS the final answer).
  // ─────────────────────────────────────────────────────────────────────────
  const enableActingAgent = config.get<boolean>('enableActingAgent') ?? true;
  const hasTools = vscode.lm.tools.filter((t) => t.name.startsWith('copilot_')).length > 0;

  let finalOutput = aggregated;
  let actingPath: MoaPath = successes.length >= 2 ? 'P1' : 'P1-partial';

  if (enableActingAgent && hasTools && toolInvocationToken) {
    stream.progress('[MoA] acting agent starting (with tools)...');

    // v0.9.1 defensive: multi-level retry/fallback for acting agent crashes.
    // Cascade: try once → if 1213/prompt-error, retry once → if still fails,
    // fall back to aggregator output. Acting crashes are often transient
    // (GCMP vscode.lm 1213 = empty prompt on second iteration).
    let actingResult: Awaited<ReturnType<typeof runActingAgent>> | null = null;
    let lastError: Error | null = null;
    const MAX_ACTING_ATTEMPTS = 2;

    for (let attempt = 1; attempt <= MAX_ACTING_ATTEMPTS; attempt++) {
      try {
        actingResult = await runActingAgent(
          aggregator,
          aggregated,
          prompt,
          toolInvocationToken,
          stream,
          token
        );
        // Success — break retry loop.
        break;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        lastError = err instanceof Error ? err : new Error(msg);
        stream.progress(
          `[MoA] acting attempt ${attempt}/${MAX_ACTING_ATTEMPTS} FAILED: ` +
          `${msg.substring(0, 120)}` +
          (attempt < MAX_ACTING_ATTEMPTS ? ' — retrying...' : ' — falling back to aggregator')
        );
        if (refChannel) {
          refChannel.appendLine(`--- Acting attempt ${attempt} CRASHED ---`);
          refChannel.appendLine(msg);
          refChannel.appendLine('');
        }
        // If this is a "no prompt received" type error (1213), backoff briefly.
        if (msg.includes('1213') || msg.includes('prompt') || msg.includes('400')) {
          await new Promise((r) => setTimeout(r, 500));
        }
      }
    }

    if (actingResult) {
      finalOutput = actingResult.output;
      actingPath = 'P1';
      stream.progress(
        `[MoA] acting done: ${actingResult.iterations} iterations, ` +
        `${actingResult.toolCallsSucceeded} tool call(s) ok, ` +
        `${actingResult.toolCallsFailed} failed` +
        (actingResult.hitIterationCap ? ' [hit cap]' : '')
      );
      // v0.9.1 defensive: if acting produced nothing (empty output due to
      // crash mid-iteration), fall back to aggregator output rather than
      // showing an empty/broken response.
      if (finalOutput.trim().length === 0) {
        stream.progress('[MoA] acting produced empty output — falling back to aggregator guidance');
        finalOutput = aggregated;
        actingPath = 'P1-partial';
      }
    } else {
      // All attempts failed — graceful fallback to aggregator output.
      const errMsg = lastError?.message ?? 'unknown error';
      stream.markdown(
        `\n\n**[Acting agent crashed after ${MAX_ACTING_ATTEMPTS} attempts]**:` +
        ` ${errMsg.substring(0, 200)}\n\n---\n\n` +
        `**Showing aggregator guidance instead**:\n\n${aggregated}`
      );
      finalOutput = aggregated;
      actingPath = 'P1-partial';
    }
  } else {
    // Acting agent disabled (or no tools / no token) — v0.7.x 2-layer behavior.
    // Aggregator output IS the final answer; show it directly.
    if (!enableActingAgent) {
      stream.progress('[MoA] acting agent disabled (moa.enableActingAgent=false) — showing aggregator output directly');
    } else if (!hasTools) {
      stream.progress('[MoA] no copilot_* tools available — showing aggregator output directly');
    } else if (!toolInvocationToken) {
      stream.progress('[MoA] no toolInvocationToken — showing aggregator output directly');
    }
    stream.markdown(aggregated);
  }

  // v0.14.3: 落盘 final + 完成 meta
  if (dumpDir) {
    dumpFinal(dumpDir, finalOutput);
    dumpMetaState.finishedAt = new Date().toISOString();
    dumpMeta(dumpDir, dumpMetaState);
  }

  return {
    output: finalOutput,
    elapsed: (Date.now() - start) / 1000,
    path: actingPath,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// v0.14.14: Ref fan-out helpers (并行/串行统一调用)
//
// 把原来散在 for 循环里的两块逻辑抽出来：
//   1. buildRefPromptBody: 构造所有 ref 共用的 prompt body（equal-mode MoA）
//   2. runSingleRef: 单个 ref 的 sendRequest + 流式收集 + 错误捕获
//
// 这样并行路径 (Promise.allSettled) 和串行路径 (for-await) 可以复用同一份代码，
// 避免逻辑分叉。runSingleRef 永不 throw —— 所有错误都捕获后返回 { ok: false }。
// ─────────────────────────────────────────────────────────────────────────

/**
 * Build the ref prompt body shared by all refs (equal-mode MoA).
 *
 * Extracted from the original inline for-loop body in v0.14.14 to enable
 * parallel fan-out: the prompt is identical for all refs, so we build it
 * once and pass to each runSingleRef call.
 *
 * Layout:
 *   - sharedRefPrompt (system prompt)
 *   - RECON DATA block (if reconSummary non-empty)
 *   - USER QUESTION
 *   - OUTPUT FORMAT (JSON schema with sufficient/missing/analysis)
 *   - OUTPUT DEPTH guidance
 */
function buildRefPromptBody(
  sharedRefPrompt: string,
  reconSummary: string,
  userPrompt: string
): string {
  const parts: string[] = [sharedRefPrompt, ''];

  if (reconSummary) {
    parts.push(
      '=== RECON DATA (collected by recon agent) ===',
      'Below is the raw context collected by the recon agent. Use it to give grounded analysis. If you need MORE information (specific files, symbols, or context) that wasn\'t collected, indicate so in your JSON output.',
      '',
      reconSummary,
      ''
    );
  } else {
    parts.push(
      '=== RECON DATA ===',
      '(no recon data yet — reason about the question abstractly,',
      ' or flag specific files/info needed in the "missing" field)',
      ''
    );
  }

  parts.push('=== USER QUESTION ===', userPrompt, '');

  parts.push(
    '=== OUTPUT FORMAT (REQUIRED) ===',
    'Respond with a JSON object wrapped in ```json fences. Schema:',
    '```json',
    '{',
    '  "sufficient": true|false,',
    '  "missing": ["specific file path / symbol / info you still need", ...],',
    '  "analysis": "your full detailed analysis"',
    '}',
    '```',
    '- "sufficient": true if the recon data above is enough for grounded analysis.',
    '              false if critical information is missing (list them in "missing").',
    '- "missing": when sufficient=false, list SPECIFIC items (file paths, symbol names,',
    '            line ranges, etc.) — the recon agent will collect them in the next round.',
    '- "analysis": your full analysis. ALWAYS provide this, even if sufficient=false.',
    '             This is what the aggregator will synthesize into the final answer.',
    '',
    '=== OUTPUT DEPTH (agent judgment) ===',
    'You are an expert advisor. Calibrate your output depth to the question:',
    '',
    '- For RESEARCH/LITERATURE questions (mechanism review, multi-dimensional analysis,',
    '  "what is X", comparative synthesis): produce a COMPREHENSIVE analysis covering',
    '  every dimension the user asked about. The recon agent gathered rich context for',
    '  you — USE IT. If recon data has 50K+ chars of literature, your analysis should',
    '  proportionally unpack that richness, not compress it into a brief.',
    '',
    '- For NARROW CODE questions (specific bug, single function, quick lookup):',
    '  be CONCISE and surgical. No padding.',
    '',
    '- Judge by the question, not by a fixed length. A "review hibernation mechanisms"',
    '  question deserves 10x the depth of a "what does config.timeout do" question.',
    '',
    'Anti-patterns to AVOID on research questions:',
    '  - One-paragraph summaries when recon data has 5+ distinct aspects',
    '  - Listing paper titles without extracting their actual findings',
    '  - Hand-waving ("many factors are involved") instead of naming specific genes/',
    '    pathways/numbers from the recon data',
    '  - Stopping at 2-3 sentences per subtopic when the user asked for systematic coverage',
    '',
    'Structure with ## subheadings for each major dimension the user requested.',
    'Cite specific recon data points with [recon: ...] labels.',
    'Include your training knowledge with [training: ...] labels when it adds value.',
    'Match the language of the user\'s question.'
  );

  return parts.join('\n');
}

/**
 * Single ref execution. Never throws — all errors captured into { ok: false }.
 *
 * This is the atomic unit of ref fan-out:
 *   - Parallel mode: called by Promise.allSettled(tasks.map(runSingleRef))
 *   - Sequential mode: called inside a for-await loop
 *
 * The caller is responsible for:
 *   - Displaying the result (stream.markdown or refChannel.appendLine)
 *   - Pushing to successes/failures arrays
 *   - Dumping to disk (dumpRefOutput)
 *
 * Cancellation: respects token.isCancellationRequested at the sendRequest level
 * (vscode.lm propagates cancellation into the model call).
 */
async function runSingleRef(
  ref: { model: vscode.LanguageModelChat; label: string },
  promptBody: string,
  round: number,
  token: vscode.CancellationToken
): Promise<
  | { ok: true; text: string }
  | { ok: false; error: string }
> {
  const refPrompts: vscode.LanguageModelChatMessage[] = [
    vscode.LanguageModelChatMessage.User(promptBody),
  ];

  // v0.14.9: 不显式设置 maxOutputTokens（避免 provider 兼容性问题）。
  // 改为通过 prompt agent 化引导 LLM 自己判断输出深度。
  try {
    const response = await ref.model.sendRequest(refPrompts, {}, token);
    let text = '';
    for await (const frag of response.text) {
      text += frag;
    }
    return { ok: true, text };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
}

// ─────────────────────────────────────────────────────────────────────────
// v0.9.0: Phase 0 (Recon) + Phase 1.5 (Sufficiency gate) helpers.
// ─────────────────────────────────────────────────────────────────────────

/**
 * v0.9.0 hotfix1: Parse a single ref "missing" hint into a structured form
 * suitable for prefetching. Supports three hint shapes:
 *
 *   1. "src/foo.ts"                → { filePath: "src/foo.ts", lineRange: undefined }
 *   2. "src/foo.ts:120-150"        → { filePath: "src/foo.ts", lineRange: [120, 150] }
 *   3. "src/foo.ts:120"            → { filePath: "src/foo.ts", lineRange: [120, undefined] } (single line)
 *   4. "funcName" or "ClassName"   → { filePath: undefined, lineRange: undefined, query: "funcName" }
 *
 * Anything not matching 1-4 is treated as a search query (shape 4).
 *
 * Best-effort: returns `null` if the hint is empty/whitespace.
 */
function parseMissingHint(hint: string): {
  filePath?: string;
  lineRange?: [number, number | undefined];
  query?: string;
} | null {
  const trimmed = hint.trim();
  if (!trimmed) return null;

  // Pattern: path:line-line or path:line (any extension)
  const rangeMatch = trimmed.match(/^(.+\.\w+):(\d+)(?:-(\d+))?$/);
  if (rangeMatch) {
    const [, filePath, startStr, endStr] = rangeMatch;
    const start = parseInt(startStr, 10);
    const end = endStr ? parseInt(endStr, 10) : undefined;
    return { filePath, lineRange: [start, end] };
  }

  // Pattern: path only (must contain a / or . to be a path; else fall through to query)
  if (trimmed.includes('/') || /\.\w{1,5}$/.test(trimmed)) {
    return { filePath: trimmed };
  }

  // Bare identifier → search query
  return { query: trimmed };
}

/**
 * v0.9.0 hotfix1: Prefetch file contents directly from missing hints.
 *
 * Two-pass strategy (per user choice "两者结合"):
 *   1. moaRunner parses hints → for hints with explicit filePath, call
 *      vscode.lm.invokeTool('copilot_readFile', ...) directly to fetch.
 *   2. Remaining hints (query-only) are passed to the recon agent's prompt
 *      for autonomous search.
 *
 * Prefetched contents are merged into the recon summary with a clear
 * "[prefetched from hint N]" marker so refs know the provenance.
 *
 * Returns a map: hint-index (1-based) → prefetched content (string).
 */
async function prefetchFromHints(
  hints: string[],
  toolInvocationToken: vscode.ChatParticipantToolToken,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken
): Promise<Map<number, string>> {
  const prefetched = new Map<number, string>();

  for (let i = 0; i < hints.length; i++) {
    const hint = hints[i];
    const parsed = parseMissingHint(hint);
    if (!parsed || !parsed.filePath) continue;  // Skip query-only (recon handles)

    const hintNum = i + 1;
    stream.progress(`[MoA] prefetching hint ${hintNum}: ${hint}`);

    try {
      const input: Record<string, unknown> = { filePath: parsed.filePath };
      if (parsed.lineRange) {
        const [start, end] = parsed.lineRange;
        input.startLine = start;
        if (end !== undefined) input.endLine = end;
      }
      const result = await vscode.lm.invokeTool(
        'copilot_readFile',
        { input, toolInvocationToken },
        token
      );
      let text = '';
      for (const c of result.content) {
        if (c instanceof vscode.LanguageModelTextPart) {
          text += c.value;
        }
      }
      prefetched.set(hintNum, text);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      stream.progress(`[MoA] prefetch hint ${hintNum} FAILED: ${msg.substring(0, 100)} — will fall back to recon`);
      // Don't set the entry — recon agent will handle this hint.
    }
  }

  return prefetched;
}

/**
 * Build a structured recon summary from captured tool calls + prefetched hints.
 *
 * v0.9.0 hotfix1: replaces the old "等量切割 1/3" strategy. Now:
 *   1. Walk prefetched hints FIRST (highest priority, exact user/ref target).
 *   2. Then walk captured tool calls from recon agent.
 *   3. For each entry, extract path from input + content from resultText.
 *   4. Concatenate as "=== <path> ===\n<content>" blocks.
 *   5. Truncate total to maxChars (default 30000) with PER-FILE cap (maxChars/3)
 *      so no single file can eat the whole budget.
 *
 * Each block is tagged with its provenance so refs can tell:
 *   [prefetched hint N] vs [recon call: toolName]
 */
/**
 * v0.13.0: 在语义边界（`}` / 空行 / 注释）处截断，避免砍断函数/类定义。
 *
 * 策略：在 [max*0.8, max] 范围内找最近的语义边界，找不到就硬切。
 *
 * @param text 原始文本
 * @param max 最大字符数
 */
function truncateAtSemanticBoundary(text: string, max: number): string {
  if (text.length <= max) return text;
  const lower = Math.floor(max * 0.8);
  const window = text.substring(lower, max);
  // 找最后一个语义边界：右大括号后换行 / 空行 / 注释起始
  const boundaries = [
    window.lastIndexOf('\n}\n'),
    window.lastIndexOf('\n}\r\n'),
    window.lastIndexOf('\n\n'),
    window.lastIndexOf('\r\n\r\n'),
    window.lastIndexOf('\n//'),
    window.lastIndexOf('\n#'),
    window.lastIndexOf('\n*'),
  ];
  const bestBoundary = Math.max(...boundaries);
  const cut = bestBoundary > 0 ? lower + bestBoundary : max;
  return text.substring(0, cut) + '\n... (truncated at semantic boundary)';
}

/**
 * v0.13.0: 三层截断策略
 *   L1: 内容 < smallThreshold（默认 5KB）→ 直接保留
 *   L2: 内容在 [smallThreshold, l3Threshold]（默认 [5KB, 30KB]）→ 语义边界截断
 *   L3: 内容 > l3Threshold 且为代码文件 → 调用 M3 孙代理精选
 *
 * @param captured recon 捕获的工具调用
 * @param prefetched 主会话预取的文件内容
 * @param prefetchedHints 与 prefetched 对应的 hint 描述
 * @param maxChars 总字符预算（默认 30000）
 * @param userPrompt 用户原始问题（L3 需要）
 * @param toolInvocationToken 工具调用 token（L3 需要）
 */
async function extractReconSummary(
  captured: CapturedToolCall[],
  prefetched: Map<number, string>,
  prefetchedHints: string[],
  maxChars: number,
  userPrompt: string,
  toolInvocationToken?: vscode.ChatParticipantToolToken
): Promise<string> {
  if (captured.length === 0 && prefetched.size === 0) return '(no recon data captured)';

  // v0.14.5: 完全无上限 —— maxChars 参数保留但仅用于审计/meta，不再做任何截断。
  //
  // 设计哲学：
  //   - refs 单轮无历史 + 1M 上下文模型，即使 5MB 内容也能消化
  //   - 如果 recon 收集到的内容真的"过大"，那说明检索方向出问题（噪声过多）
  //     —— 这是 LLM 应该从内容本身判断并处理的，不是工程层强行截断
  //   - 截断会丢掉关键信息，比"内容多"的代价大得多
  //
  // L3 孙代理仍然保留（默认 200k 触发），但那是"精选"而非"截断" ——
  // L3 把巨型文件的完整内容用 LLM 智能压缩成关键片段，质量远高于硬切。
  const config = vscode.workspace.getConfiguration('moa');
  const l3Threshold = config.get<number>('reconL3Threshold') ?? 200000;
  const l3MaxCalls = config.get<number>('reconL3MaxCalls') ?? 5;

  // v0.14.0: 检查 L3 是否被禁用（activePreset.l3Summarizer.model 为空 = 禁用）
  // v0.14.14: 改为读 activePreset.l3Summarizer（不再直接 config.get）
  // 本函数是独立 helper（不在 runP1Fanout 作用域内），需要自己解析 preset。
  // preset 为空时（未配置）默认 l3Disabled=true，安全降级。
  const _presetForL3 = getActivePresetConfig();
  const l3Cfg = _presetForL3.isEmpty ? { model: '' } : _presetForL3.l3Summarizer;
  const l3Disabled = !l3Cfg?.model || l3Cfg.model.trim().length === 0;

  let l3CallsUsed = 0;
  const blocks: string[] = [];
  let total = 0;  // 仅用于审计统计

  /**
   * v0.14.5: 加入一个 block，**永不截断**。
   * total 仅用于审计统计（写入 meta.json），不影响逻辑。
   */
  function addBlock(header: string, content: string): void {
    const block = `${header}\n${content}`;
    blocks.push(block);
    total += block.length + 2;
  }

  // 1. Prefetched hints (highest priority).
  for (const [hintNum, content] of prefetched.entries()) {
    const hintText = prefetchedHints[hintNum - 1] ?? `hint ${hintNum}`;
    addBlock(`=== [prefetched hint ${hintNum}: ${hintText}] ===`, content);
  }

  // 2. Captured tool calls.
  for (const call of captured) {
    // 尝试从工具 input 中提取路径（用于 L3 触发判断）
    let pathHint = '';
    if (call.input && typeof call.input === 'object') {
      const inp = call.input as Record<string, unknown>;
      const candidate =
        inp.filePath || inp.path || inp.file || inp.fileName ||
        inp.includePattern || inp.query || inp.pattern || inp.symbol || '';
      if (typeof candidate === 'string') {
        pathHint = candidate;
      }
    }

    const header = pathHint
      ? `=== [recon: ${call.name}: ${pathHint}] ===`
      : `=== [recon: ${call.name}] ===`;

    // v0.14.5: 只有"超大代码文件"才走 L3 精选，其余原样保留
    let contentForBlock: string;
    const contentLen = call.resultText.length;

    // L3 触发条件（全部满足）：
    //   1. 内容超过 l3Threshold（默认 200k —— 真正的大文件）
    //   2. 是代码文件（shouldTriggerL3 检查扩展名）
    //   3. L3 未被禁用
    //   4. 未达 l3MaxCalls 上限
    //   5. 有 pathHint（L3 需要文件路径做缓存 key）
    const shouldL3 = !l3Disabled && pathHint &&
      contentLen >= l3Threshold &&
      shouldTriggerL3(pathHint, contentLen, l3Threshold) &&
      l3CallsUsed < l3MaxCalls;

    if (shouldL3) {
      // 派 L3 孙代理精选（智能压缩，保留关键函数）
      try {
        const { l3Summarize } = await import('./l3Summarizer');
        const l3Result = await l3Summarize({
          filePath: pathHint,
          fullContent: call.resultText,
          userPrompt,
          toolInvocationToken,
        });
        if (l3Result) {
          l3CallsUsed++;
          contentForBlock = `${l3Result.summary}\n\n<!-- L3 source: ${l3Result.source}, ${l3Result.elapsedMs}ms, cached=${l3Result.fromCache} -->`;
        } else {
          // L3 失败 → 原样保留
          contentForBlock = call.resultText;
        }
      } catch {
        // L3 异常 → 原样保留
        contentForBlock = call.resultText;
      }
    } else {
      // 默认路径：原样保留
      contentForBlock = call.resultText;
    }

    addBlock(header, contentForBlock);
  }

  return blocks.join('\n\n');
}

/** Regular expression for extracting JSON from ref responses. */
const REF_JSON_REGEX = /\{[\s\S]*?"sufficient"[\s\S]*?"analysis"[\s\S]*?\}/;

/**
 * Parsed ref JSON output. Refs are instructed to output:
 *   { "sufficient": true|false, "missing": [string, ...], "analysis": string }
 *
 * If JSON parsing fails, we treat it as sufficient=true with the raw text
 * as analysis (graceful degradation — don't block the pipeline on malformed JSON).
 */
interface RefParsed {
  sufficient: boolean;
  missing: string[];
  analysis: string;
  /** True if JSON parsing failed (we used the fallback). */
  parseFailed: boolean;
}

/**
 * Parse a ref's response into structured form.
 *
 * Refs may wrap JSON in markdown code fences or prefix it with prose. We use
 * a permissive regex to find the JSON object containing the required keys.
 * If no JSON is found, the entire text is treated as `analysis` with
 * `sufficient=true` (assume enough info; let aggregator judge).
 */
function parseRefOutput(text: string): RefParsed {
  // Strip markdown code fences if present.
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const jsonCandidate = fenceMatch ? fenceMatch[1] : text;

  const jsonMatch = jsonCandidate.match(REF_JSON_REGEX);
  if (!jsonMatch) {
    return {
      sufficient: true,
      missing: [],
      analysis: text,
      parseFailed: true,
    };
  }

  try {
    const obj = JSON.parse(jsonMatch[0]);
    return {
      sufficient: Boolean(obj.sufficient),
      missing: Array.isArray(obj.missing) ? obj.missing.map(String) : [],
      analysis: typeof obj.analysis === 'string' ? obj.analysis : text,
      parseFailed: false,
    };
  } catch {
    return {
      sufficient: true,
      missing: [],
      analysis: text,
      parseFailed: true,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────
// v0.14.3: Recon 落盘机制
//
// 目的：
//   1. 完整 recon 成果留档（debug / audit / replay）
//   2. 每个 capturedToolCall 独立保存（便于后续优化处理）
//   3. ref 输出与 aggregator 输出落盘（端到端 trace）
//   4. acting agent 可读取完整内容做后续工具调用
//
// 目录结构（每个 MoA 任务一个 sha1 目录）：
//   <workspace>/.moa_cache/recon/<sha1>/
//     meta.json                  # 任务元信息
//     00_full_recon.md           # 注入 refs 的完整 recon summary
//     01_captured/               # recon agent 的每个工具调用
//       001_<toolname>.md
//       002_<toolname>.md
//     02_ref_outputs/            # 每个 ref 的输出
//       ref1_<label>.md
//     03_aggregator.md           # aggregator 输出
//     04_final.md                # 最终输出
// ─────────────────────────────────────────────────────────────────────────

interface ReconDumpMeta {
  taskSha: string;
  prompt: string;
  startedAt: string;
  finishedAt?: string;
  reconRoundsUsed: number;
  refCount: number;
  totalChars: number;
}

/**
 * 计算 recon dump 的 SHA1（基于 prompt + 启动时间秒级）。
 * 同一秒内同 prompt 视为同一任务（极端情况再叠加随机后缀）。
 */
function computeTaskSha(prompt: string, startedAt: Date): string {
  const crypto = require('crypto');
  const hash = crypto.createHash('sha1');
  hash.update(prompt);
  hash.update('|');
  hash.update(startedAt.toISOString().substring(0, 19));  // 秒级
  return hash.digest('hex').substring(0, 12);
}

/**
 * 取得 recon dump 目录路径。如果 workspace 不可用，返回 null（不落盘）。
 *
 * v0.14.10: 创建 .moa_cache/ 时顺便写入 README.md（仅首次，已存在不覆盖）。
 */
function getReconDumpDir(taskSha: string): string | null {
  const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!ws) return null;
  const cacheRoot = path.join(ws, '.moa_cache');
  const dir = path.join(cacheRoot, 'recon', taskSha);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(path.join(dir, '01_captured'), { recursive: true });
    fs.mkdirSync(path.join(dir, '02_ref_outputs'), { recursive: true });
    // v0.14.10: 首次创建 .moa_cache/ 时同步写入 README
    try {
      const { ensureCacheReadme } = require('./cacheReadme');
      ensureCacheReadme(cacheRoot);
    } catch {
      // 模块加载失败不阻塞主流程
    }
  }
  return dir;
}

/**
 * 安全写文件（best-effort，失败不影响主流程）。
 */
function safeWrite(filePath: string, content: string): void {
  try {
    fs.writeFileSync(filePath, content, 'utf8');
  } catch (err) {
    console.warn(`[MoA recon dump] failed to write ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Dump 一个 capturedToolCall 到独立 md 文件。
 * 文件名格式：NNN_<toolname>.md（NNN = 3 位序号）
 *
 * v0.14.6: 增加 part 元数据 dump，便于诊断工具返回的 part 类型分布。
 * 特别是对 copilot_fetchWebPage 这类返回非 TextPart 富文本的工具，
 * partDiagnostics 能直接显示 "5 个 PromptTSXPart，共 32000 字符，全部从
 * recursive-text 提取" 之类的信息。
 */
function dumpCapturedToolCall(
  dumpDir: string,
  index: number,
  call: CapturedToolCall
): void {
  const safeToolName = call.name.replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 40);
  const fileName = `${String(index + 1).padStart(3, '0')}_${safeToolName}.md`;
  const filePath = path.join(dumpDir, '01_captured', fileName);

  const inputStr = typeof call.input === 'string'
    ? call.input
    : (() => { try { return JSON.stringify(call.input, null, 2); } catch { return String(call.input); } })();

  const sections = [
    `# Captured Tool Call ${index + 1}: ${call.name}`,
    '',
    '## Input',
    '```json',
    inputStr,
    '```',
    '',
    `## Result (${call.resultText.length} chars)`,
    call.resultText,
  ];

  // v0.14.6: 追加 part 元数据诊断
  if (call.partDiagnostics && call.partDiagnostics.length > 0) {
    sections.push(
      '',
      '## Part Diagnostics',
      '',
      '| # | kind | source | length |',
      '|---|------|--------|--------|',
    );
    call.partDiagnostics.forEach((p, i) => {
      sections.push(`| ${i + 1} | ${p.kind} | ${p.source} | ${p.length} |`);
    });
    const totalExtracted = call.partDiagnostics.reduce((s, p) => s + p.length, 0);
    const nonTextParts = call.partDiagnostics.filter((p) => p.kind !== 'TextPart').length;
    sections.push(
      '',
      `**Summary**: ${call.partDiagnostics.length} part(s), ${nonTextParts} non-TextPart, ` +
      `${totalExtracted} chars extracted (resultText=${call.resultText.length}).`,
    );
  }

  safeWrite(filePath, sections.join('\n'));
}

/**
 * Dump 完整的 recon summary（注入 refs 的内容）。
 */
function dumpFullRecon(dumpDir: string, reconSummary: string): void {
  safeWrite(path.join(dumpDir, '00_full_recon.md'), reconSummary);
}

/**
 * Dump 一个 ref 的输出。
 */
function dumpRefOutput(
  dumpDir: string,
  index: number,
  label: string,
  modelName: string,
  text: string,
  round: number
): void {
  const safeLabel = label.replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 30);
  const safeModel = modelName.replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 30);
  const fileName = `ref${index + 1}_${safeLabel}_${safeModel}_r${round}.md`;
  const content = [
    `# Ref ${index + 1}: ${label} / ${modelName} (round ${round})`,
    '',
    text,
  ].join('\n');
  safeWrite(path.join(dumpDir, '02_ref_outputs', fileName), content);
}

/**
 * Dump aggregator 与 final 输出。
 */
function dumpAggregator(dumpDir: string, aggregated: string): void {
  safeWrite(path.join(dumpDir, '03_aggregator.md'), aggregated);
}

function dumpFinal(dumpDir: string, finalOutput: string): void {
  safeWrite(path.join(dumpDir, '04_final.md'), finalOutput);
}

/**
 * Dump 任务元信息（最后调用，会更新 finishedAt）。
 */
function dumpMeta(dumpDir: string, meta: ReconDumpMeta): void {
  safeWrite(path.join(dumpDir, 'meta.json'), JSON.stringify(meta, null, 2));
}

