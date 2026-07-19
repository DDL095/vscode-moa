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
  l3Summarizer: L3Config;
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
      l3Summarizer: p.l3Summarizer ?? { model: '' },
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
      l3Summarizer: p.l3Summarizer ?? { model: '' },
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
      l3Summarizer: legacy.l3Summarizer,
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
