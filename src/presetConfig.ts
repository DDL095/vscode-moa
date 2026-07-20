/**
 * v0.14.14: Preset group management.
 *
 * This module is the SINGLE SOURCE OF TRUTH for reading pipeline configuration.
 * Both moaRunner.ts and moaOrchestrator.ts must go through `getActivePresetConfig()`
 * instead of reading `moa.refModels` / `moa.aggregator` directly. This keeps them
 * in sync when the user switches presets.
 *
 * Backward compatibility:
 *   - Legacy flat config (moa.refModels + moa.aggregator + moa.reconModel +
 *     moa.l3Summarizer) is auto-migrated to `presets.default` on first access
 *     IF `moa.presets` is empty.
 *   - Legacy fields are NOT deleted (they serve as fallback if presets get
 *     corrupted).
 *   - Migration is idempotent — only writes if presets is truly empty.
 *
 * Storage layout (settings.json):
 *   "moa.presets": {
 *     "default": { name, refModels, aggregator, reconModel, l3Summarizer, ... },
 *     "research": { ... },
 *     "quick": { ... }
 *   }
 *   "moa.activePreset": "default"  // key into presets map
 */

import * as vscode from 'vscode';
import type {
  RefModelConfig,
  AggregatorConfig,
  ReconConfig,
  L3Config,
  MoaPreset,
  PlannerConfig,
  ActorConfig,
} from './types';

/** Sentinel returned when there's no config at all (fresh install). */
export interface EmptyPresetConfig {
  isEmpty: true;
}

/** Returned when a valid preset (legacy or new) is available. */
export interface ResolvedPresetConfig {
  isEmpty: false;
  /** The preset name (key into moa.presets, or "default" for legacy). */
  activeName: string;
  /** Whether this resolution came from legacy flat config (for logging). */
  fromLegacy: boolean;
  refModels: RefModelConfig[];
  aggregator: AggregatorConfig;
  reconModel: ReconConfig;
  /**
   * v0.18.0: 并行 Recon 模型列表（resolved）。
   *
   * 解析顺序：
   *   1. preset.reconModels（数组，非空）→ 直接用
   *   2. preset.reconModel（单数，非空 model）→ 包装成单元素数组
   *   3. fallback → [aggregator]
   *
   * 长度 = 1 时调用方应自动关闭并行 + 关闭 Recon Aggregator。
   */
  reconModels: ReconConfig[];
  /**
   * v0.18.0: Recon Aggregator 配置（整合多份 Recon）。
   * 仅当 reconModels.length >= 2 且 parallelRecon=true 时有意义。
   * model='' = fallback 到 aggregator。
   */
  reconAggregator: ReconConfig;
  l3Summarizer: L3Config;
  /** v0.15.0: Planner 配置（可能为 undefined，表示未配置，fallback 到 aggregator）。 */
  planner?: PlannerConfig;
  /** v0.15.0: Actor 配置（可能为 undefined，fallback 到 aggregator）。 */
  actor?: ActorConfig;
}

export type ActivePresetConfig = ResolvedPresetConfig | EmptyPresetConfig;

/**
 * Detect whether legacy flat config has any usable content.
 *
 * "Usable" = at least one ref model configured. Other fields (aggregator,
 * recon, L3) all have sensible fallbacks, so refs are the canary.
 */
function legacyConfigHasContent(): boolean {
  const cfg = vscode.workspace.getConfiguration('moa');
  const refs = cfg.get<RefModelConfig[]>('refModels') ?? [];
  return refs.length > 0;
}

/**
 * Read legacy flat config into a preset bundle.
 *
 * Used during auto-migration. Does NOT write anything.
 */
function readLegacyConfig(): MoaPreset {
  const cfg = vscode.workspace.getConfiguration('moa');
  const refs = cfg.get<RefModelConfig[]>('refModels') ?? [];
  const agg = cfg.get<AggregatorConfig>('aggregator') ?? { model: '' };
  const recon = cfg.get<ReconConfig>('reconModel') ?? { model: '' };
  const l3 = cfg.get<L3Config>('l3Summarizer') ?? { model: '' };
  return {
    name: 'default',
    refModels: refs,
    aggregator: agg,
    reconModel: recon,
    l3Summarizer: l3,
    description: 'Auto-migrated from pre-v0.14.14 flat config',
    createdAt: new Date().toISOString(),
  };
}

/**
 * Auto-migrate legacy flat config → presets.default.
 *
 * Idempotent: only writes if `moa.presets` is empty/null AND legacy config
 * has refs. Otherwise returns the existing presets as-is.
 *
 * Writes to User + Workspace (matching saveConfiguration strategy).
 *
 * Returns the migrated default preset, or undefined if no migration happened.
 */
