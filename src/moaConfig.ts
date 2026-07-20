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
import type { RefModelConfig, AggregatorConfig, ReconConfig, L3Config, MoaPreset } from './types';
import {
  listPresets,
  getActivePresetKey,
  setActivePreset,
  savePreset,
  deletePreset,
  getActivePresetConfig,
} from './presetConfig';

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

// ─────────────────────────────────────────────────────────────────────────
// v0.14.1: 单选对勾 QuickPick 辅助
//
// VSCode API 限制：showQuickPick({ canPickMany: false }) 时，picked 字段被忽略，
// 不显示对勾标记。这导致用户看不到"当前已选哪个模型"。
//
// 解法：用 createQuickPick + canSelectMany=true，让对勾可见，
// 但用 onDidChangeSelection 实时校验选中数（限 1 个），多选时弹 warning。
//
// 用户操作流程：
//   1. 看到带对勾的列表（对勾标记当前已选）
//   2. 点击其他项切换对勾（VSCode 自动 toggle）
//   3. 实时校验：若选中数 > 1，弹 warning 提示只能选一个
//   4. 按 Enter 或点击确认按钮（check icon）提交
// ─────────────────────────────────────────────────────────────────────────

/**
 * 单选对勾 QuickPick。返回选中的那一个 item，或 undefined（用户取消）。
 *
 * @param items    候选项（带 picked 字段，预勾选当前值）
 * @param title    QuickPick 标题
 * @param placeHolder 提示文本
 * @param confirmTooltip 确认按钮的 tooltip（默认"确认选择"）
 */
async function singlePickWithCheckbox<T extends { label: string; picked?: boolean }>(
  items: T[],
  title: string,
  placeHolder: string,
  confirmTooltip: string = '确认选择（Enter 或点击右侧 ✓ 按钮）'
): Promise<T | undefined> {
  return new Promise<T | undefined>((resolve) => {
    const qp = vscode.window.createQuickPick<T>();
    qp.items = items;
    qp.title = title;
    qp.placeholder = placeHolder;
    qp.canSelectMany = true;
    qp.matchOnDescription = true;
    qp.matchOnDetail = true;

    // 初始 selectedItems（基于 picked 字段）
    qp.selectedItems = items.filter((it) => it.picked);

    // 默认确认按钮（✓）
    const confirmBtn: vscode.QuickInputButton = {
      iconPath: new vscode.ThemeIcon('check'),
      tooltip: confirmTooltip,
    };
    qp.buttons = [confirmBtn];

    // 实时检测选中数
    qp.onDidChangeSelection((selection) => {
      if (selection.length > 1) {
        qp.buttons = [{
          iconPath: new vscode.ThemeIcon('warning'),
          tooltip: `只能选一个（当前选了 ${selection.length} 个，请取消多余项）`,
        }];
      } else if (selection.length === 1) {
        qp.buttons = [confirmBtn];
      } else {
        qp.buttons = [{
          iconPath: new vscode.ThemeIcon('circle-slash'),
          tooltip: '请选择一个',
        }];
      }
    });

    // 点击按钮（仅选中数 === 1 时接受）
    qp.onDidTriggerButton((btn) => {
      if (btn !== confirmBtn) {
        vscode.window.showWarningMessage(`只能选一个模型，请取消多余的选择（当前选了 ${qp.selectedItems.length} 个）`);
        return;
      }
      if (qp.selectedItems.length === 1) {
        const picked = qp.selectedItems[0];
        qp.hide();
        resolve(picked);
      } else if (qp.selectedItems.length === 0) {
        vscode.window.showWarningMessage('请选择一个模型');
      } else {
        vscode.window.showWarningMessage(`只能选一个模型，请取消多余的选择（当前选了 ${qp.selectedItems.length} 个）`);
      }
    });

    // 按 Enter（canSelectMany 模式下 onDidAccept 仍会被触发）
    qp.onDidAccept(() => {
      if (qp.selectedItems.length === 1) {
        const picked = qp.selectedItems[0];
        qp.hide();
        resolve(picked);
      } else if (qp.selectedItems.length === 0) {
        vscode.window.showWarningMessage('请选择一个模型');
      } else {
        vscode.window.showWarningMessage(`只能选一个模型，请取消多余的选择（当前选了 ${qp.selectedItems.length} 个）`);
      }
    });

    // 用户取消（Esc / 失焦）
    qp.onDidHide(() => {
      resolve(undefined);
    });

    qp.show();
  });
}

