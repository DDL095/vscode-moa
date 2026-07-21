/**
 * v0.22.0 P0-11: Environment Diagnostics
 *
 * moa.diagnoseEnvironment 命令实现 —— 验证 MoA 流水线依赖的 12 项信息源
 * 是否可获取。这是 v0.22.0 实施的"第一步",用于在落地任何注入逻辑前
 * 确认所有上游 API 都能正常工作。
 *
 * 12 项检查(对齐 docs/moa-role-customization-blueprint-v2.md §10):
 *   1.  Active editor           — vscode.window.activeTextEditor
 *   2.  Open documents          — vscode.workspace.textDocuments
 *   3.  Workspace folders       — vscode.workspace.workspaceFolders
 *   4.  Project tree            — fs.readdir(递归,depth=6/maxEntries=2000)
 *   5.  Git root                — child_process 'git rev-parse --show-toplevel'
 *   6.  Instruction files       — 7 路径(CLAUDE.md/AGENTS.md/copilot-instructions.md)
 *   7.  Skill folders           — 4 文件夹(.github/skills / .claude/skills /
 *                                  ~/.copilot/skills / ~/.claude/skills)
 *   8.  LM tools                — vscode.lm.tools
 *   9.  LM models               — vscode.lm.selectChatModels({})
 *   10. Active model preset     — presetConfig.getActivePresetConfig()
 *   11. Active role preset      — v0.22 P0-7 未实现时返回 'not implemented'
 *   12. MoA entry type          — v0.22 P0-1 未实现时返回 'N/A (no active task)'
 *
 * 输出:Markdown 报告(OutputChannel + untitled 文档)。
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { execSync } from 'child_process';
import { getActivePresetConfig } from './presetConfig';
import { EXTENSION_VERSION } from './extension';

// ─────────────────────────────────────────────────────────────────────────
// 类型定义
// ─────────────────────────────────────────────────────────────────────────

export type DiagnosticStatus = '✅' | '⚠️' | '❌';

export interface DiagnosticCheck {
  /** 检查项编号(1-12)。 */
  index: number;
  /** 检查项名称(英文,用于表格)。 */
  name: string;
  /** 状态:✅ ok / ⚠️ warning / ❌ error。 */
  status: DiagnosticStatus;
  /** 详情(已截断,避免过长)。 */
  detail: string;
  /** 耗时(ms)。 */
  elapsedMs?: number;
}

export interface DiagnosticReport {
  ranAt: Date;
  vscodeVersion: string;
  moaVersion: string;
  checks: DiagnosticCheck[];
  warnings: string[];
}

// ─────────────────────────────────────────────────────────────────────────
// 常量:7 路径指令文件 + 4 文件夹 skills
// ─────────────────────────────────────────────────────────────────────────

/** 7 路径指令文件(对齐 docs/roadmap/v0.22.0-role-injection-overhaul.md §P0-3)。 */
const INSTRUCTION_PATHS_WORKSPACE = [
  'CLAUDE.md',
  'CLAUDE.local.md',
  'AGENTS.md',
  '.claude/CLAUDE.md',
  '.github/copilot-instructions.md',
];

const INSTRUCTION_PATHS_HOME = ['.claude/CLAUDE.md', '.copilot/copilot-instructions.md'];

/** 4 文件夹 skills。 */
const SKILL_FOLDERS_WORKSPACE = ['.github/skills', '.claude/skills'];

const SKILL_FOLDERS_HOME = ['.copilot/skills', '.claude/skills'];

/** Project tree 参数(与 workspaceContext.ts 一致)。 */
const TREE_MAX_DEPTH = 6;
const TREE_MAX_ENTRIES = 2000;
const TREE_FILE_MAX_BYTES = 1024 * 1024;

/** Detail 字段最大长度(防止表格被超长路径撑爆)。 */
const DETAIL_MAX_LEN = 200;

// ─────────────────────────────────────────────────────────────────────────
// 主入口
// ─────────────────────────────────────────────────────────────────────────

/**
 * 运行 12 项环境诊断检查。
 *
 * 此函数是 pure function(无副作用),只读取信息源。调用方负责把返回的
 * `DiagnosticReport` 渲染到 OutputChannel / untitled 文档。
 *
 * 单一检查失败不会中断其他检查 —— 每项独立 try/catch。
 */