export async function migrateLegacyToPreset(): Promise<MoaPreset | undefined> {
  const cfg = vscode.workspace.getConfiguration('moa');
  const existingPresets = cfg.get<Record<string, MoaPreset>>('presets') ?? {};

  // Already has presets → no migration needed
  if (Object.keys(existingPresets).length > 0) {
    return undefined;
  }

  // No legacy content → nothing to migrate (fresh install)
  if (!legacyConfigHasContent()) {
    return undefined;
  }

  // Build default preset from legacy fields
  const defaultPreset = readLegacyConfig();

  // Write to User + Workspace
  const targets = [
    vscode.ConfigurationTarget.Global,
    vscode.ConfigurationTarget.Workspace,
  ];
  for (const target of targets) {
    await cfg.update('presets', { default: defaultPreset }, target);
    await cfg.update('activePreset', 'default', target);
  }

  return defaultPreset;
}

/**
 * SINGLE SOURCE OF TRUTH: resolve the currently-active preset config.
 *
 * Resolution order:
 *   1. `moa.presets[activePreset]` — the explicit preset
 *   2. If presets is empty but legacy flat config has refs → auto-migrate,
 *      then return the migrated default
 *   3. If nothing exists → return { isEmpty: true } (caller decides how to
 *      handle, e.g. throw an error asking user to configure)
 *
 * This is a SYNC read (no settings writes). Migration is done separately
 * by `migrateLegacyToPreset()` which the extension should call once on
 * activate(). This keeps `getActivePresetConfig()` cheap to call from
 * inside hot loops.
 *
 * If presets[activePreset] is missing but presets has OTHER keys, we fall
 * back to the first key (and log a warning via console.warn — caller can
 * surface this in UI if desired).
 */

/**
 * v0.18.0: 解析并行 Recon 模型列表。
 *
 * 解析顺序（与文档一致）：
 *   1. preset.reconModels（数组，长度 >= 1，且至少一个 model 非空）→ 用数组
 *   2. preset.reconModel（单数，model 非空）→ 包装成单元素数组
 *   3. fallback → [{ model: '' }]（占位，调用方会 fallback 到 aggregator）
 *
 * 注意：返回值始终是非空数组（至少 1 个元素），让调用方不用处理 undefined。
 */
function resolveReconModels(p: MoaPreset): ReconConfig[] {
  // 1. 数组优先
  if (Array.isArray(p.reconModels) && p.reconModels.length > 0) {
    const valid = p.reconModels.filter((r) => r && typeof r.model === 'string');
    if (valid.length > 0) return valid;
  }
  // 2. 单数 fallback
  if (p.reconModel && typeof p.reconModel.model === 'string') {
    return [p.reconModel];
  }
  // 3. 最终 fallback（占位，调用方解析时 fallback 到 aggregator）
  return [{ model: '' }];
}

export function getActivePresetConfig(): ActivePresetConfig {
  const cfg = vscode.workspace.getConfiguration('moa');
  const presets = cfg.get<Record<string, MoaPreset>>('presets') ?? {};
  const activeKey = cfg.get<string>('activePreset') ?? 'default';

  // Case 1: explicit preset exists
  if (presets[activeKey]) {
    const p = presets[activeKey];
    return {
      isEmpty: false,
      activeName: activeKey,
      fromLegacy: false,
      refModels: p.refModels ?? [],
      aggregator: p.aggregator ?? { model: '' },
      reconModel: p.reconModel ?? { model: '' },
      reconModels: resolveReconModels(p),
      reconAggregator: p.reconAggregator ?? { model: '' },
      l3Summarizer: p.l3Summarizer ?? { model: '' },
      planner: p.planner,
      actor: p.actor,
    };
  }

  // Case 2: presets has other keys but not activeKey → use first key
  const presetKeys = Object.keys(presets);
  if (presetKeys.length > 0) {
    const fallbackKey = presetKeys[0];
    console.warn(
      `[moa] activePreset="${activeKey}" not found in presets, falling back to "${fallbackKey}"`
    );
    const p = presets[fallbackKey];
    return {
      isEmpty: false,
      activeName: fallbackKey,
      fromLegacy: false,
      refModels: p.refModels ?? [],
      aggregator: p.aggregator ?? { model: '' },
      reconModel: p.reconModel ?? { model: '' },
      reconModels: resolveReconModels(p),
      reconAggregator: p.reconAggregator ?? { model: '' },
      l3Summarizer: p.l3Summarizer ?? { model: '' },
      planner: p.planner,
      actor: p.actor,
    };
  }

  // Case 3: no presets at all → fall back to legacy flat config (read-only)
  if (legacyConfigHasContent()) {
    const legacy = readLegacyConfig();
    return {
      isEmpty: false,
      activeName: 'default',
      fromLegacy: true,
      refModels: legacy.refModels,
      aggregator: legacy.aggregator,
      reconModel: legacy.reconModel,
      // v0.18.0: legacy 配置没有 reconModels/reconAggregator，
      //   自动把单数 reconModel 包装成单元素数组（关闭并行）
      reconModels: resolveReconModels(legacy),
      reconAggregator: { model: '' },
      l3Summarizer: legacy.l3Summarizer,
      // v0.15.0: legacy 配置没有 planner/actor，返回 undefined（调用方 fallback 到 aggregator）
      planner: undefined,
      actor: undefined,
    };
  }

  // Case 4: nothing configured
  return { isEmpty: true };
}

