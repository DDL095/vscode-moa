/**
 * v0.22.0 P0-2: System Context Builder(基础设施层注入)
 *
 * 4 段动态注入的统一入口:
 *
 *   1. ENV_CONTEXT          — workspaceContext.ts 扩展(activeFile + openDocs + tree + gitRoot + instructionFiles 概览)
 *   2. TOOL_EFFICIENCY      — 静态模板(工具调用纪律)
 *   3. CUSTOM_INSTRUCTIONS  — 7 路径 CLAUDE.md/AGENTS.md/copilot-instructions.md(**不截断**)
 *   4. RUNTIME_INSTRUCTIONS — 4 文件夹 SKILL.md frontmatter(name + description)
 *
 * 三层分离(对齐 docs/moa-role-injection-design.md §4):
 *   - 基础设施层(本模块):客观事实(env/tools/custom/runtime)
 *   - 角色身份层(roles.ts):Planner 产出的 role_setup
 *   - 迭代状态层(runPlanner.ts/runRecon.ts):iter / evidence / gaps
 *
 * 角色矩阵(对齐设计文档 §4.2):
 *   - Planner / Recon / Actor  →  看完整 4 段
 *   - Refs / Aggregator        →  完全不看(固定设定,保证多模型可比性 + 中立裁判)
 *   - recon_aggregator         →  完全不看(纯整合者)
 *
 * 缓存:
 *   - 同一任务内 SystemContext 复用(moaOrchestrator.ts 在 iter 1 构建,后续 iter 传入)
 *   - 任务结束调用 clearScanCache() 清空 instructionScanner 缓存
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { execSync } from 'child_process';
import {
  buildWorkspaceContext,
  renderWorkspaceContext,
  type WorkspaceContext,
} from './workspaceContext';
import {
  scanInstructionsAndSkills,
  renderCustomInstructions,
  renderRuntimeInstructions,
  clearScanCache,
  type ScanResult,
} from './instructionScanner';

// ─────────────────────────────────────────────────────────────────────────
// 类型定义
// ─────────────────────────────────────────────────────────────────────────

export interface SystemContext {
  /** 基础设施层 4 段原始内容。 */
  envContext: string;
  toolEfficiency: string;
  customInstructions: string;
  runtimeInstructions: string;
  /** 用于诊断 / 日志:每段长度。 */
  sizes: {
    envContext: number;
    toolEfficiency: number;
    customInstructions: number;
    runtimeInstructions: number;
  };
  /** 用于诊断:扫描耗时(ms)。 */
  scanDurationMs: number;
  /** 用于诊断:扫描到的指令文件 + skills 数量。 */
  instructionCount: number;
  skillCount: number;
  /** 扫描时的警告(上层可写入日志)。 */
  warnings: string[];
}

// ─────────────────────────────────────────────────────────────────────────
// 静态模板:TOOL_EFFICIENCY
// ─────────────────────────────────────────────────────────────────────────

/**
 * TOOL_EFFICIENCY 静态模板(对齐 docs/moa-role-injection-design.md §3.3 的
 * "类似 tool_efficiency 的章节")。
 *
 * 这段是从 v0.21.x 的 roles.ts buildReconPrompt L195-235 提炼的"工具调用纪律",
 * 现在作为基础设施层独立注入(不再硬编码在 roles.ts)。
 *
 * 用户原话:"tool_efficiency 是要的(MoA 自拼模板)"。
 */