export async function diagnoseEnvironment(): Promise<DiagnosticReport> {
  const checks: DiagnosticCheck[] = [];
  const warnings: string[] = [];

  // 检查 1: Active editor
  checks.push(await timeCheck(1, 'Active editor', () => checkActiveEditor()));

  // 检查 2: Open documents
  checks.push(await timeCheck(2, 'Open documents', () => checkOpenDocuments()));

  // 检查 3: Workspace folders
  checks.push(await timeCheck(3, 'Workspace folders', () => checkWorkspaceFolders()));

  // 检查 4: Project tree
  checks.push(await timeCheck(4, 'Project tree', () => checkProjectTree()));

  // 检查 5: Git root
  checks.push(await timeCheck(5, 'Git root', () => checkGitRoot()));

  // 检查 6: Instruction files
  checks.push(await timeCheck(6, 'Instruction files', () => checkInstructionFiles()));

  // 检查 7: Skill folders
  checks.push(await timeCheck(7, 'Skill folders', () => checkSkillFolders()));

  // 检查 8: LM tools
  checks.push(await timeCheck(8, 'LM tools', () => checkLmTools()));

  // 检查 9: LM models
  checks.push(await timeCheck(9, 'LM models', () => checkLmModels()));

  // 检查 10: Active model preset
  checks.push(await timeCheck(10, 'Active model preset', () => checkActivePreset()));

  // 检查 11: Active role setup preset(P0-7 未实现时显示 'not implemented')
  checks.push(await timeCheck(11, 'Active role preset', () => checkActiveRolePreset()));

  // 检查 12: MoA entry type(P0-1 未实现时显示 'N/A')
  checks.push(await timeCheck(12, 'MoA entry type', () => checkMoaEntryType()));

  // 聚合 warnings
  for (const c of checks) {
    if (c.status === '⚠️') {
      warnings.push(`${c.name}: ${c.detail}`);
    }
  }

  return {
    ranAt: new Date(),
    vscodeVersion: vscode.version,
    moaVersion: EXTENSION_VERSION,
    checks,
    warnings,
  };
}

/** 包装:测量耗时 + 错误兜底(失败转 ❌)。 */
async function timeCheck(
  index: number,
  name: string,
  fn: () => DiagnosticCheck | Promise<DiagnosticCheck>
): Promise<DiagnosticCheck> {
  const start = Date.now();
  try {
    const result = await fn();
    return { ...result, index, name, elapsedMs: Date.now() - start };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      index,
      name,
      status: '❌',
      detail: truncate(`exception: ${msg}`),
      elapsedMs: Date.now() - start,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────
// 12 项检查实现
// ─────────────────────────────────────────────────────────────────────────

function checkActiveEditor(): DiagnosticCheck {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return { index: 1, name: 'Active editor', status: '⚠️', detail: '(no active editor)' };
  }
  const doc = editor.document;
  const lineCount = doc.lineCount;
  const relPath = workspaceRelative(doc.uri.fsPath) ?? doc.uri.fsPath;
  return {
    index: 1,
    name: 'Active editor',
    status: '✅',
    detail: truncate(`${relPath} (${doc.languageId}, ${lineCount} lines)`),
  };
}

function checkOpenDocuments(): DiagnosticCheck {
  const docs = vscode.workspace.textDocuments.filter((d) => d.uri.scheme === 'file');
  if (docs.length === 0) {
    return { index: 2, name: 'Open documents', status: '⚠️', detail: '(no file documents open)' };
  }
  const samplePaths = docs
    .slice(0, 3)
    .map((d) => workspaceRelative(d.uri.fsPath) ?? d.uri.fsPath)
    .join(', ');
  const suffix = docs.length > 3 ? `, +${docs.length - 3} more` : '';
  return {
    index: 2,
    name: 'Open documents',
    status: '✅',
    detail: truncate(`${docs.length} documents: ${samplePaths}${suffix}`),
  };
}

function checkWorkspaceFolders(): DiagnosticCheck {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return {
      index: 3,
      name: 'Workspace folders',
      status: '⚠️',
      detail: '(no workspace open — ENV_CONTEXT will be empty)',
    };
  }
  const names = folders.map((f) => path.basename(f.uri.fsPath)).join(', ');
  return {
    index: 3,
    name: 'Workspace folders',
    status: '✅',
    detail: truncate(`${folders.length} folder(s): ${names}`),
  };
}

function checkProjectTree(): DiagnosticCheck {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return {
      index: 4,
      name: 'Project tree',
      status: '⚠️',
      detail: '(skipped — no workspace)',
    };
  }
  const root = folders[0].uri.fsPath;
  let entryCount = 0;
  try {
    entryCount = countTreeEntries(root, 0);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { index: 4, name: 'Project tree', status: '❌', detail: truncate(`error: ${msg}`) };
  }
  return {
    index: 4,
    name: 'Project tree',
    status: entryCount > 0 ? '✅' : '⚠️',
    detail: truncate(`${entryCount} entries (depth≤${TREE_MAX_DEPTH}, cap=${TREE_MAX_ENTRIES})`),
  };
}