/**
 * Save a preset to moa.presets[key].
 *
 * Writes to User + Workspace (matches saveConfiguration strategy).
 * Does NOT change activePreset — caller decides whether to also switch.
 */
export async function savePreset(
  key: string,
  preset: MoaPreset
): Promise<boolean> {
  if (!key || !key.trim()) {
    vscode.window.showErrorMessage('Preset name cannot be empty.');
    return false;
  }

  // Normalize: trim, replace internal whitespace with underscores
  const normalizedKey = key.trim().replace(/\s+/g, '_');

  const cfg = vscode.workspace.getConfiguration('moa');
  const existing = cfg.get<Record<string, MoaPreset>>('presets') ?? {};

  // Merge: preserve other presets, add/update this one
  const updated = { ...existing, [normalizedKey]: { ...preset, name: normalizedKey } };

  const targets = [
    vscode.ConfigurationTarget.Global,
    vscode.ConfigurationTarget.Workspace,
  ];

  try {
    for (const target of targets) {
      await cfg.update('presets', updated, target);
    }
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`Failed to save preset "${normalizedKey}": ${msg}`);
    return false;
  }
}

/**
 * Delete a preset from moa.presets.
 *
 * Refuses to delete the last remaining preset (would leave user with no config).
 * If the deleted preset was active, switches activePreset to the first remaining.
 */
export async function deletePreset(key: string): Promise<boolean> {
  const cfg = vscode.workspace.getConfiguration('moa');
  const existing = cfg.get<Record<string, MoaPreset>>('presets') ?? {};

  if (!existing[key]) {
    vscode.window.showWarningMessage(`Preset "${key}" does not exist.`);
    return false;
  }

  const remaining = { ...existing };
  delete remaining[key];

  const remainingKeys = Object.keys(remaining);
  if (remainingKeys.length === 0) {
    const confirm = await vscode.window.showWarningMessage(
      `Deleting preset "${key}" will leave you with NO presets. @moa will not work until you create a new one. Continue?`,
      { modal: false },
      'Delete',
      'Cancel'
    );
    if (confirm !== 'Delete') return false;
  }

  const activeKey = cfg.get<string>('activePreset') ?? 'default';
  let newActiveKey = activeKey;
  if (activeKey === key) {
    newActiveKey = remainingKeys[0] ?? '';
  }

  const targets = [
    vscode.ConfigurationTarget.Global,
    vscode.ConfigurationTarget.Workspace,
  ];
  try {
    for (const target of targets) {
      await cfg.update('presets', remaining, target);
      await cfg.update('activePreset', newActiveKey, target);
    }
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`Failed to delete preset "${key}": ${msg}`);
    return false;
  }
}

/**
 * Set the active preset by key.
 *
 * Writes to User + Workspace. Returns false if key doesn't exist.
 */
export async function setActivePreset(key: string): Promise<boolean> {
  const cfg = vscode.workspace.getConfiguration('moa');
  const presets = cfg.get<Record<string, MoaPreset>>('presets') ?? {};

  if (!presets[key]) {
    vscode.window.showErrorMessage(`Preset "${key}" not found.`);
    return false;
  }

  const targets = [
    vscode.ConfigurationTarget.Global,
    vscode.ConfigurationTarget.Workspace,
  ];
  try {
    for (const target of targets) {
      await cfg.update('activePreset', key, target);
    }
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`Failed to switch active preset: ${msg}`);
    return false;
  }
}

/**
 * List all preset keys + their preview (for UI display).
 *
 * Returns sorted by createdAt (oldest first), with `default` always first
 * if it exists.
 */
export function listPresets(): Array<{ key: string; preset: MoaPreset }> {
  const cfg = vscode.workspace.getConfiguration('moa');
  const presets = cfg.get<Record<string, MoaPreset>>('presets') ?? {};

  const entries = Object.entries(presets).map(([key, preset]) => ({ key, preset }));

  // Sort: default first, then by createdAt
  entries.sort((a, b) => {
    if (a.key === 'default') return -1;
    if (b.key === 'default') return 1;
    const aTime = a.preset.createdAt ?? '';
    const bTime = b.preset.createdAt ?? '';
    return aTime.localeCompare(bTime);
  });

  return entries;
}

/**
 * Get the active preset key (for UI display).
 */
export function getActivePresetKey(): string {
  return vscode.workspace.getConfiguration('moa').get<string>('activePreset') ?? 'default';
}
