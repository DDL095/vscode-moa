/**
 * Interactive configuration commands for MoA Bridge.
 *
 * v0.7.0 commands:
 *   - moa.configureModels  : QuickPick UI to pick N ref models (equal mode) + aggregator
 *   - moa.testAllModels    : Probe ALL registered models with PONG ping
 *
 * Removed in v0.7.0 (user request — precise selection makes them redundant):
 *   - moa.listModels
 *   - moa.testModels (Smart)
 *
 * v0.7.0 identity model: each `vscode.lm` model is uniquely identified by
 * `m.id` (e.g. "gcmp.zhipu:::GLM-5.2-CodingPlan"). Multiple vendors can
 * register models with the SAME `m.name` (e.g. "GLM-5.2 (CodingPlan)"
 * exists under both gcmp.zhipu and volcengine) — only `m.id` is unique.
 *
 * Therefore Configure Models stores `m.id` in the `model` field, NOT
 * `m.name`. Pre-pick uses exact `m.id` match → no more "4 refs → 11 picks"
 * bug. The QuickPick label includes the vendor suffix for human readability.
 *
 * Settings written to `moa.refModels` (array of {role, model} where model is
 * the unique m.id string).
 *
 * Design philosophy (v2 — Together AI MoA 2024 / Hermes classic):
 *   - Equal-mode MoA: all refs share the same prompt, diversity comes from
 *     model differences (GLM vs DeepSeek vs MiniMax).
 *   - `role` field is just a display label (advisor_1, advisor_2, ...),
 *     NOT a role specialization.
 *   - Optional `moa.sharedRefPrompt` overrides the built-in Hermes prompt.
 */

import * as vscode from 'vscode';
import type { RefModelConfig, AggregatorConfig } from './types';

// ─────────────────────────────────────────────────────────────────────────
// Internal helpers: model identity, display, lookup.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Build a human-readable display label that disambiguates same-name models
 * from different vendors. Example:
 *   m.name="GLM-5.2 (CodingPlan)", m.vendor="gcmp.zhipu"
 *   → "GLM-5.2 (CodingPlan) [gcmp.zhipu]"
 *
 * Used as the QuickPick `label` so the user can tell same-name models apart.
 * NOT used as the storage key — that's `m.id` (see `modelKey()`).
 */
function displayLabel(m: vscode.LanguageModelChat): string {
  const vendor = m.vendor ?? '';
  return vendor ? `${m.name} [${vendor}]` : m.name;
}

/**
 * The unique storage key for a model. Always `m.id` — never `m.name`.
 *
 * vscode.lm model IDs look like "gcmp.zhipu:::GLM-5.2-CodingPlan" — globally
 * unique across vendors. Stored in `moa.refModels[].model` and
 * `moa.aggregator.model`.
 *
 * At runtime, moaRunner resolves this key back to the LanguageModelChat by
 * exact id match (with substring fallback for backward compat with configs
 * saved by v0.6.x or earlier).
 */
function modelKey(m: vscode.LanguageModelChat): string {
  return m.id ?? m.name;
}

/** Build sorted QuickPick items from vscode.lm models (sorted by vendor then name). */
async function buildModelItems(): Promise<{
  items: Array<{ label: string; description: string; detail: string; model: vscode.LanguageModelChat; picked?: boolean }>;
  models: vscode.LanguageModelChat[];
}> {
  const allModels = await vscode.lm.selectChatModels({});
  const sortedModels = [...allModels].sort((a, b) => {
    const va = (a.vendor ?? '').toLowerCase();
    const vb = (b.vendor ?? '').toLowerCase();
    if (va !== vb) return va.localeCompare(vb);
    return a.name.localeCompare(b.name);
  });
  const items = sortedModels.map((m) => ({
    label: displayLabel(m),
    description: m.id ?? '',
    detail: `max input: ${m.maxInputTokens ?? '?'} tokens`,
    model: m,
  }));
  return { items, models: sortedModels };
}

/** Persist configuration to VSCode settings. Asks user for save target (Workspace default). */
async function saveConfiguration(
  refs: RefModelConfig[] | undefined,
  aggregatorName: string | undefined,
  existingTemp?: number
): Promise<vscode.ConfigurationTarget | null> {
  if (!refs && !aggregatorName) return null;

  const targetPick = await vscode.window.showQuickPick(
    [
      { label: 'Workspace', description: '.vscode/settings.json (this project only)', target: vscode.ConfigurationTarget.Workspace, picked: true },
      { label: 'User', description: 'Global settings (all projects)', target: vscode.ConfigurationTarget.Global },
    ],
    { placeHolder: 'Save configuration to?' }
  );
  if (!targetPick) return null;
  const target = (targetPick as any).target as vscode.ConfigurationTarget;

  const cfg = vscode.workspace.getConfiguration('moa');
  if (refs) await cfg.update('refModels', refs, target);
  if (aggregatorName) {
    const existingAgg = cfg.get<AggregatorConfig>('aggregator');
    await cfg.update('aggregator', { model: aggregatorName, temperature: existingTemp ?? existingAgg?.temperature ?? 0.4 }, target);
  }
  return target;
}