export const TOOL_EFFICIENCY_TEMPLATE = `=== TOOL EFFICIENCY ===

工具调用纪律(从 v0.21.x Recon 提示词提炼,所有调工具的角色共用):

1. **agent 化,灵活调用**:你拥有工具调用权(通过 vscode.lm.tools),根据现场
   判断调哪些工具。不要僵化套模板,不要等指令才调,该调就调。

2. **批处理与并行**:
   - 一次性把所需的多个文件读完(不要 for 循环单文件读)
   - 一次性的多个独立查询 → 用 array-of-tool-calls 形式并行
   - 避免串行调用(每个工具调用都是一个 LLM turn,串行 = 多倍延迟)

3. **避免重复查**:
   - 已读过的文件不要重复读(用记忆/上下文判断)
   - 已搜过的 grep 模式不要重复搜
   - 已查过的 URL 不要重复 fetch

4. **饱和即停(但不要过早停)**:
   - 连续 3 次工具调用无新增信息 → 视为"信息已饱和",停止工具调用
   - 但首次工具调用前不要因"可能找不到"而放弃
   - 若证据明显不完整(Aggregator 给的 gaps 清单未覆盖),继续查

5. **不要假装调用了工具**:你的所有工具调用都会被系统记录(在 evidence 池),
   不要在 summary 里编造未实际调用的工具结果。

=== END TOOL EFFICIENCY ===`;

// ─────────────────────────────────────────────────────────────────────────
// 主入口:buildSystemContext
// ─────────────────────────────────────────────────────────────────────────

/**
 * 构建完整的 SystemContext(4 段动态注入)。
 *
 * 调用时机:任务启动时构建一次(moaOrchestrator.ts 在 iter 1 调用),
 * 之后跨 mini-loop / 跨 iteration 复用同一实例。
 *
 * 失败处理:每段独立 try/catch,失败段返回"(unavailable: <error>)"字符串,
 * 不影响其他段构建。
 */
