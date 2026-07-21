/**
 * v0.22.0 P0-7: Role Setup Preset 系统（用户主权）
 *
 * 设计目标（docs/moa-role-customization-blueprint-v2.md §3 + §11）：
 *   - 用户主权：用户拥有 AI 角色的"身份定义"全权
 *   - 全局持久：~/.moa/role-setup-presets.json（不受 workspace 影响）
 *   - 与模型预设笛卡尔积组合：模型预设 × 角色设定预设 = N × M 组合
 *   - 1 default 预设（用户自行修改，无领域示例）
 *   - 6 命令：create / switch / edit / delete / export / import
 *   - AI 生成开关 3 层：enabled(默认 true) / autoAccept(默认 false) /
 *     confirmationUI(默认 'plan-mode')
 *   - JSON schema 校验失败：显示具体错误 + 保留编辑（IDE 风格）
 *
 * 三层分离（与 docs/moa-role-injection-design.md §4 对齐）：
 *   - 基础设施层（systemContext.ts）：客观事实
 *   - 角色身份层（本模块）：用户定义的 AI 身份
 *   - 迭代状态层（runPlanner/runRecon）：过程信息
 *
 * 角色身份层在 Planner 完成后渲染，注入到 Recon / Recon-Aggregator /
 * Actor 三个角色。Refs / Aggregator 完全不接受此层（架构红线）。
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ═════════════════════════════════════════════════════════════════════════
// 类型定义（对齐 blueprint-v2 §11 的 schema）
// ═════════════════════════════════════════════════════════════════════════

/** tone 限定枚举（7 选 1，架构红线：不接受自由文本）。 */
export type TonePreset =
  | 'strict-evidence'
  | 'faithful-integrator'
  | 'neutral-judge'
  | 'strict-executor'
  | 'creative-explorer'
  | 'conservative'
  | 'aggressive';

/** 单个角色的 role_setup 定义。 */
export interface RoleSetup {
  /** tone 限定枚举（必填）。 */
  tone: TonePreset;
  /** 自由文本视角描述（任意语言）。 */
  perspective: string;
  /** 工具/skill 优先级排序（推荐不限定，打猎哲学）。 */
  tool_priority?: string[];
  /** 注意事项（如破坏性操作前的提醒）。 */
  cautions?: string[];
  /** 仅 recon_aggregator 有：整合聚焦方向。 */
  focus?: string[];
}

/** 角色设定预设的完整 schema。 */
export interface RoleSetupPreset {
  /** preset 名称（用户自定义，唯一 key）。 */
  name: string;
  /** 描述（任意语言，UI 展示）。 */
  description: string;
  /** recon 角色身份。 */
  recon: RoleSetup;
  /** recon_aggregator 角色身份。 */
  recon_aggregator: RoleSetup;
  /** actor 角色身份。 */
  actor: RoleSetup;
  /** 用户自定义 few-shot 示例（默认空字符串）。 */
  few_shot_examples?: string;
  /** 元数据。 */
  meta?: {
    /** 创建时间 ISO 8601。 */
    created_at?: string;
    /** 最后修改时间 ISO 8601。 */
    updated_at?: string;
    /** 版本号（导入时检查）。 */
    schema_version?: string;
  };
}

/** 预设集合（name → preset）。 */
export type RoleSetupPresetMap = Record<string, RoleSetupPreset>;

/** 持久化文件的 schema。 */
interface PersistedStore {
  /** schema 版本（导入/导出校验用）。 */
  schema_version: string;
  /** 预设集合。 */
  presets: RoleSetupPresetMap;
  /** 当前激活的 preset name（独立于文件，存 settings.json）。 */
  // active 字段不存这里，从 settings 读取。
}

/** AI 生成开关 3 层。 */
export interface AIGenerationConfig {
  enabled: boolean;
  autoAccept: boolean;
  confirmationUI: 'plan-mode' | 'inline-preview' | 'none';
}

// ═════════════════════════════════════════════════════════════════════════
// 常量
// ═════════════════════════════════════════════════════════════════════════

/** schema 版本号（每次结构变更时 +1）。 */
const SCHEMA_VERSION = '0.22.0';