// ─────────────────────────────────────────────────────────────────────────
// Configure Models — the single entry point.
//
// Two-step flow:
//   1. Multi-select refs (checkbox, canPickMany)
//   2. Single-select aggregator (enforced)
//
// Pre-pick uses SUBSTRING matching (consistent with moaRunner's runtime
// model resolution): a ref's `model` field can be either a substring like
// "DeepSeek-V4-Flash" or a full name like "DeepSeek-V4-Flash (gcmp.deepseek)".
// Both forms will correctly pre-check the matching QuickPick item.
//
// Empty selection (all checkboxes cleared) triggers a confirm dialog.
// ─────────────────────────────────────────────────────────────────────────
export async function configureModels(): Promise<void> {
  const { items, models } = await buildModelItems();
  if (models.length === 0) {
    vscode.window.showErrorMessage('No chat models available. Install/activate an LLM provider extension first.');
    return;
  }

  const existingRefs = vscode.workspace.getConfiguration('moa').get<RefModelConfig[]>('refModels') ?? [];
  const existingAgg = vscode.workspace.getConfiguration('moa').get<AggregatorConfig>('aggregator');

  // ─────────────────────────────────────────────────────────────────────────
  // Pre-pick logic (v0.7.0): UNIQUE by m.id — no more "4 refs → 11 picks".
  //
  // Each QuickPick item is uniquely identified by `modelKey(m)` = `m.id`.
  // For each configured ref, we mark exactly ONE item as picked — the one
  // whose m.id matches cfg.model. Backward compat: if cfg.model is an old
  // v0.6.x substring (not a full m.id), fall back to FIRST substring match
  // on the display label.
  // ─────────────────────────────────────────────────────────────────────────
  const refItems = items.map((it) => {
    let isPicked = false;
    for (const cfg of existingRefs) {
      // Primary: exact match on m.id (v0.7.0 saved configs).
      if (modelKey(it.model) === cfg.model) {
        isPicked = true;
        break;
      }
      // Backward compat: cfg.model might be an old substring like
      // "GLM-5.2 (CodingPlan)" saved by v0.6.x. Only mark THIS item if it's
      // the FIRST display-label substring match.
      const sub = cfg.model.toLowerCase();
      if (it.label.toLowerCase().includes(sub) || it.model.name.toLowerCase().includes(sub)) {
        const firstMatchIdx = items.findIndex((x) =>
          x.label.toLowerCase().includes(sub) || x.model.name.toLowerCase().includes(sub)
        );
        if (firstMatchIdx >= 0 && items[firstMatchIdx] === it) {
          isPicked = true;
          break;
        }
      }
    }
    return { ...it, picked: isPicked };
  });

  // Step 1/2: refs (multi-select)
  const refPicks = await vscode.window.showQuickPick(refItems, {
    placeHolder: 'Step 1/2 — Tick reference advisor models (2-8 recommended)',
    title: 'MoA Configure — Step 1/2: Reference Advisors (equal mode, Hermes prompt)',
    canPickMany: true,
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (!refPicks) return; // Esc / cancel = abandon changes

  // Empty selection → confirm before clearing (prevents accidental data loss).
  if (refPicks.length === 0) {
    const confirmClear = await vscode.window.showWarningMessage(
      'You deselected ALL reference advisors. This will clear moa.refModels and @moa will not work until you reconfigure. Continue?',
      { modal: false },
      'Clear refs',
      'Cancel'
    );
    if (confirmClear !== 'Clear refs') return;
  }

  const selectedRefs = (refPicks as any[]).slice(0, 8).map((p) => p.model as vscode.LanguageModelChat);
  // v0.7.0: store m.id (unique) — NOT m.name (which can collide across vendors).
  const newRefs: RefModelConfig[] = selectedRefs.map((m, i) => ({
    role: `advisor_${i + 1}`,
    model: modelKey(m),
  }));

  // Step 2/2: aggregator (single-select). Default: existing aggregator, or
  // first selected ref if no existing aggregator, or first model.
  // v0.7.0: lookup by m.id first (exact), then fall back to substring match
  // on m.name (for backward compat with v0.6.x configs).
  const aggDefaultIdx = existingAgg?.model
    ? models.findIndex((m) => modelKey(m) === existingAgg.model) >= 0
      ? models.findIndex((m) => modelKey(m) === existingAgg.model)
      : models.findIndex((m) => m.name.toLowerCase().includes(existingAgg.model!.toLowerCase()))
    : selectedRefs.length > 0
      ? models.findIndex((m) => m.id === selectedRefs[0].id)
      : 0;
  const aggItems = items.map((it, i) => ({
    ...it,
    picked: i === (aggDefaultIdx >= 0 ? aggDefaultIdx : 0),
  }));

  const aggPick = await vscode.window.showQuickPick(aggItems, {
    placeHolder: 'Step 2/2 — Pick aggregator model (single-select enforced)',
    title: `MoA Configure — Step 2/2: Aggregator (${newRefs.length} ref(s) selected)`,
    matchOnDescription: true,
    matchOnDetail: true,
    // No canPickMany → single-select enforced by VSCode.
  });
  if (!aggPick) return;

  const aggModel = (aggPick as any).model as vscode.LanguageModelChat;
  // v0.7.0: store m.id (unique).
  const target = await saveConfiguration(newRefs, modelKey(aggModel));
  if (target !== null) {
    vscode.window.showInformationMessage(
      `MoA configured: ${newRefs.length} ref(s) + aggregator ${displayLabel(aggModel)}. Try @moa <question> now.`
    );
  }
}

// ---------- end of file ----------

