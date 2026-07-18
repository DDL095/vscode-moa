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
import type { MoaPath, MoaRunResult, RefModelConfig } from './types';
import { buildWorkspaceContext } from './workspaceContext';
import { runActingAgent, runReconAgent } from './actingAgent';
import type { CapturedToolCall } from './actingAgent';
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
  const refModelsCfg: RefModelConfig[] = config.get<RefModelConfig[]>('refModels') ?? [];

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
  // Built-in reference advisor system prompt (Hermes `_REFERENCE_SYSTEM_PROMPT`).
  // Source: https://github.com/NousResearch/hermes-agent/blob/main/agent/moa_loop.py
  //
  // All refs share this SAME system prompt (equal-mode MoA). Diversity comes
  // from the underlying model differences (GLM vs DeepSeek vs MiniMax), NOT
  // from role assignment. The prompt reframes each ref as an advisory analyst
  // that produces private guidance for the aggregator — not a final user-facing
  // answer. This avoids the failure mode where refs refuse ("I can't access
  // tools/files") or try to call tools they don't have.
  //
  // The trailing "Match the language of the user's question" line ensures refs
  // follow the user's language (Chinese question → Chinese advice).
  // ─────────────────────────────────────────────────────────────────────────
  const SHARED_REF_PROMPT_DEFAULT = [
    'You are a reference advisor in a Mixture of Agents (MoA) process. You are NOT the acting agent and you do NOT execute anything: you cannot call tools, run commands, browse, or access files, repositories, or URLs, and you should not try to or apologize for being unable to. A separate aggregator model will synthesize your advice with other advisors and produce the final response.',
    '',
    'v0.12.5 ARCHITECTURE: You are a PURE REASONING LAYER. You see ONLY:',
    '  - This system prompt',
    '  - The RECON DATA block (collected by a separate recon agent)',
    '  - The user question',
    'You do NOT see the workspace, open files, or project tree. The recon agent',
    'has already decided what information is relevant — your job is to reason',
    'about THAT information, not request more.',
    '',
    'Your job is to give your most intelligent analysis of the user\'s question: understand the goal, reason about the problem, and advise on what the answer should be. Surface the best approach, concrete reasoning, likely pitfalls and risks, and anything that might be missed or gotten wrong. Assume any referenced files, URLs, or systems exist and reason about them from the context given rather than asking for access.',
    '',
    'If the RECON DATA block is empty or insufficient for grounded analysis:',
    '  - For research/conceptual questions: reason abstractly, no "missing" needed.',
    '  - For code-specific questions: list SPECIFIC files/symbols/ranges you need',
    '    in the "missing" field. The recon agent will collect them next round.',
    '',
    'Respond with your advice directly — no preamble, no disclaimers about tools or access. Your response is private guidance handed to the aggregator, not an answer shown to the user.',
    '',
    'Match the language of the user\'s question (Chinese question → answer in Chinese, English question → answer in English).',
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
  const refChannel = refDisplayMode === 'thinking' ? createOutputChannel() : undefined;
  if (refChannel) {
    refChannel.appendLine(`=== @moa request @ ${new Date().toISOString()} ===`);
    refChannel.appendLine(`Prompt: ${prompt}`);
    refChannel.appendLine(`Mode: ${refDisplayMode}, Refs: ${probePool.length}`);
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
  // ─────────────────────────────────────────────────────────────────────────
  const aggCfg = config.get<{ model?: string; temperature?: number }>('aggregator');
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
  //
  // 设计：
  //   - 读 moa.reconModel.model（vscode.lm m.id）
  //   - 空字符串 / 未配置 → 复用 aggregator（保持 v0.13.x 行为）
  //   - 配置了 → 用对应模型（用于"aggregator 用 GLM-5.2，recon 用 DeepSeek" 等场景）
  //
  // 决策顺序：精确 id 匹配 → name 子串 → fallback 到 aggregator
  // ─────────────────────────────────────────────────────────────────────────
  const reconCfg = config.get<{ model?: string; temperature?: number }>('reconModel');
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
  const reconContextChars = Math.max(5000, config.get<number>('reconContextChars') ?? 30000);
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
  if (callerReconContext && callerReconContext.trim().length > 0) {
    reconSummary = callerReconContext.length > reconContextChars
      ? callerReconContext.substring(0, reconContextChars) + '\n... (truncated)'
      : callerReconContext;
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

      try {
        // v0.14.0: recon 用独立的 reconModel（fallback 到 aggregator）
        const recon = await runReconAgent(
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
        const newReconSummary = await extractReconSummary(
          recon.raw.capturedToolCalls,
          prefetched,
          missingHints ?? [],
          reconContextChars,
          prompt,
          toolInvocationToken
        );

        // v0.9.1 defensive: If recon produced nothing useful, fall back
        // gracefully. "Useful" = at least one tool succeeded OR a prefetch
        // got content. Otherwise we'd be wasting ref tokens on empty context.
        const reconWasUseful =
          recon.raw.toolCallsSucceeded > 0 || prefetched.size > 0;
        if (newReconSummary.trim() === '(no recon data captured)' || !reconWasUseful) {
          stream.progress(
            `[MoA] Phase 0: recon round ${round} produced no usable content ` +
            `(${recon.raw.toolCallsSucceeded} ok / ${recon.raw.toolCallsFailed} failed, ` +
            `${prefetched.size} prefetched) — proceeding without recon`
          );
          if (refChannel) {
            refChannel.appendLine(`--- Recon round ${round}: NO USEFUL CONTENT — disabling further recon, refs will run without recon data ---`);
            refChannel.appendLine('');
          }
          // v0.12.5 BUGFIX: Don't break the sufficiencyLoop!
          // Previously this break skipped ref fan-out entirely.
          // Now: mark recon broken so subsequent rounds skip Phase 0,
          // but ref fan-out (Phase 1) still runs in THIS round.
          reconBroken = true;
          // Don't update reconSummary (keep empty); refs will see no recon data.
          // Continue to Phase 1 below — refs reason about the question directly.
        } else {
          reconSummary = newReconSummary;
          reconRoundsUsed = round;

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
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        stream.progress(`[MoA] Phase 0: recon FAILED (${msg.substring(0, 100)}) — disabling further recon, refs will run without recon data`);
        if (refChannel) {
          refChannel.appendLine(`--- Recon round ${round} FAILED — disabling further recon, refs will still run ---`);
          refChannel.appendLine(msg);
          refChannel.appendLine('');
        }
        // v0.12.5 BUGFIX: Don't break! Mark recon broken and let ref fan-out run.
        reconBroken = true;
      }
    }

    // ── Phase 1: Ref fan-out ────────────────────────────────────────────
    // v0.12.5: refs are PURE REASONING LAYER. They see ONLY:
    //   1. sharedRefPrompt (Hermes system prompt)
    //   2. reconSummary (if any — the ONLY information source)
    //   3. user question
    // No workspace context, no active editor, no project tree.
    // If recon didn't gather enough, refs flag gaps in JSON "missing" field.
    successes.length = 0;  // Clear per-round; final round's analyses feed aggregator.

    for (const ref of probePool) {
      // v0.12.5: Removed wsContextText — refs are pure reasoning layer.
      const refPromptParts: string[] = [sharedRefPrompt, ''];
      if (reconSummary) {
        refPromptParts.push(
          '=== RECON DATA (collected by recon agent) ===',
          'Below is the raw context collected by the recon agent. Use it to give grounded analysis. If you need MORE information (specific files, symbols, or context) that wasn\'t collected, indicate so in your JSON output.',
          '',
          reconSummary,
          ''
        );
      } else {
        // No recon data — refs reason about the abstract question.
        // For research/literature tasks this is fine (no files to read).
        // For code tasks, refs will likely flag "missing" → triggers recon.
        refPromptParts.push(
          '=== RECON DATA ===',
          '(no recon data yet — reason about the question abstractly,',
          ' or flag specific files/info needed in the "missing" field)',
          ''
        );
      }
      refPromptParts.push('=== USER QUESTION ===', prompt, '');
      refPromptParts.push(
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
        '             This is what the aggregator will synthesize into the final answer.'
      );

      const refPrompts: vscode.LanguageModelChatMessage[] = [
        vscode.LanguageModelChatMessage.User(refPromptParts.join('\n')),
      ];

      if (refDisplayMode === 'thinking') {
        stream.progress(`Ref ${ref.label} / ${formatModel(ref.model)} thinking (round ${round})...`);
      }

      try {
        const response = await ref.model.sendRequest(refPrompts, {}, token);
        let text = '';
        for await (const frag of response.text) {
          text += frag;
        }
        if (refDisplayMode === 'verbose') {
          stream.markdown(`**Ref [${ref.label} / ${formatModel(ref.model)} (round ${round})]**:\n\n${text}\n\n---\n\n`);
        } else {
          refChannel?.appendLine(`--- Ref ${ref.label} / ${formatModel(ref.model)} (round ${round}) ---`);
          refChannel?.appendLine(text);
          refChannel?.appendLine('');
          stream.progress(`Ref ${ref.label} / ${formatModel(ref.model)} done (${text.length} chars, round ${round})`);
        }
        successes.push({ model: ref.model, name: ref.model.name, label: ref.label, text });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
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
    const aggResponse = await aggregator.sendRequest(aggMessages, {}, token);
    for await (const frag of aggResponse.text) {
      aggregated += frag;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Aggregator failed — fall back to first ref verbatim as guidance.
    aggregated = `(aggregator failed: ${msg})\n\nFallback guidance from first advisor:\n${successes[0].text}`;
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

  return {
    output: finalOutput,
    elapsed: (Date.now() - start) / 1000,
    path: actingPath,
  };
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

  // v0.13.0: 从配置读取 L3 阈值与单任务最大 L3 调用次数
  const config = vscode.workspace.getConfiguration('moa');
  const l3Threshold = config.get<number>('reconL3Threshold') ?? 30000;
  const l3MaxCalls = config.get<number>('reconL3MaxCalls') ?? 5;
  const smallThreshold = 5000;  // L1 阈值（小于此值不截断）

  // v0.14.0: 检查 L3 是否被禁用（moa.l3Summarizer.model 为空 = 禁用）
  const l3Cfg = config.get<{ model?: string }>('l3Summarizer');
  const l3Disabled = !l3Cfg?.model || l3Cfg.model.trim().length === 0;

  let l3CallsUsed = 0;
  const blocks: string[] = [];
  let total = 0;
  const perBlockCap = Math.min(maxChars / 3, 10000);

  /**
   * 加入一个 block，按剩余预算截断。
   * 返回 true 表示成功加入，false 表示预算已满。
   */
  function addBlock(header: string, content: string): boolean {
    if (total >= maxChars) return false;
    const block = `${header}\n${content}`;
    const trimmedBlock = block.length > perBlockCap
      ? truncateAtSemanticBoundary(block, perBlockCap)
      : block;
    if (total + trimmedBlock.length > maxChars) {
      const remaining = maxChars - total;
      if (remaining > 100) {
        blocks.push(truncateAtSemanticBoundary(trimmedBlock, remaining));
        total = maxChars;
      }
      return false;
    }
    blocks.push(trimmedBlock);
    total += trimmedBlock.length + 2;
    return true;
  }

  // 1. Prefetched hints (highest priority).
  for (const [hintNum, content] of prefetched.entries()) {
    const hintText = prefetchedHints[hintNum - 1] ?? `hint ${hintNum}`;
    const ok = addBlock(`=== [prefetched hint ${hintNum}: ${hintText}] ===`, content);
    if (!ok) break;
  }

  // 2. Captured tool calls.
  for (const call of captured) {
    if (total >= maxChars) break;

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

    // v0.13.0: 三层截断策略 —— 针对单个工具调用的结果文本
    //   L1: resultText < 5KB → 直接加入（绝大多数 grep/list 结果走这条）
    //   L2: 5KB ≤ resultText < l3Threshold → addBlock 内部按语义边界截断
    //   L3: resultText ≥ l3Threshold 且为代码文件 → 调 M3 孙代理精选
    let contentForBlock: string;
    const contentLen = call.resultText.length;

    if (contentLen < smallThreshold) {
      // L1: 小内容，直接走 addBlock（addBlock 会处理总预算）
      contentForBlock = call.resultText;
    } else if (contentLen < l3Threshold) {
      // L2: 中等内容，仍走 addBlock，但 addBlock 内部用语义边界截断
      contentForBlock = call.resultText;
    } else {
      // L3 候选：超大内容 + 代码文件
      // v0.14.0: l3Disabled 时不触发 L3（直接走 L2）
      const shouldL3 = !l3Disabled && pathHint &&
        shouldTriggerL3(pathHint, contentLen, l3Threshold) &&
        l3CallsUsed < l3MaxCalls;

      if (shouldL3) {
        // 派 M3 孙代理（异步，不阻塞其他 block）
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
            // L3 失败 → fallback L2
            contentForBlock = truncateAtSemanticBoundary(call.resultText, perBlockCap);
          }
        } catch {
          // L3 异常 → fallback L2
          contentForBlock = truncateAtSemanticBoundary(call.resultText, perBlockCap);
        }
      } else {
        // 不触发 L3（非代码文件 / 已达 L3 上限 / 无路径）→ L2 语义边界截断
        contentForBlock = truncateAtSemanticBoundary(call.resultText, perBlockCap);
      }
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

