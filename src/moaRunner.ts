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
 * Run MoA via the P1 native subagent simulation.
 *
 * This is a *skeleton* — it picks the first 3 available chat models and asks
 * each for an opinion, then forwards them to an aggregator model. Real
 * implementation would parse MoaSim.ps1 output or replicate its fan-out logic.
 */
export async function runP1Fanout(
  prompt: string,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken
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
    'Your job is to give your most intelligent analysis of the user\'s question: understand the goal, reason about the problem, and advise on what the answer should be. Surface the best approach, concrete reasoning, likely pitfalls and risks, and anything that might be missed or gotten wrong. Assume any referenced files, URLs, or systems exist and reason about them from the context given rather than asking for access.',
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

  for (const ref of probePool) {
    // Equal-mode: same Hermes-style system prompt for every ref.
    const refPrompts: vscode.LanguageModelChatMessage[] = [
      vscode.LanguageModelChatMessage.User(
        `${sharedRefPrompt}\n\n=== USER QUESTION ===\n${prompt}`
      ),
    ];
    try {
      const response = await ref.model.sendRequest(refPrompts, {}, token);
      let text = '';
      for await (const frag of response.text) {
        text += frag;
      }
      stream.markdown(`**Ref [${ref.label} / ${formatModel(ref.model)}]**:\n\n${text}\n\n---\n\n`);
      successes.push({ model: ref.model, name: ref.model.name, label: ref.label, text });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const shortMsg = msg.length > 150 ? msg.substring(0, 150) + '...' : msg;
      stream.markdown(`**Ref [${ref.label} / ${formatModel(ref.model)}]**: [skipped] ${shortMsg}\n\n---\n\n`);
      failures.push({ name: `${ref.label}/${ref.model.name}`, msg });
    }
  }

  // All refs failed — graceful degradation.
  if (successes.length === 0) {
    stream.markdown(
      `**[MoA degraded]** All ${failures.length} configured ref(s) failed. ` +
        `This usually means expired/invalid subscriptions or unsupported models.\n\n` +
        `**Troubleshooting**:\n` +
        `- Run "Moa: Probe Models (Smart)" to see which models still work\n` +
        `- Then run "Moa: Configure Models" to pick working ones\n` +
        `- Failed: ${failures.map((f) => f.name).join(', ')}\n\n`
    );
    return {
      output: '[all refs failed]',
      elapsed: (Date.now() - start) / 1000,
      path: 'P1-degraded',
    };
  }

  // Aggregator: prefer configured model, else first successful ref.
  // v0.7.0: same lookup logic as refs — m.id first, substring fallback.
  const aggCfg = config.get<{ model?: string; temperature?: number }>('aggregator');
  let aggregator: vscode.LanguageModelChat = successes[0].model;
  if (aggCfg?.model) {
    let match = realCandidates.find((m) => (m.id ?? '') === aggCfg.model);
    if (!match) {
      match = realCandidates.find((m) => m.name.toLowerCase().includes(aggCfg.model!.toLowerCase()));
    }
    if (match) aggregator = match;
  }
  stream.progress(
    `[MoA] aggregator: ${formatModel(aggregator)} (using ${successes.length}/${successes.length + failures.length} successful refs)`
  );

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
  // Reference outputs are joined using Hermes's exact format:
  //   "Reference {idx} — {label}:\n{text}"
  // ─────────────────────────────────────────────────────────────────────────
  const joined = successes
    .map((r, i) => `Reference ${i + 1} — ${r.label} (${r.name}):\n${r.text}`)
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
    stream.markdown(aggregated);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    stream.markdown(
      `**[Aggregator error]**: ${msg}\n\n` +
        `---\n\n**Fallback** — showing the first ref response verbatim:\n\n${successes[0].text}`
    );
    aggregated = successes[0].text;
  }

  return {
    output: aggregated,
    elapsed: (Date.now() - start) / 1000,
    path: successes.length >= 2 ? 'P1' : 'P1-partial',
  };
}