/**
 * v0.14.1: 持久化配置到 VSCode settings。
 *
 * 策略变更：**同时写到 User (Global) 和 Workspace 两级**。
 *   - User 级：保证全局生效（其他项目也能用）
 *   - Workspace 级：显式覆盖（保证当前项目必然生效，即使有旧 Workspace 配置）
 *
 * 不再让用户选保存目标 —— 默认 Both，简化 UX，避免"配了但没生效"的困惑。
 *
 * @param refs       新的 ref 列表（undefined = 不更新）
 * @param aggregatorName 新 aggregator model id（undefined = 不更新）
 * @param reconName  新 recon model id（空字符串合法 = fallback；undefined = 不更新）
 * @param l3Name     新 L3 model id（空字符串合法 = 禁用；undefined = 不更新）
 * @param existingTemp 可选：保留的 temperature 值
 * @returns true 表示写入成功
 */
async function saveConfiguration(
  refs: RefModelConfig[] | undefined,
  aggregatorName: string | undefined,
  reconName: string | undefined,
  l3Name: string | undefined,
  existingTemp?: number
): Promise<boolean> {
  if (!refs && !aggregatorName && reconName === undefined && l3Name === undefined) {
    return false;
  }

  const cfg = vscode.workspace.getConfiguration('moa');

  // 同时写到 User + Workspace（Workspace 显式覆盖，保证生效）
  const targets = [
    vscode.ConfigurationTarget.Global,
    vscode.ConfigurationTarget.Workspace,
  ];

  try {
    for (const target of targets) {
      if (refs) await cfg.update('refModels', refs, target);
      if (aggregatorName) {
        const existingAgg = cfg.get<AggregatorConfig>('aggregator');
        await cfg.update(
          'aggregator',
          { model: aggregatorName, temperature: existingTemp ?? existingAgg?.temperature ?? 0.4 },
          target
        );
      }
      // v0.14.0: reconModel —— 空字符串合法（表示 fallback 到 aggregator）
      if (reconName !== undefined) {
        const existingRecon = cfg.get<ReconConfig>('reconModel');
        await cfg.update(
          'reconModel',
          { model: reconName, temperature: existingRecon?.temperature },
          target
        );
      }
      // v0.14.0: l3Summarizer —— 空字符串合法（表示禁用 L3）
      if (l3Name !== undefined) {
        await cfg.update('l3Summarizer', { model: l3Name }, target);
      }
    }
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`Failed to save MoA configuration: ${msg}`);
    return false;
  }
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

  // ─────────────────────────────────────────────────────────────────────────
  // v0.14.14 Step 0/4: Pick / create / delete a preset group.
  //
  // This is the entry point of the new 5-step flow. User can:
  //   - Pick an existing preset to edit → loads its config into Steps 1-4
  //   - Create a new preset → starts with empty/default config
  //   - Delete an existing preset (except last one)
  //   - Skip (Esc) → edits the currently active preset (backward compat)
  //
  // The preset picked here is what gets WRITTEN at the end of Step 4.
  // We also offer to make it the active preset after saving.
  // ─────────────────────────────────────────────────────────────────────────
  const presetChoice = await pickOrCreatePreset();
  if (!presetChoice) return; // user cancelled

  // presetChoice.targetKey: which preset key we're editing
  // presetChoice.makeActive: whether to set this preset active after saving
  // presetChoice.seed: initial config for Steps 1-4 (existing preset values, or defaults for new)
  const targetPresetKey = presetChoice.targetKey;
  const seed = presetChoice.seed;

  // Resolve existing refs/agg from the SEED (not from global config).
  // This is the key change: Steps 1-4 now edit a SPECIFIC preset's values.
  const existingRefs = seed.refModels;
  const existingAgg = seed.aggregator;

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

  // Step 1/4: refs (multi-select)
  const refPicks = await vscode.window.showQuickPick(refItems, {
    placeHolder: 'Step 1/4 — Tick reference advisor models (2-8 recommended)',
    title: 'MoA Configure — Step 1/4: Reference Advisors (equal mode, Hermes prompt)',
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

  // Step 2/4: aggregator (single-select 对勾).
  // v0.18.1: 取消"新建时默认勾第一个 ref / 第一个模型"行为。
  //   - 已配置 → 按现有配置预勾选
  //   - 未配置 → 全部 picked:false（强制用户主动选择，避免"第一个模型被默认选上"）
  // v0.7.0: lookup by m.id first (exact), then fall back to substring match
  // on m.name (for backward compat with v0.6.x configs).
  let aggDefaultIdx = -1;
  if (existingAgg?.model) {
    const exactIdx = models.findIndex((m) => modelKey(m) === existingAgg.model);
    aggDefaultIdx = exactIdx >= 0
      ? exactIdx
      : models.findIndex((m) => m.name.toLowerCase().includes(existingAgg.model!.toLowerCase()));
  }
  const aggItems = items.map((it, i) => ({
    ...it,
    picked: i === (aggDefaultIdx >= 0 ? aggDefaultIdx : -1),
  }));

  const aggPick = await singlePickWithCheckbox(
    aggItems,
    `MoA Configure — Step 2/4: Aggregator (${newRefs.length} ref(s) selected)`,
    'Pick ONE aggregator model (synthesizes ref outputs). Click ✓ or press Enter to confirm.'
  );
  if (!aggPick) return;

  const aggModel = (aggPick as any).model as vscode.LanguageModelChat;
  const aggKey = modelKey(aggModel);

  // ─────────────────────────────────────────────────────────────────────────
  // v0.14.0 Step 3/4: Recon agent (single-select 对勾)
  //
  // Recon 是信息收集角色，需要工具调用稳定性。默认 = aggregator（向后兼容
  // v0.13.x）；用户可显式选其他模型。
  //
  // UI 设计：
  //   - 顶部加一个特殊选项 "(use aggregator: <name>)" —— 选这个表示 fallback
  //   - 其余选项是所有可用模型
  //   - 预勾选当前配置的 reconModel（空则勾 aggregator fallback 项）
  // ─────────────────────────────────────────────────────────────────────────
  const existingRecon = seed.reconModel;
  const RECON_FALLBACK_KEY = '__use_aggregator__';  // 特殊 sentinel key
  const reconFallbackLabel = `$(sync) Use aggregator (${displayLabel(aggModel)})`;

  // 构造 recon 选项列表（fallback 项 + 全部模型）
  const reconItems = [
    {
      label: reconFallbackLabel,
      description: 'Recommended — keep recon aligned with aggregator (v0.13.x behavior)',
      detail: 'Click to use the aggregator model for recon as well',
      model: null as vscode.LanguageModelChat | null,  // null = fallback sentinel
      picked: !existingRecon?.model || existingRecon.model === '',
    },
    ...items.map((it) => ({
      ...it,
      picked: existingRecon?.model === modelKey(it.model),
    })),
  ];

  const reconPick = await singlePickWithCheckbox(
    reconItems,
    `MoA Configure — Step 3/4: Recon Agent (aggregator=${displayLabel(aggModel)})`,
    'Pick ONE recon agent model (information collector). Click ✓ or press Enter to confirm.'
  );
  if (!reconPick) return;

  // reconKey: 空字符串 = fallback；否则 = m.id
  const reconModel = (reconPick as any).model as vscode.LanguageModelChat | null;
  const reconKey = reconModel ? modelKey(reconModel) : '';

  // ─────────────────────────────────────────────────────────────────────────
  // v0.14.0 Step 4/4: L3 Summarizer (single-select 对勾 + 禁用选项)
  //
  // L3 是大文件精选孙代理（CLAUDE.md §2.4 强制 M3）。
  //
  // UI 设计：
  //   - 顶部加 "Disable L3 (use L2 truncation only)" —— 选这个表示禁用
  //   - 其余选项是所有可用模型
  //
  // v0.18.1: 取消"未配置时主动查找 MiniMax-M3 并预勾选"的行为。
  //   首次配置时默认勾 "Disable L3"（"什么都不做"是更安全的默认），
  //   避免用户在不知情的情况下让某个模型被默认选上。
  // ─────────────────────────────────────────────────────────────────────────
  const existingL3 = seed.l3Summarizer;
  const L3_DISABLE_KEY = '__disable_l3__';
  const l3DisableLabel = `$(circle-slash) Disable L3 (use L2 semantic-boundary truncation only)`;

  // 决定预勾选项
  //   - 已配置（含 model='' 即显式禁用）→ 按配置匹配
  //   - 未配置（全新 preset / seed.l3Summarizer 为空对象）→ 默认勾 Disable L3
  let l3PrePickedIdx: number;
  if (existingL3?.model) {
    // 已有配置：按 m.id 匹配
    if (existingL3.model === '') {
      l3PrePickedIdx = 0;  // 禁用
    } else {
      const matchIdx = items.findIndex((it) => modelKey(it.model) === existingL3.model);
      l3PrePickedIdx = matchIdx >= 0 ? matchIdx + 1 : 0;  // 找不到则默认禁用（+1 跳过禁用项）
    }
  } else {
    // 新配置：默认 Disable L3（不主动推任何具体模型）
    l3PrePickedIdx = 0;
  }

  // 构造 L3 选项列表（禁用项 + 全部模型）
  const l3Items = [
    {
      label: l3DisableLabel,
      description: 'Skip L3 entirely — all large files truncated at semantic boundary',
      detail: 'Default for new presets — pick a model below if you want L3 condensation',
      model: null as vscode.LanguageModelChat | null,  // null = disable sentinel
      picked: l3PrePickedIdx === 0,
    },
    ...items.map((it, i) => ({
      ...it,
      picked: i + 1 === l3PrePickedIdx,
    })),
  ];

  const l3Pick = await singlePickWithCheckbox(
    l3Items,
    `MoA Configure — Step 4/4: L3 Summarizer (recon=${reconKey || 'aggregator'})`,
    'Pick ONE L3 summarizer model (large file condenser) or the disable option. Click ✓ or press Enter to confirm.'
  );
  if (!l3Pick) return;

  const l3Model = (l3Pick as any).model as vscode.LanguageModelChat | null;
  const l3Key = l3Model ? modelKey(l3Model) : '';

  // v0.7.0: store m.id (unique).
  // v0.14.1: saveConfiguration 同时写到 User + Workspace，返回 boolean
  // v0.14.14: 改为 savePreset —— 保存到 moa.presets[targetPresetKey] 而不是扁平字段
  const presetToSave: MoaPreset = {
    name: targetPresetKey,
    refModels: newRefs,
    aggregator: { model: aggKey, temperature: existingAgg?.temperature ?? 0.4 },
    reconModel: { model: reconKey },
    l3Summarizer: { model: l3Key },
    description: seed.description,
    createdAt: seed.createdAt ?? new Date().toISOString(),
  };
  const saved = await savePreset(targetPresetKey, presetToSave);

  // 如果用户选了"切到这个 preset"，做切换
  if (saved && presetChoice.makeActive) {
    await setActivePreset(targetPresetKey);
  }

  if (saved) {
    const parts = [
      `preset=${targetPresetKey}${presetChoice.makeActive ? ' (active)' : ''}`,
      `${newRefs.length} ref(s)`,
      `aggregator=${displayLabel(aggModel)}`,
      `recon=${reconKey ? displayLabel(reconModel!) : '(= aggregator)'}`,
      `L3=${l3Key ? displayLabel(l3Model!) : '(disabled)'}`,
    ];
    vscode.window.showInformationMessage(
      `MoA configured: ${parts.join(', ')}. Saved to User + Workspace. Try @moa <question> now.`
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────
// v0.14.14: Preset group helpers (Step 0 UI + switchPreset command).
// ─────────────────────────────────────────────────────────────────────────

/**
 * Step 0 UI: Pick an existing preset to edit, create a new one, or delete one.
 *
 * Returns:
 *   - undefined → user cancelled (Esc) → caller aborts configureModels
 *   - { targetKey, makeActive, seed } → caller proceeds to Steps 1-4 with seed
 *
 * The seed is the initial config for Steps 1-4:
 *   - For existing preset: that preset's current values
 *   - For new preset: empty refs + empty aggregator (defaults)
 *
 * If user picks the currently active preset, `makeActive` is false (no-op).
 * If user picks a non-active preset or creates new, we ask whether to switch.
 */
async function pickOrCreatePreset(): Promise<
  | undefined
  | {
      targetKey: string;
      makeActive: boolean;
      seed: MoaPreset;
    }
> {
  // Build option list
  const presets = listPresets();
  const activeKey = getActivePresetKey();

  type PresetOption = {
    label: string;
    description: string;
    detail: string;
    action: 'edit' | 'new' | 'delete';
    presetKey?: string;
    seed?: MoaPreset;
  };

  const options: PresetOption[] = [];

  // Existing presets (edit)
  for (const { key, preset } of presets) {
    const isActive = key === activeKey;
    const refsCount = preset.refModels?.length ?? 0;
    const aggName = preset.aggregator?.model || '(unset)';
    options.push({
      label: `$(pencil) ${key}${isActive ? ' (active)' : ''}`,
      description: `${refsCount} refs · agg=${shortModelName(aggName)}`,
      detail: `Edit this preset${isActive ? ' (currently active)' : ''}`,
      action: 'edit',
      presetKey: key,
      seed: preset,
    });
  }

  // Always offer "new"
  options.push({
    label: '$(add) Create new preset...',
    description: 'Start with empty config',
    detail: 'You\'ll be asked for a name after this step',
    action: 'new',
    seed: {
      name: '',
      refModels: [],
      aggregator: { model: '' },
      reconModel: { model: '' },
      l3Summarizer: { model: '' },
    },
  });

  // Offer delete if there are presets (and more than 1, or 1 with confirmation)
  if (presets.length > 0) {
    options.push({
      label: '$(trash) Delete a preset...',
      description: `${presets.length} preset(s) available`,
      detail: 'Pick which one to remove',
      action: 'delete',
    });
  }

  const picked = await vscode.window.showQuickPick(options, {
    title: 'MoA Configure — Step 0/4: Preset Group',
    placeHolder: 'Pick a preset to edit, create new, or delete. Esc to edit the active preset.',
    matchOnDescription: true,
    matchOnDetail: true,
  });

  if (!picked) {
    // Esc = edit active preset (backward compat with v0.14.x flow)
    const active = presets.find((p) => p.key === activeKey);
    if (active) {
      return {
        targetKey: active.key,
        makeActive: false,
        seed: active.preset,
      };
    }
    // No active preset → fall back to legacy flat config as seed
    const activeCfg = getActivePresetConfig();
    if (!activeCfg.isEmpty) {
      return {
        targetKey: 'default',
        makeActive: false,
        seed: {
          name: 'default',
          refModels: activeCfg.refModels,
          aggregator: activeCfg.aggregator,
          reconModel: activeCfg.reconModel,
          l3Summarizer: activeCfg.l3Summarizer,
          description: 'Auto-seeded from active config',
          createdAt: new Date().toISOString(),
        },
      };
    }
    return undefined;
  }

  // Delete flow: sub-QuickPick to pick which one
  if (picked.action === 'delete') {
    const deleteOptions = presets.map(({ key, preset }) => ({
      label: `$(trash) ${key}${key === activeKey ? ' (active)' : ''}`,
      description: `${preset.refModels?.length ?? 0} refs`,
      detail: preset.description ?? '',
      presetKey: key,
    }));
    const toDelete = await vscode.window.showQuickPick(deleteOptions, {
      title: 'Delete which preset?',
      placeHolder: 'This cannot be undone (well, you can recreate it)',
    });
    if (!toDelete) return undefined;
    const ok = await deletePreset(toDelete.presetKey!);
    if (ok) {
      vscode.window.showInformationMessage(`Preset "${toDelete.presetKey}" deleted.`);
    }
    return undefined; // delete is terminal — user has to re-invoke configureModels
  }

  // New preset flow: ask for name first
  if (picked.action === 'new') {
    const name = await vscode.window.showInputBox({
      title: 'New preset name',
      prompt: 'Letters, digits, dash, underscore. Will be used as the key in moa.presets.',
      placeHolder: 'e.g. research, code, quick, fast',
      validateInput: (v) => {
        const trimmed = v.trim();
        if (!trimmed) return 'Name cannot be empty';
        if (!/^[a-zA-Z0-9_-]+$/.test(trimmed)) {
          return 'Use only letters, digits, dash, underscore (no spaces)';
        }
        const existing = listPresets().find((p) => p.key === trimmed);
        if (existing) return `Preset "${trimmed}" already exists`;
        return null;
      },
    });
    if (!name) return undefined;
    const newSeed: MoaPreset = {
      name,
      refModels: [],
      aggregator: { model: '' },
      reconModel: { model: '' },
      l3Summarizer: { model: '' },
      createdAt: new Date().toISOString(),
    };
    // For new preset, ask if they want it active
    const makeActive = await askMakeActive(name);
    return { targetKey: name, makeActive, seed: newSeed };
  }

  // Edit flow: if not active, ask if they want to switch
  const targetKey = picked.presetKey!;
  const makeActive =
    targetKey === activeKey ? false : await askMakeActive(targetKey);
  return { targetKey, makeActive, seed: picked.seed! };
}

/**
 * Quick helper: ask user whether to make this preset active after saving.
 */
async function askMakeActive(presetKey: string): Promise<boolean> {
  const choice = await vscode.window.showQuickPick(
    [
      { label: `$(check) Make "${presetKey}" active after saving`, value: true },
      { label: '$(circle-slash) Just save, don\'t switch active', value: false },
    ],
    {
      title: `Switch active preset?`,
      placeHolder: `Current active is "${getActivePresetKey()}". Switch to "${presetKey}" after save?`,
    }
  );
  return choice?.value ?? false;
}

/**
 * Extract a short model name from a full m.id (e.g. "gcmp.zhipu:::GLM-5.2-CodingPlan" → "GLM-5.2").
 * For QuickPick description display only.
 */
function shortModelName(modelId: string): string {
  if (!modelId) return '(unset)';
  // Take last segment after ":::" if present
  const afterSeparator = modelId.includes(':::')
    ? modelId.split(':::').pop()!
    : modelId;
  // Strip "(CodingPlan)" / "(TokenPlan)" suffixes for brevity
  return afterSeparator.replace(/\s*\([^)]*\)\s*/g, '').trim() || afterSeparator;
}

/**
 * v0.14.14: switchPreset command — QuickPick to switch active preset.
 *
 * Shows all presets with a preview of their models. One-click switch.
 * Also offers "Configure models" as a shortcut (jump to configureModels).
 */
export async function switchPreset(): Promise<void> {
  const presets = listPresets();
  const activeKey = getActivePresetKey();

  if (presets.length === 0) {
    const choice = await vscode.window.showWarningMessage(
      'No preset groups configured yet. Create one now?',
      { modal: false },
      'Create preset',
      'Cancel'
    );
    if (choice === 'Create preset') {
      await configureModels();
    }
    return;
  }

  type SwitchOption = {
    label: string;
    description: string;
    detail: string;
    presetKey?: string;
    isShortcut?: boolean;
  };

  const options: SwitchOption[] = presets.map(({ key, preset }) => {
    const isActive = key === activeKey;
    const refsCount = preset.refModels?.length ?? 0;
    const aggName = shortModelName(preset.aggregator?.model ?? '');
    const reconName = preset.reconModel?.model
      ? shortModelName(preset.reconModel.model)
      : `(=agg)`;
    const l3Name = preset.l3Summarizer?.model
      ? shortModelName(preset.l3Summarizer.model)
      : '(disabled)';
    return {
      label: `$(server) ${key}${isActive ? ' ✓ (active)' : ''}`,
      description: `${refsCount} refs`,
      detail: `agg=${aggName} · recon=${reconName} · L3=${l3Name}`,
      presetKey: key,
    };
  });

  // Shortcut: jump to full configure flow
  options.push({
    label: '$(gear) Configure models (full editor)...',
    description: 'Open Step 0-4 flow',
    detail: 'Edit refs/aggregator/recon/L3 in detail',
    isShortcut: true,
  });

  const picked = await vscode.window.showQuickPick(options, {
    title: 'MoA: Switch Active Preset',
    placeHolder: `Current: "${activeKey}". Pick a preset to activate.`,
    matchOnDescription: true,
    matchOnDetail: true,
  });

  if (!picked) return;

  if (picked.isShortcut) {
    await configureModels();
    return;
  }

  if (picked.presetKey && picked.presetKey !== activeKey) {
    const ok = await setActivePreset(picked.presetKey);
    if (ok) {
      vscode.window.showInformationMessage(
        `MoA preset switched: "${activeKey}" → "${picked.presetKey}". @moa will use the new preset now.`
      );
    }
  } else if (picked.presetKey === activeKey) {
    vscode.window.showInformationMessage(`"${activeKey}" is already active.`);
  }
}

// ---------- end of file ----------

