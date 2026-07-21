/**
 * v0.22.0 P0-3: Instruction & Skill Scanner
 *
 * 扫描 v0.22.0 注入体系依赖的 2 类信息源:
 *
 *   1. 指令文件(7 路径,**不截断**全量读取):
 *      Workspace(每个 root 都扫):
 *        ./CLAUDE.md
 *        ./CLAUDE.local.md
 *        ./AGENTS.md
 *        ./.claude/CLAUDE.md
 *        ./.github/copilot-instructions.md
 *      Home:
 *        ~/.claude/CLAUDE.md
 *        ~/.copilot/copilot-instructions.md
 *
 *   2. Skills(4 文件夹,只读 SKILL.md frontmatter):
 *      Workspace:
 *        ./.github/skills
 *        ./.claude/skills
 *      Home:
 *        ~/.copilot/skills
 *        ~/.claude/skills
 *
 * 安全考虑(对齐设计文档 §P0-3):
 *   - 单文件 > 200KB 时仍传入(不截断),但在 InstructionFile.flaggedLarge=true
 *     给上层 Planner 警告
 *   - 检测疑似敏感信息(常见 API key / token 格式),在 InstructionFile.flaggedSensitive=true
 *     给上层警告(不删减内容)
 *   - 不递归读取 skill 内的脚本文件(只读 SKILL.md)
 *
 * 缓存(对齐设计文档 §P0-3):
 *   - 按 (path, mtimeMs) 缓存文件内容
 *   - mtime 未变则用缓存,避免重复 I/O
 *   - 任务级缓存(单例,不跨任务持久)
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

// ─────────────────────────────────────────────────────────────────────────
// 常量
// ─────────────────────────────────────────────────────────────────────────

const INSTRUCTION_PATHS_WORKSPACE = [
  'CLAUDE.md',
  'CLAUDE.local.md',
  'AGENTS.md',
  '.claude/CLAUDE.md',
  '.github/copilot-instructions.md',
] as const;

const INSTRUCTION_PATHS_HOME = ['.claude/CLAUDE.md', '.copilot/copilot-instructions.md'] as const;

const SKILL_FOLDERS_WORKSPACE = ['.github/skills', '.claude/skills'] as const;

const SKILL_FOLDERS_HOME = ['.copilot/skills', '.claude/skills'] as const;

/** 单文件超过此阈值(200KB)时标记 flaggedLarge(但内容仍传入)。 */
const LARGE_FILE_THRESHOLD = 200 * 1024;

/**
 * 敏感信息检测正则(常见 API key / token 格式)。
 * 仅做粗粒度检测(避免误报),命中后在 InstructionFile.flaggedSensitive=true。
 * 不删减内容 —— 让 Planner 自己决定如何处理。
 */