function checkGitRoot(): DiagnosticCheck {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return { index: 5, name: 'Git root', status: '⚠️', detail: '(skipped — no workspace)' };
  }
  const root = folders[0].uri.fsPath;
  try {
    const out = execSync('git rev-parse --show-toplevel', {
      cwd: root,
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return { index: 5, name: 'Git root', status: '✅', detail: truncate(out) };
  } catch {
    return {
      index: 5,
      name: 'Git root',
      status: '⚠️',
      detail: '(not a git repo or git not available)',
    };
  }
}

function checkInstructionFiles(): DiagnosticCheck {
  const found: string[] = [];
  const folders = vscode.workspace.workspaceFolders ?? [];

  // Workspace 路径(扫描所有 root,对齐设计文档"多 root workspace"决策)
  for (const folder of folders) {
    for (const rel of INSTRUCTION_PATHS_WORKSPACE) {
      const full = path.join(folder.uri.fsPath, rel);
      if (fs.existsSync(full)) {
        found.push(workspaceRelative(full) ?? full);
      }
    }
  }

  // Home 路径
  const home = os.homedir();
  for (const rel of INSTRUCTION_PATHS_HOME) {
    const full = path.join(home, rel);
    if (fs.existsSync(full)) {
      found.push(rel);
    }
  }

  if (found.length === 0) {
    return {
      index: 6,
      name: 'Instruction files',
      status: '⚠️',
      detail: '(none found — CUSTOM_INSTRUCTIONS will be empty)',
    };
  }
  return {
    index: 6,
    name: 'Instruction files',
    status: '✅',
    detail: truncate(`${found.length} found: ${found.join(', ')}`),
  };
}

function checkSkillFolders(): DiagnosticCheck {
  const found: Array<{ folder: string; count: number }> = [];
  const folders = vscode.workspace.workspaceFolders ?? [];
  const home = os.homedir();

  const allCandidates: string[] = [];
  for (const folder of folders) {
    for (const rel of SKILL_FOLDERS_WORKSPACE) {
      allCandidates.push(path.join(folder.uri.fsPath, rel));
    }
  }
  for (const rel of SKILL_FOLDERS_HOME) {
    allCandidates.push(path.join(home, rel));
  }

  let totalCount = 0;
  for (const candidate of allCandidates) {
    if (!fs.existsSync(candidate)) continue;
    const skills = listSkillsInFolder(candidate);
    if (skills.length === 0) continue;
    found.push({ folder: workspaceRelative(candidate) ?? candidate, count: skills.length });
    totalCount += skills.length;
  }

  if (found.length === 0) {
    return {
      index: 7,
      name: 'Skill folders',
      status: '⚠️',
      detail: '(no skill folders with SKILL.md found)',
    };
  }
  const summary = found.map((f) => `${f.folder}=${f.count}`).join(', ');
  return {
    index: 7,
    name: 'Skill folders',
    status: '✅',
    detail: truncate(`${totalCount} skills across ${found.length} folder(s): ${summary}`),
  };
}

async function checkLmTools(): Promise<DiagnosticCheck> {
  const tools = vscode.lm.tools;
  if (!tools || tools.length === 0) {
    return {
      index: 8,
      name: 'LM tools',
      status: '⚠️',
      detail: '(vscode.lm.tools is empty — tool_efficiency will have nothing to describe)',
    };
  }
  const moaCount = tools.filter((t) => t.name.startsWith('moa_')).length;
  return {
    index: 8,
    name: 'LM tools',
    status: '✅',
    detail: truncate(`${tools.length} tools (moa_*: ${moaCount})`),
  };
}

async function checkLmModels(): Promise<DiagnosticCheck> {
  try {
    const models = await vscode.lm.selectChatModels({});
    if (models.length === 0) {
      return {
        index: 9,
        name: 'LM models',
        status: '⚠️',
        detail: '(no chat models available — pipeline cannot run)',
      };
    }
    const vendorSet = new Set(models.map((m) => m.vendor));
    return {
      index: 9,
      name: 'LM models',
      status: '✅',
      detail: truncate(`${models.length} models from ${vendorSet.size} vendor(s)`),
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { index: 9, name: 'LM models', status: '❌', detail: truncate(`error: ${msg}`) };
  }
}

function checkActivePreset(): DiagnosticCheck {
  try {
    const cfg = getActivePresetConfig();
    if (cfg.isEmpty) {
      return {
        index: 10,
        name: 'Active model preset',
        status: '⚠️',
        detail: '(isEmpty — run "MoA: Configure Models" to set up)',
      };
    }
    const refCount = cfg.refModels.length;
    const agg = cfg.aggregator.model || '(fallback)';
    return {
      index: 10,
      name: 'Active model preset',
      status: '✅',
      detail: truncate(`${cfg.activeName}: refs=${refCount}, agg=${agg}`),
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      index: 10,
      name: 'Active model preset',
      status: '❌',
      detail: truncate(`error: ${msg}`),
    };
  }
}

/**
 * P0-7 未实现时,此检查返回 'not implemented'。
 * 待 P0-7 落地后,从 ~/.moa/role-setup-presets.json 读取 activePreset。
 */
function checkActiveRolePreset(): DiagnosticCheck {
  // TODO(v0.22 P0-7): replace with real lookup once roleSetupPreset.ts lands
  const presetFile = path.join(os.homedir(), '.moa', 'role-setup-presets.json');
  if (!fs.existsSync(presetFile)) {
    return {
      index: 11,
      name: 'Active role preset',
      status: '⚠️',
      detail: '(not configured — P0-7 default preset not yet created)',
    };
  }
  try {
    const content = fs.readFileSync(presetFile, 'utf8');
    const parsed = JSON.parse(content);
    const active = parsed.activePreset ?? '(unset)';
    return {
      index: 11,
      name: 'Active role preset',
      status: '✅',
      detail: truncate(`active=${active}`),
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      index: 11,
      name: 'Active role preset',
      status: '❌',
      detail: truncate(`error reading ${presetFile}: ${msg}`),
    };
  }
}

/**
 * P0-1 未实现时,MoA 入口类型在无 active task 时显示 'N/A'。
 * 待 P0-1 落地后,从 moaHandler.ts 的入口追踪器读取。
 */
function checkMoaEntryType(): DiagnosticCheck {
  // TODO(v0.22 P0-1): read from moaHandler entry tracker once implemented.
  return {
    index: 12,
    name: 'MoA entry type',
    status: '⚠️',
    detail: 'N/A (no active task — will be populated by P0-1)',
  };
}

// ─────────────────────────────────────────────────────────────────────────
// 工具函数
// ─────────────────────────────────────────────────────────────────────────

/** 截断字符串,超出部分用 '...' 表示。 */
function truncate(s: string, max = DETAIL_MAX_LEN): string {
  return s.length > max ? s.slice(0, max - 3) + '...' : s;
}

/** 转工作区相对路径(多 root workspace 时取第一个能匹配的)。 */
function workspaceRelative(fsPath: string): string | undefined {
  const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(fsPath));
  if (!folder) return undefined;
  const rel = path.relative(folder.uri.fsPath, fsPath);
  return rel || path.basename(fsPath);
}

/** 递归计算项目树节点数(与 workspaceContext.ts 同深度/上限)。 */
function countTreeEntries(dir: string, depth: number): number {
  if (depth >= TREE_MAX_DEPTH) return 0;
  let entries = fs.readdirSync(dir, { withFileTypes: true });
  // 排除常见噪音目录(node_modules / .git / dist)
  entries = entries.filter(
    (e) => !['node_modules', '.git', 'dist', '.moa_cache'].includes(e.name)
  );
  let count = 0;
  for (const e of entries) {
    count++;
    if (count >= TREE_MAX_ENTRIES) break;
    if (e.isDirectory()) {
      count += countTreeEntries(path.join(dir, e.name), depth + 1);
    }
  }
  return count;
}

/** 列出 skill 文件夹下的 SKILL.md(只数数量,不解析 frontmatter)。 */
function listSkillsInFolder(folder: string): string[] {
  try {
    const entries = fs.readdirSync(folder, { withFileTypes: true });
    const skills: string[] = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const skillMd = path.join(folder, e.name, 'SKILL.md');
      if (fs.existsSync(skillMd)) {
        skills.push(e.name);
      }
    }
    return skills;
  } catch {
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Markdown 渲染
// ─────────────────────────────────────────────────────────────────────────

/** 把 DiagnosticReport 渲染为 Markdown(用于 untitled 文档展示)。 */
export function renderDiagnosticReport(report: DiagnosticReport): string {
  const lines: string[] = [];
  lines.push('# MoA Environment Diagnostics');
  lines.push('');
  lines.push(`**运行时间**: ${formatTimestamp(report.ranAt)}`);
  lines.push(`**VSCode**: ${report.vscodeVersion}`);
  lines.push(`**MoA**: v${report.moaVersion}`);
  lines.push('');

  // 概览
  const okCount = report.checks.filter((c) => c.status === '✅').length;
  const warnCount = report.checks.filter((c) => c.status === '⚠️').length;
  const errCount = report.checks.filter((c) => c.status === '❌').length;
  lines.push(`## 概览: ${okCount} ✅  ${warnCount} ⚠️  ${errCount} ❌  (共 ${report.checks.length} 项)`);
  lines.push('');

  // 信息源验证表
  lines.push('## 信息源验证');
  lines.push('');
  lines.push('| # | 信息源 | 状态 | 耗时 | 详情 |');
  lines.push('|---|--------|------|------|------|');
  for (const c of report.checks) {
    const elapsed = c.elapsedMs !== undefined ? `${c.elapsedMs}ms` : '-';
    // 转义 markdown table 中的 pipe
    const detailEsc = c.detail.replace(/\|/g, '\\|');
    lines.push(`| ${c.index} | ${c.name} | ${c.status} | ${elapsed} | ${detailEsc} |`);
  }
  lines.push('');

  // 警告明细
  if (report.warnings.length > 0) {
    lines.push('## 警告明细');
    lines.push('');
    for (const w of report.warnings) {
      lines.push(`- ⚠️ ${w}`);
    }
    lines.push('');
  }

  // 解读提示
  lines.push('## 解读');
  lines.push('');
  lines.push('- ✅ = 信息源可获取,v0.22 注入逻辑可以正常工作');
  lines.push('- ⚠️ = 信息源缺失或为空,相关注入会是空字符串(不会报错,但效果受限)');
  lines.push('- ❌ = 信息源访问报错,需要修复后才能依赖该字段');
  lines.push('');
  lines.push('> 此报告由 `moa.diagnoseEnvironment` 命令生成(v0.22.0 P0-11)。');
  return lines.join('\n');
}

/** 格式化时间戳(对齐 moaLogUtils.formatLocalTimestamp 但简化)。 */
function formatTimestamp(d: Date): string {
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

// ─────────────────────────────────────────────────────────────────────────
// 命令注册
// ─────────────────────────────────────────────────────────────────────────

let _channel: vscode.OutputChannel | undefined;

function channel(): vscode.OutputChannel {
  if (!_channel) {
    _channel = vscode.window.createOutputChannel('MoA Environment Diagnostics');
  }
  return _channel;
}

/**
 * moa.diagnoseEnvironment 命令的入口。
 *
 * 行为:
 *   1. 跑 12 项检查
 *   2. 把 Markdown 报告写入 OutputChannel
 *   3. 同时把 Markdown 报告弹出到 untitled 文档(便于复制 / 搜索)
 *   4. 在 window.showInformationMessage 显示一句话总结
 */
export async function runDiagnoseEnvironmentCommand(): Promise<void> {
  const ch = channel();
  ch.appendLine('=== MoA Environment Diagnostics start ===');
  ch.appendLine(`started at ${new Date().toISOString()}`);

  let report: DiagnosticReport;
  try {
    report = await diagnoseEnvironment();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    ch.appendLine(`FATAL: diagnoseEnvironment threw: ${msg}`);
    void vscode.window.showErrorMessage(`MoA diagnostics failed: ${msg}`);
    return;
  }

  const markdown = renderDiagnosticReport(report);
  ch.appendLine(markdown);
  ch.appendLine('=== end ===');
  ch.show(true);

  // 弹出 untitled 文档(便于用户复制 / 截图分享)
  const doc = await vscode.workspace.openTextDocument({
    content: markdown,
    language: 'markdown',
  });
  await vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.Beside });

  // 一句话总结
  const okCount = report.checks.filter((c) => c.status === '✅').length;
  const warnCount = report.checks.filter((c) => c.status === '⚠️').length;
  const errCount = report.checks.filter((c) => c.status === '❌').length;
  const summary = `MoA Diagnostics: ${okCount} ✅ / ${warnCount} ⚠️ / ${errCount} ❌`;
  if (errCount > 0) {
    void vscode.window.showErrorMessage(summary + ' — see "MoA Environment Diagnostics" output');
  } else if (warnCount > 0) {
    void vscode.window.showWarningMessage(summary);
  } else {
    void vscode.window.showInformationMessage(summary);
  }
}