export async function buildSystemContext(): Promise<SystemContext> {
  const start = Date.now();
  const warnings: string[] = [];

  // 1. ENV_CONTEXT(workspaceContext + gitRoot + instructionFiles 概览)
  let workspace: WorkspaceContext;
  let gitRoot: string | undefined;
  try {
    workspace = await buildWorkspaceContext();
    gitRoot = detectGitRoot();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    warnings.push(`ENV_CONTEXT build failed: ${msg}`);
    workspace = { openDocuments: [], workspaceFolders: [] };
  }

  // 2. 扫描指令文件 + skills
  let scan: ScanResult;
  try {
    scan = await scanInstructionsAndSkills();
    warnings.push(...scan.warnings);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    warnings.push(`scanInstructionsAndSkills failed: ${msg}`);
    scan = {
      instructions: [],
      skills: [],
      scanDurationMs: 0,
      warnings: [],
    };
  }

  // 3. 渲染各段
  const envContext = renderEnvContextExtended(workspace, gitRoot, scan);
  const toolEfficiency = TOOL_EFFICIENCY_TEMPLATE;
  const customInstructions = renderCustomInstructions(scan);
  const runtimeInstructions = renderRuntimeInstructions(scan);

  return {
    envContext,
    toolEfficiency,
    customInstructions,
    runtimeInstructions,
    sizes: {
      envContext: envContext.length,
      toolEfficiency: toolEfficiency.length,
      customInstructions: customInstructions.length,
      runtimeInstructions: runtimeInstructions.length,
    },
    scanDurationMs: Date.now() - start,
    instructionCount: scan.instructions.length,
    skillCount: scan.skills.length,
    warnings,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// 渲染:ENV_CONTEXT 扩展(workspace + git + instruction 概览)
// ─────────────────────────────────────────────────────────────────────────

/**
 * 渲染扩展版 ENV_CONTEXT。
 *
 * 与 workspaceContext.ts 的 renderWorkspaceContext 相比,新增:
 *   - gitRoot(若检测到)
 *   - instructionFiles 概览(只列名 + 大小,不重复完整内容 —— 完整内容在 CUSTOM_INSTRUCTIONS 段)
 *   - skillCount + skill names(简略,完整内容在 RUNTIME_INSTRUCTIONS 段)
 *
 * 这样 Planner 看 ENV_CONTEXT 就能知道"有 3 个指令文件 + 47 个 skills",
 * 再决定是否细看 CUSTOM_INSTRUCTIONS / RUNTIME_INSTRUCTIONS。
 */
function renderEnvContextExtended(
  workspace: WorkspaceContext,
  gitRoot: string | undefined,
  scan: ScanResult
): string {
  const parts: string[] = [];
  parts.push('=== ENVIRONMENT CONTEXT ===');

  // 复用 workspaceContext.ts 的渲染(activeFile / openDocs / tree)
  parts.push(renderWorkspaceContext(workspace));

  // gitRoot
  parts.push('');
  parts.push(`Git root: ${gitRoot ?? '(not detected)'}`);

  // instruction files 概览(只列名 + 大小)
  if (scan.instructions.length > 0) {
    parts.push('');
    parts.push(`Instruction files detected (${scan.instructions.length}):`);
    for (const f of scan.instructions) {
      const flags: string[] = [];
      if (f.flaggedLarge) flags.push('LARGE');
      if (f.flaggedSensitive) flags.push('SENSITIVE?');
      const flagStr = flags.length > 0 ? ` [${flags.join(',')}]` : '';
      parts.push(`  - ${f.relativePath} (${f.sizeKb} KB${flagStr})`);
    }
  } else {
    parts.push('');
    parts.push('Instruction files: (none found in 7 standard paths)');
  }

  // skills 概览(只列 count)
  if (scan.skills.length > 0) {
    parts.push('');
    parts.push(`Skills detected (${scan.skills.length}): ${scan.skills.slice(0, 20).map((s) => s.name).join(', ')}${scan.skills.length > 20 ? `, +${scan.skills.length - 20} more` : ''}`);
  } else {
    parts.push('');
    parts.push('Skills: (none found in 4 standard folders)');
  }

  parts.push('=== END ENVIRONMENT CONTEXT ===');
  return parts.join('\n');
}

/** 同步检测 git root(若失败返回 undefined)。 */
function detectGitRoot(): string | undefined {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return undefined;
  try {
    const out = execSync('git rev-parse --show-toplevel', {
      cwd: folders[0].uri.fsPath,
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return out;
  } catch {
    return undefined;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// 角色级渲染:renderForRole
// ─────────────────────────────────────────────────────────────────────────

/**
 * 按角色渲染 SystemContext 的"可见段"。
 *
 * 矩阵(对齐 docs/moa-role-injection-design.md §4.2):
 *   - Planner / Recon / Actor  →  envContext + toolEfficiency + customInstructions + runtimeInstructions(全 4 段)
 *   - recon_aggregator / Refs / Aggregator  →  空字符串(完全不看)
 *
 * Refs / Aggregator 完全不可见的理由(用户原话):
 *   - "完全相同的固定设定,通过同一份证据获得不同 LLM 的判断"
 *   - "最终汇总在 aggregator 来下判断"
 * 即:这两个角色只看 evidence(由 Recon 提供),不看基础设施层。
 */
export function renderForRole(
  ctx: SystemContext,
  role: 'planner' | 'recon' | 'actor' | 'recon_aggregator' | 'refs' | 'aggregator'
): string {
  const visibleRoles: Array<typeof role> = ['planner', 'recon', 'actor'];
  if (!visibleRoles.includes(role)) {
    return '';
  }
  return [ctx.envContext, ctx.toolEfficiency, ctx.customInstructions, ctx.runtimeInstructions].join(
    '\n\n'
  );
}

// ─────────────────────────────────────────────────────────────────────────
// 清理(任务结束调用)
// ─────────────────────────────────────────────────────────────────────────

/**
 * 任务结束时清理(清理 instructionScanner 的 mtime 缓存)。
 *
 * 调用时机:moaOrchestrator.ts 在 finalize / cancel 时调用一次。
 */
export function disposeSystemContext(): void {
  clearScanCache();
}

// re-export scan cache control for orchestrator-level cleanup
export { clearScanCache } from './instructionScanner';