const SENSITIVE_PATTERNS: RegExp[] = [
  /(?:sk|pk|rk)_[a-zA-Z0-9]{20,}/i, // OpenAI-style keys (sk-...)
  /(?:ghp|gho|ghu|ghs|ghr)_[a-zA-Z0-9]{36,}/i, // GitHub tokens
  /(?:AKIA|ASIA)[A-Z0-9]{16,}/, // AWS access keys
  /(?:xox[bpoa])-[a-zA-Z0-9-]{10,}/i, // Slack tokens
  /(?:api[_-]?key|secret|token|password)\s*[:=]\s*["'][A-Za-z0-9+/=_-]{16,}["']/i, // generic key=value
];

// ─────────────────────────────────────────────────────────────────────────
// 类型定义
// ─────────────────────────────────────────────────────────────────────────

export interface InstructionFile {
  /** 完整绝对路径。 */
  path: string;
  /** Workspace 相对路径(若可计算);home 路径则用 '~/' 前缀。 */
  relativePath: string;
  /** 文件大小(KB)。 */
  sizeKb: number;
  /** 来源:workspace 级还是 home 级。 */
  source: 'workspace' | 'home';
  /** 完整内容(**不截断**)。 */
  content: string;
  /** 是否大于 LARGE_FILE_THRESHOLD(给上层警告用)。 */
  flaggedLarge: boolean;
  /** 是否疑似含敏感信息(给上层警告用,不删减)。 */
  flaggedSensitive: boolean;
  /** 命中的敏感信息模式描述(若 flaggedSensitive=true)。 */
  sensitiveMatches: string[];
}

export interface SkillEntry {
  /** Skill 名称(从 frontmatter 的 name 字段,或目录名 fallback)。 */
  name: string;
  /** Skill 描述(从 frontmatter 的 description 字段)。 */
  description: string;
  /** Skill 文件夹的完整路径。 */
  folder: string;
  /** 是否含 scripts/ 子目录。 */
  hasScripts: boolean;
}

export interface ScanResult {
  /** 扫描到的指令文件(已去重)。 */
  instructions: InstructionFile[];
  /** 扫描到的 skills。 */
  skills: SkillEntry[];
  /** 扫描耗时(ms)。 */
  scanDurationMs: number;
  /** 警告(给上层报告用)。 */
  warnings: string[];
}

// ─────────────────────────────────────────────────────────────────────────
// mtime 缓存(任务级单例)
// ─────────────────────────────────────────────────────────────────────────

interface CacheEntry {
  mtimeMs: number;
  content: string;
  size: number;
}

/** key = 文件绝对路径,value = { mtimeMs, content, size }。 */
const _contentCache = new Map<string, CacheEntry>();

/** 清空缓存(任务切换时调用,避免长寿命进程内存累积)。 */
export function clearScanCache(): void {
  _contentCache.clear();
}

/**
 * 读文件(带 mtime 缓存)。
 *
 * 缓存命中条件:mtimeMs 与缓存一致。
 * 不存在 / 读失败时返回 undefined(不抛错,由上层决定如何处理)。
 */
function readWithMtimeCache(absPath: string): { content: string; size: number } | undefined {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(absPath);
  } catch {
    return undefined;
  }
  if (!stat.isFile()) return undefined;

  const cached = _contentCache.get(absPath);
  if (cached && cached.mtimeMs === stat.mtimeMs) {
    return { content: cached.content, size: cached.size };
  }

  // 未命中缓存,重新读
  try {
    const content = fs.readFileSync(absPath, 'utf8');
    _contentCache.set(absPath, { mtimeMs: stat.mtimeMs, content, size: stat.size });
    return { content, size: stat.size };
  } catch {
    return undefined;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// SKILL.md frontmatter 解析(轻量,不引第三方 yaml 库)
// ─────────────────────────────────────────────────────────────────────────

/**
 * 从 SKILL.md 内容解析 name + description(只看 frontmatter 块)。
 *
 * SKILL.md 结构:
 *   ---
 *   name: foo-skill
 *   description: ...
 *   ---
 *   (body)
 *
 * 只解析 frontmatter 的 name / description 两字段。
 * 解析失败时返回 { name: undefined, description: undefined }(上层 fallback 到目录名)。
 */
function parseSkillFrontmatter(content: string): { name?: string; description?: string } {
  // 匹配开头的 --- ... --- 块
  const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
  if (!fmMatch) return {};
  const fmText = fmMatch[1];

  let name: string | undefined;
  let description: string | undefined;

  // name: 单行
  const nameMatch = fmText.match(/^name:\s*(.+?)\s*$/m);
  if (nameMatch) {
    name = nameMatch[1].replace(/^["']|["']$/g, '').trim();
  }

  // description: 可能跨行(YAML 的 >- / > / |- / | 块)
  const descMatch = fmText.match(/^description:\s*(.+?)(?=\n[a-zA-Z_-]+:|\n---|\n\.\.\.|$)/ms);
  if (descMatch) {
    let raw = descMatch[1].trim();
    // 块标量 >- / > / |- / |
    if (/^(>-|>|-|\|)\s*\n/.test(raw)) {
      // 取后续缩进行
      const lines = raw.split('\n').slice(1);
      const body = lines
        .map((l) => l.replace(/^\s+/, ''))
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      description = body;
    } else {
      description = raw.replace(/^["']|["']$/g, '').trim();
    }
  }

  return { name, description };
}

// ─────────────────────────────────────────────────────────────────────────
// 扫描主入口
// ─────────────────────────────────────────────────────────────────────────

/**
 * 扫描指令文件 + skills。
 *
 * 此函数是 pure(无副作用,只读 fs + 更新内部缓存)。
 * 调用方负责把返回的 ScanResult 渲染为注入字符串。
 */
export async function scanInstructionsAndSkills(): Promise<ScanResult> {
  const start = Date.now();
  const warnings: string[] = [];
  const instructions: InstructionFile[] = [];
  const skills: SkillEntry[] = [];

  // ---- 指令文件:workspace(每个 root 都扫) ----
  const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
  for (const folder of workspaceFolders) {
    for (const rel of INSTRUCTION_PATHS_WORKSPACE) {
      const abs = path.join(folder.uri.fsPath, rel);
      const file = readInstructionFile(abs, 'workspace');
      if (file) {
        instructions.push(file);
        if (file.flaggedLarge) {
          warnings.push(
            `Instruction file ${file.relativePath} is large (${file.sizeKb} KB) — still injected untruncated.`
          );
        }
        if (file.flaggedSensitive) {
          warnings.push(
            `Instruction file ${file.relativePath} may contain sensitive info (matched: ${file.sensitiveMatches.join(', ')}) — NOT redacted, review the file.`
          );
        }
      }
    }
  }

  // ---- 指令文件:home ----
  const home = os.homedir();
  for (const rel of INSTRUCTION_PATHS_HOME) {
    const abs = path.join(home, rel);
    const file = readInstructionFile(abs, 'home');
    if (file) {
      instructions.push(file);
      if (file.flaggedLarge) {
        warnings.push(
          `Instruction file ${file.relativePath} is large (${file.sizeKb} KB) — still injected untruncated.`
        );
      }
      if (file.flaggedSensitive) {
        warnings.push(
          `Instruction file ${file.relativePath} may contain sensitive info (matched: ${file.sensitiveMatches.join(', ')}) — NOT redacted, review the file.`
        );
      }
    }
  }

  // ---- Skills ----
  const skillFolderCandidates: Array<{ abs: string; isWorkspace: boolean }> = [];
  for (const folder of workspaceFolders) {
    for (const rel of SKILL_FOLDERS_WORKSPACE) {
      skillFolderCandidates.push({ abs: path.join(folder.uri.fsPath, rel), isWorkspace: true });
    }
  }
  for (const rel of SKILL_FOLDERS_HOME) {
    skillFolderCandidates.push({ abs: path.join(home, rel), isWorkspace: false });
  }

  const seenSkillNames = new Set<string>();
  for (const candidate of skillFolderCandidates) {
    if (!fs.existsSync(candidate.abs)) continue;
    const stats = safeListDir(candidate.abs);
    for (const sub of stats) {
      const skillMdPath = path.join(candidate.abs, sub);
      const skill = readSkillEntry(skillMdPath, sub);
      if (!skill) continue;
      // 跨文件夹去重(同 name 优先保留第一个)
      if (seenSkillNames.has(skill.name)) continue;
      seenSkillNames.add(skill.name);
      skills.push(skill);
    }
  }

  return {
    instructions,
    skills,
    scanDurationMs: Date.now() - start,
    warnings,
  };
}

/** 读单个指令文件(已应用 mtime 缓存 + 敏感信息检测)。 */
function readInstructionFile(
  absPath: string,
  source: 'workspace' | 'home'
): InstructionFile | undefined {
  const data = readWithMtimeCache(absPath);
  if (!data) return undefined;

  const relativePath = computeRelativePath(absPath, source);
  const sizeKb = Math.round(data.size / 1024);
  const flaggedLarge = data.size > LARGE_FILE_THRESHOLD;
  const sensitiveMatches: string[] = [];
  for (const pat of SENSITIVE_PATTERNS) {
    const m = data.content.match(pat);
    if (m) {
      sensitiveMatches.push(m[0].slice(0, 40) + (m[0].length > 40 ? '...' : ''));
    }
  }
  return {
    path: absPath,
    relativePath,
    sizeKb,
    source,
    content: data.content,
    flaggedLarge,
    flaggedSensitive: sensitiveMatches.length > 0,
    sensitiveMatches,
  };
}

/** 读单个 skill 文件夹下的 SKILL.md。 */
function readSkillEntry(skillMdAbs: string, fallbackName: string): SkillEntry | undefined {
  const data = readWithMtimeCache(skillMdAbs);
  if (!data) return undefined;
  const { name, description } = parseSkillFrontmatter(data.content);
  const folder = path.dirname(skillMdAbs);
  let hasScripts = false;
  try {
    hasScripts = fs.existsSync(path.join(folder, 'scripts')) &&
      fs.statSync(path.join(folder, 'scripts')).isDirectory();
  } catch {
    hasScripts = false;
  }
  return {
    name: name ?? fallbackName,
    description: description ?? '(no description in SKILL.md frontmatter)',
    folder,
    hasScripts,
  };
}

/** 安全列目录(返回子目录名列表,排除隐藏目录)。 */
function safeListDir(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/** 计算 InstructionFile 的 relativePath。 */
function computeRelativePath(absPath: string, source: 'workspace' | 'home'): string {
  if (source === 'home') {
    const home = os.homedir();
    if (absPath.startsWith(home)) {
      return '~' + absPath.slice(home.length).replace(/\\/g, '/');
    }
    return absPath;
  }
  // workspace
  const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(absPath));
  if (folder) {
    const rel = path.relative(folder.uri.fsPath, absPath);
    return rel.replace(/\\/g, '/') || path.basename(absPath);
  }
  return absPath;
}

// ─────────────────────────────────────────────────────────────────────────
// 渲染为注入字符串
// ─────────────────────────────────────────────────────────────────────────

/**
 * 把扫描结果渲染为 `${CUSTOM_INSTRUCTIONS}` 注入字符串。
 *
 * 设计原则(对齐用户原话"instruction 文件不要截断"):
 *   - 完整内容传入
 *   - 多个文件按 source 顺序排列(workspace 优先 → home)
 *   - 每个文件用 `=== <relativePath> ===` 头部
 *   - 末尾附 sensitive 警告(若有)
 */
export function renderCustomInstructions(scan: ScanResult): string {
  if (scan.instructions.length === 0) {
    return '(no instruction files found in the 7 standard paths)';
  }
  // 排序:workspace 优先,然后按 relativePath 字典序
  const sorted = [...scan.instructions].sort((a, b) => {
    if (a.source !== b.source) return a.source === 'workspace' ? -1 : 1;
    return a.relativePath.localeCompare(b.relativePath);
  });

  const parts: string[] = [];
  parts.push(`Found ${sorted.length} instruction file(s):`);
  for (const f of sorted) {
    parts.push('');
    parts.push(`=== ${f.relativePath} (${f.sizeKb} KB${f.flaggedLarge ? ', LARGE' : ''}${f.flaggedSensitive ? ', SENSITIVE?' : ''}) ===`);
    parts.push(f.content);
  }

  // 警告(若有)
  if (scan.warnings.length > 0) {
    parts.push('');
    parts.push('=== WARNINGS ===');
    for (const w of scan.warnings) {
      parts.push(`- ${w}`);
    }
  }
  return parts.join('\n');
}

/**
 * 把扫描结果渲染为 `${RUNTIME_INSTRUCTIONS}` 注入字符串。
 *
 * 设计原则:
 *   - 每个 skill 一行(name + description)
 *   - description 截断到 ~200 字符(避免单条过长撑爆 prompt)
 *   - 按 name 字典序排序(便于用户对照)
 */
export function renderRuntimeInstructions(scan: ScanResult): string {
  if (scan.skills.length === 0) {
    return '(no skills found in the 4 standard folders)';
  }
  const sorted = [...scan.skills].sort((a, b) => a.name.localeCompare(b.name));
  const parts: string[] = [];
  parts.push(`Available skills (${sorted.length}):`);
  for (const s of sorted) {
    const desc = truncateLine(s.description, 200);
    const scriptTag = s.hasScripts ? ' [has scripts]' : '';
    parts.push(`- ${s.name}${scriptTag}: ${desc}`);
  }
  return parts.join('\n');
}

/** 截断单行字符串到 max 字符。 */
function truncateLine(s: string, max: number): string {
  const oneLine = s.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? oneLine.slice(0, max - 3) + '...' : oneLine;
}