/** 持久化文件名。 */
const FILE_NAME = 'role-setup-presets.json';

/** active preset 存放在 vscode settings 的 key。 */
const SETTING_KEY_ACTIVE = 'moa.roleSetup.activePreset';

/** AI 生成开关的 settings prefix。 */
const SETTING_KEY_AI_GEN = 'moa.roleSetup.aiGeneration';

/** 默认 preset 名（不可删除）。 */
const DEFAULT_PRESET_NAME = 'default';

// ═════════════════════════════════════════════════════════════════════════
// 持久化路径：~/.moa/role-setup-presets.json
// ═════════════════════════════════════════════════════════════════════════

function getStorePath(): string {
  // 用户主目录下的 .moa/ 子目录
  const home = os.homedir();
  return path.join(home, '.moa', FILE_NAME);
}

function ensureStoreDir(storePath: string): void {
  const dir = path.dirname(storePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// ═════════════════════════════════════════════════════════════════════════
// 默认 preset：用户自行修改，无领域示例（设计决策 v3）
// ═════════════════════════════════════════════════════════════════════════

/**
 * 创建默认 preset —— 空模板，用户从零开始修改。
 *
 * 设计决策（用户原话 v3 修订）：
 *   "只有 1 个 default 预设（用户自行修改，无领域示例）"
 *   "用户第一次使用时被引导到 edit 命令修改 default"
 *
 * tone 选择中性默认值 'neutral-judge'，perspective 留空让用户填。
 */
export function createDefaultPreset(): RoleSetupPreset {
  const now = new Date().toISOString();
  return {
    name: DEFAULT_PRESET_NAME,
    description: '默认角色设定（用户自行修改以适配你的工作流）',
    recon: {
      tone: 'strict-evidence',
      perspective: '',
      tool_priority: [],
      cautions: [],
    },
    recon_aggregator: {
      tone: 'faithful-integrator',
      perspective: '',
      focus: ['去重', '识别与保留冲突', '缺口识别', '证据质量分级'],
    },
    actor: {
      tone: 'strict-executor',
      perspective: '',
      tool_priority: [],
      cautions: [],
    },
    few_shot_examples: '',
    meta: {
      created_at: now,
      updated_at: now,
      schema_version: SCHEMA_VERSION,
    },
  };
}

// ═════════════════════════════════════════════════════════════════════════
// 加载 / 保存
// ═════════════════════════════════════════════════════════════════════════

/**
 * 从 ~/.moa/role-setup-presets.json 加载所有 preset。
 * 文件不存在时返回空对象（首次使用）。
 *
 * 失败时不抛错，返回空对象 + warnings（调用方决定是否弹窗）。
 */
export function loadPresets(): { presets: RoleSetupPresetMap; warnings: string[] } {
  const storePath = getStorePath();
  const warnings: string[] = [];
  if (!fs.existsSync(storePath)) {
    return { presets: {}, warnings };
  }
  try {
    const raw = fs.readFileSync(storePath, 'utf8');
    const parsed = JSON.parse(raw) as PersistedStore;
    if (!parsed || typeof parsed !== 'object' || !parsed.presets) {
      warnings.push('role-setup-presets.json 顶层结构无效');
      return { presets: {}, warnings };
    }
    // schema_version 检查（warn 但不阻塞）
    if (parsed.schema_version && parsed.schema_version !== SCHEMA_VERSION) {
      warnings.push(
        `role-setup-presets.json schema_version=${parsed.schema_version}，` +
          `当前插件期望 ${SCHEMA_VERSION}。预设可能不兼容。`
      );
    }
    return { presets: parsed.presets, warnings };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    warnings.push(`role-setup-presets.json 解析失败：${msg}`);
    return { presets: {}, warnings };
  }
}

/**
 * 保存整个 preset 集合到磁盘。
 * 自动确保 ~/.moa/ 目录存在。
 */
export function savePresets(presets: RoleSetupPresetMap): { ok: boolean; error?: string } {
  const storePath = getStorePath();
  try {
    ensureStoreDir(storePath);
    const store: PersistedStore = {
      schema_version: SCHEMA_VERSION,
      presets,
    };
    fs.writeFileSync(storePath, JSON.stringify(store, null, 2), 'utf8');
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
}

// ═════════════════════════════════════════════════════════════════════════
// 初始化：确保 default 存在 + active 设置存在
// ═════════════════════════════════════════════════════════════════════════

/**
 * 模块级 init —— 扩展 activate 时调用一次。
 * 行为：
 *   1. 如果 ~/.moa/role-setup-presets.json 不存在 → 写入 default
 *   2. 如果存在但 default 不在 → 自动补 default（不覆盖用户预设）
 *   3. 如果 moa.roleSetup.activePreset 未设置 → 设为 'default'
 *   4. AI 生成开关初始化（仅设置不存在的项）
 *
 * 幂等：可重复调用，无副作用。
 */
export function initRoleSetupPresets(
  context: vscode.ExtensionContext
): { initialized: boolean; messages: string[] } {
  const messages: string[] = [];
  const { presets: existing, warnings } = loadPresets();
  warnings.forEach((w) => messages.push(`[warn] ${w}`));

  const presets: RoleSetupPresetMap = { ...existing };
  let modified = false;

  // 1+2: 确保 default 存在
  if (!presets[DEFAULT_PRESET_NAME]) {
    presets[DEFAULT_PRESET_NAME] = createDefaultPreset();
    modified = true;
    messages.push(`已创建默认 preset：${DEFAULT_PRESET_NAME}`);
  }

  if (modified) {
    const res = savePresets(presets);
    if (!res.ok) {
      messages.push(`[error] 保存 role-setup-presets.json 失败：${res.error}`);
      return { initialized: false, messages };
    }
  }

  // 3: active preset 设置
  const cfg = vscode.workspace.getConfiguration('moa');
  const active = cfg.get<string>('roleSetup.activePreset');
  if (!active || !presets[active]) {
    cfg.update('roleSetup.activePreset', DEFAULT_PRESET_NAME, vscode.ConfigurationTarget.Global);
    messages.push(`已设置 activePreset = ${DEFAULT_PRESET_NAME}`);
  }

  // 4: AI 生成开关初始化
  const aiGen = cfg.get<AIGenerationConfig>('roleSetup.aiGeneration');
  if (!aiGen) {
    cfg.update(
      'roleSetup.aiGeneration',
      { enabled: true, autoAccept: false, confirmationUI: 'plan-mode' },
      vscode.ConfigurationTarget.Global
    );
    messages.push('已初始化 AI 生成开关（enabled=true, autoAccept=false, confirmationUI=plan-mode）');
  }

  return { initialized: true, messages };
}

// ═════════════════════════════════════════════════════════════════════════
// 获取 / 切换 active preset
// ═════════════════════════════════════════════════════════════════════════

/**
 * 获取当前 active preset。
 * 不存在时返回 undefined（调用方应走 fallback）。
 */
export function getActivePreset(): RoleSetupPreset | undefined {
  const cfg = vscode.workspace.getConfiguration('moa');
  const activeName = cfg.get<string>('roleSetup.activePreset') ?? DEFAULT_PRESET_NAME;
  const { presets } = loadPresets();
  return presets[activeName];
}

/**
 * 切换到指定 preset。
 * 校验 preset 是否存在 + 是否合法（schema 校验）。
 */
export async function switchPreset(name: string): Promise<{ ok: boolean; error?: string }> {
  const { presets } = loadPresets();
  if (!presets[name]) {
    return { ok: false, error: `Preset "${name}" 不存在` };
  }
  const validation = validatePreset(presets[name]);
  if (!validation.ok) {
    return { ok: false, error: `Preset "${name}" schema 校验失败：${validation.error}` };
  }
  await vscode.workspace
    .getConfiguration('moa')
    .update('roleSetup.activePreset', name, vscode.ConfigurationTarget.Global);
  return { ok: true };
}

/**
 * 列出所有 preset 名称 + 简要描述。
 * 用于 QuickPick UI。
 */
export function listPresets(): Array<{ name: string; description: string; isActive: boolean }> {
  const cfg = vscode.workspace.getConfiguration('moa');
  const activeName = cfg.get<string>('roleSetup.activePreset') ?? DEFAULT_PRESET_NAME;
  const { presets } = loadPresets();
  return Object.values(presets).map((p) => ({
    name: p.name,
    description: p.description,
    isActive: p.name === activeName,
  }));
}

// ═════════════════════════════════════════════════════════════════════════
// Schema 校验
// ═════════════════════════════════════════════════════════════════════════

/** 合法 tone 集合。 */
const VALID_TONES: TonePreset[] = [
  'strict-evidence',
  'faithful-integrator',
  'neutral-judge',
  'strict-executor',
  'creative-explorer',
  'conservative',
  'aggressive',
];

/**
 * 校验单个 preset 的 schema。
 * 返回 ok=true 表示合法；ok=false 时 error 包含**具体字段错误**（IDE 风格）。
 *
 * 注意：Refs / Aggregator 的 role_setup 完全不接受（架构红线）。
 */
export function validatePreset(preset: unknown): { ok: boolean; error?: string } {
  if (!preset || typeof preset !== 'object') {
    return { ok: false, error: 'preset 不是对象' };
  }
  const p = preset as Partial<RoleSetupPreset>;
  if (typeof p.name !== 'string' || !p.name.trim()) {
    return { ok: false, error: 'name 缺失或为空' };
  }
  if (typeof p.description !== 'string') {
    return { ok: false, error: 'description 必须是字符串' };
  }
  for (const role of ['recon', 'recon_aggregator', 'actor'] as const) {
    const r = p[role];
    if (!r || typeof r !== 'object') {
      return { ok: false, error: `${role} 字段缺失` };
    }
    if (typeof r.tone !== 'string' || !VALID_TONES.includes(r.tone as TonePreset)) {
      return {
        ok: false,
        error: `${role}.tone 必须是 7 选 1（${VALID_TONES.join(' / ')}），当前值: ${JSON.stringify(r.tone)}`,
      };
    }
    if (typeof r.perspective !== 'string') {
      return { ok: false, error: `${role}.perspective 必须是字符串` };
    }
    if (r.tool_priority !== undefined && !Array.isArray(r.tool_priority)) {
      return { ok: false, error: `${role}.tool_priority 必须是字符串数组` };
    }
    if (r.cautions !== undefined && !Array.isArray(r.cautions)) {
      return { ok: false, error: `${role}.cautions 必须是字符串数组` };
    }
    if (role === 'recon_aggregator') {
      if (r.focus !== undefined && !Array.isArray(r.focus)) {
        return { ok: false, error: 'recon_aggregator.focus 必须是字符串数组' };
      }
    }
  }
  if (p.few_shot_examples !== undefined && typeof p.few_shot_examples !== 'string') {
    return { ok: false, error: 'few_shot_examples 必须是字符串' };
  }
  return { ok: true };
}

// ═════════════════════════════════════════════════════════════════════════
// 增删改
// ═════════════════════════════════════════════════════════════════════════

/** 创建新 preset（default 不可被同名覆盖）。 */
export function createPreset(preset: RoleSetupPreset): { ok: boolean; error?: string } {
  const validation = validatePreset(preset);
  if (!validation.ok) return { ok: false, error: validation.error };

  const { presets } = loadPresets();
  if (presets[preset.name]) {
    return { ok: false, error: `Preset "${preset.name}" 已存在，请用 edit 或换名` };
  }
  presets[preset.name] = { ...preset, meta: { ...preset.meta, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), schema_version: SCHEMA_VERSION } };
  return savePresets(presets);
}

/** 编辑已有 preset。 */
export function updatePreset(preset: RoleSetupPreset): { ok: boolean; error?: string } {
  const validation = validatePreset(preset);
  if (!validation.ok) return { ok: false, error: validation.error };

  const { presets } = loadPresets();
  if (!presets[preset.name]) {
    return { ok: false, error: `Preset "${preset.name}" 不存在，请用 create` };
  }
  presets[preset.name] = { ...preset, meta: { ...presets[preset.name].meta, ...preset.meta, updated_at: new Date().toISOString(), schema_version: SCHEMA_VERSION } };
  return savePresets(presets);
}

/**
 * 删除 preset。default 不可删除（架构决策）。
 */
export function deletePreset(name: string): { ok: boolean; error?: string } {
  if (name === DEFAULT_PRESET_NAME) {
    return { ok: false, error: `默认 preset "${DEFAULT_PRESET_NAME}" 不可删除（用户从零修改它即可）` };
  }
  const { presets } = loadPresets();
  if (!presets[name]) {
    return { ok: false, error: `Preset "${name}" 不存在` };
  }
  // 检查是否激活中
  const cfg = vscode.workspace.getConfiguration('moa');
  const active = cfg.get<string>('roleSetup.activePreset');
  if (active === name) {
    return { ok: false, error: `Preset "${name}" 当前正在使用，请先切换到其他 preset 再删除` };
  }
  delete presets[name];
  return savePresets(presets);
}

// ═════════════════════════════════════════════════════════════════════════
// 导入 / 导出（社区分享功能 v0.22 实施）
// ═════════════════════════════════════════════════════════════════════════

/**
 * 导出 preset 到 JSON 文件。用户选择目标路径。
 * 默认导出所有 preset；name 非空时导出单个。
 */
export async function exportPreset(
  name: string | null,
  targetUri: vscode.Uri
): Promise<{ ok: boolean; error?: string; count?: number }> {
  const { presets } = loadPresets();
  let toExport: RoleSetupPresetMap;
  if (name) {
    if (!presets[name]) return { ok: false, error: `Preset "${name}" 不存在` };
    toExport = { [name]: presets[name] };
  } else {
    toExport = presets;
  }
  try {
    const payload = {
      schema_version: SCHEMA_VERSION,
      exported_at: new Date().toISOString(),
      presets: toExport,
    };
    await vscode.workspace.fs.writeFile(targetUri, Buffer.from(JSON.stringify(payload, null, 2), 'utf8'));
    return { ok: true, count: Object.keys(toExport).length };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
}

/**
 * 从 JSON 文件导入 preset。
 * 策略：同名 preset 跳过（不覆盖用户已有数据），返回 imported/skipped 列表。
 */
export async function importPreset(
  sourceUri: vscode.Uri
): Promise<{ ok: boolean; error?: string; imported?: string[]; skipped?: string[] }> {
  try {
    const bytes = await vscode.workspace.fs.readFile(sourceUri);
    const raw = Buffer.from(bytes).toString('utf8');
    const parsed = JSON.parse(raw) as { presets?: RoleSetupPresetMap } & Record<string, unknown>;
    if (!parsed.presets || typeof parsed.presets !== 'object') {
      return { ok: false, error: '导入文件不含 presets 字段' };
    }
    const { presets: existing } = loadPresets();
    const imported: string[] = [];
    const skipped: string[] = [];
    for (const [k, v] of Object.entries(parsed.presets)) {
      const validation = validatePreset(v);
      if (!validation.ok) {
        skipped.push(`${k}（${validation.error}）`);
        continue;
      }
      if (existing[k]) {
        skipped.push(`${k}（已存在，跳过）`);
        continue;
      }
      existing[k] = v;
      imported.push(k);
    }
    if (imported.length > 0) {
      const save = savePresets(existing);
      if (!save.ok) return { ok: false, error: save.error };
    }
    return { ok: true, imported, skipped };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
}

// ═════════════════════════════════════════════════════════════════════════
// 渲染：把 RoleSetup 渲染成可注入 prompt 的文本（角色身份层）
// ═════════════════════════════════════════════════════════════════════════

/**
 * 渲染 RoleSetup → 可注入 prompt 的纯文本。
 *
 * 用法（对齐 blueprint-v2 §4.2 矩阵）：
 *   - Planner 完成后，moaOrchestrator 把 role_setup.recon 传给 callRecon
 *   - callRecon 把 roleSetupText 透传给 buildReconPrompt
 *   - buildReconPrompt 把 roleSetupText 拼到 system prompt 顶部
 *
 * 渲染格式：
 *   ## Role Setup (用户自定义)
 *   - **tone**: strict-evidence
 *   - **perspective**: ...
 *   - **tool_priority**: [tool1, tool2]
 *   - **cautions**: [...]
 */
export function renderRoleSetup(setup: RoleSetup): string {
  const lines: string[] = ['## Role Setup (用户自定义 / User-defined)', ''];
  lines.push(`- **tone**: ${setup.tone}`);
  if (setup.perspective.trim()) {
    lines.push(`- **perspective**: ${setup.perspective.trim()}`);
  }
  if (setup.tool_priority && setup.tool_priority.length > 0) {
    lines.push(`- **tool_priority** (排序后的推荐列表):`);
    setup.tool_priority.forEach((t, i) => lines.push(`  ${i + 1}. ${t}`));
  }
  if (setup.cautions && setup.cautions.length > 0) {
    lines.push(`- **cautions**: ${setup.cautions.map((c) => `"${c}"`).join(', ')}`);
  }
  if (setup.focus && setup.focus.length > 0) {
    lines.push(`- **focus** (recon_aggregator 整合方向): ${setup.focus.join(' / ')}`);
  }
  return lines.join('\n');
}

/**
 * 渲染 few-shot 示例（默认空字符串）。
 */
export function renderFewShots(preset: RoleSetupPreset | undefined): string {
  if (!preset || !preset.few_shot_examples) return '';
  return preset.few_shot_examples;
}

// ═════════════════════════════════════════════════════════════════════════
// AI 生成开关读取
// ═════════════════════════════════════════════════════════════════════════

/** 读取 AI 生成开关（带默认值）。 */
export function getAIGenerationConfig(): AIGenerationConfig {
  const cfg = vscode.workspace.getConfiguration('moa');
  const raw = cfg.get<AIGenerationConfig>('roleSetup.aiGeneration');
  return {
    enabled: raw?.enabled ?? true,
    autoAccept: raw?.autoAccept ?? false,
    confirmationUI: raw?.confirmationUI ?? 'plan-mode',
  };
}

// ═════════════════════════════════════════════════════════════════════════
// untitled 文档编辑（IDE 风格）
// ═════════════════════════════════════════════════════════════════════════

/**
 * 在 untitled 文档中打开 preset JSON 让用户编辑。
 *
 * 设计决策（用户原话 v3 修订）：
 *   "JSON schema 校验失败时显示具体错误 + 保留编辑不强制保存（IDE 风格）"
 *   用户主动 ctrl+s 时：
 *     - 通过 validatePreset → 保存到磁盘
 *     - 失败 → 弹窗显示错误，文档保持打开（不覆盖、不丢用户编辑）
 *
 * 返回：用户关闭文档时 resolve（无需等待保存）。
 */
export async function openPresetForEdit(name: string): Promise<{ opened: boolean; error?: string }> {
  const { presets } = loadPresets();
  const preset = presets[name];
  if (!preset) return { opened: false, error: `Preset "${name}" 不存在` };

  const doc = await vscode.workspace.openTextDocument({
    content: JSON.stringify(preset, null, 2),
    language: 'json',
  });
  await vscode.window.showTextDocument(doc, { preview: false });

  // 注册一次性保存监听器（用户按 ctrl+s 时尝试更新）
  const sub = vscode.workspace.onDidSaveTextDocument(async (saved) => {
    if (saved.uri.toString() !== doc.uri.toString()) return;
    try {
      const newPreset = JSON.parse(saved.getText()) as RoleSetupPreset;
      // 保持 name 不变（用户不应在编辑中改名）
      newPreset.name = name;
      const result = updatePreset(newPreset);
      if (result.ok) {
        vscode.window.showInformationMessage(`Preset "${name}" 已更新`);
        sub.dispose();
      } else {
        // IDE 风格：保留编辑，显示错误
        const choice = await vscode.window.showErrorMessage(
          `Preset schema 校验失败：${result.error}`,
          '继续编辑',
          '放弃修改'
        );
        if (choice === '放弃修改') {
          await vscode.commands.executeCommand('workbench.action.revertResource', saved.uri);
          sub.dispose();
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`JSON 解析失败：${msg}`);
    }
  });

  return { opened: true };
}
