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
import type { RefModelConfig, AggregatorConfig, ReconConfig, L3Config } from './types';

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

  // Step 2/4: aggregator (single-select 对勾). Default: existing aggregator, or
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
  const existingRecon = vscode.workspace.getConfiguration('moa').get<ReconConfig>('reconModel');
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
  //   - 默认推荐 MiniMax-M3（如可用）
  // ─────────────────────────────────────────────────────────────────────────
  const existingL3 = vscode.workspace.getConfiguration('moa').get<L3Config>('l3Summarizer');
  const L3_DISABLE_KEY = '__disable_l3__';
  const l3DisableLabel = `$(circle-slash) Disable L3 (use L2 semantic-boundary truncation only)`;

  // 找 MiniMax-M3 作为推荐默认（仅在用户新配置或现有配置无效时使用）
  const minimaxM3 = models.find((m) =>
    /MiniMax.*M3/i.test(m.name) || /MiniMax.*M3/i.test(m.id)
  );

  // 决定预勾选项
  let l3PrePickedIdx = -1;
  if (existingL3?.model) {
    // 已有配置：按 m.id 匹配
    if (existingL3.model === '') {
      l3PrePickedIdx = 0;  // 禁用
    } else {
      const matchIdx = items.findIndex((it) => modelKey(it.model) === existingL3.model);
      l3PrePickedIdx = matchIdx >= 0 ? matchIdx + 1 : -1;  // +1 跳过禁用项
    }
  }
  if (l3PrePickedIdx < 0) {
    // 新配置：优先 MiniMax-M3，否则禁用
    l3PrePickedIdx = minimaxM3
      ? items.findIndex((it) => it.model === minimaxM3) + 1
      : 0;  // 无 M3 → 默认禁用
  }

  // 构造 L3 选项列表（禁用项 + 全部模型）
  const l3Items = [
    {
      label: l3DisableLabel,
      description: 'Skip L3 entirely — all large files truncated at semantic boundary',
      detail: 'Choose this if you have no MiniMax-M3 or want simpler behavior',
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
  const saved = await saveConfiguration(newRefs, aggKey, reconKey, l3Key);
  if (saved) {
    const parts = [
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

// ---------- end of file ----------

