/**
 * MoA Orchestrator (v0.12.0) — Hermes-style iterative MoA loop.
 *
 * Implements the multi-round MoA loop where:
 *   - recon is delegated to #runSubagent (via main Copilot session)
 *   - refs are lightweight vscode.lm calls with NO tool schema injection
 *   - aggregator (GLM-5.2 default, user-configurable) fuses ref outputs
 *   - state persists to disk so iterations survive main-session compaction
 *
 * Three LM tools expose this loop to the main Copilot session:
 *   #moa_orchestrate  — start a new loop, returns task_id
 *   #moa_continue     — feed subagent recon results, run one iteration
 *   #moa_finalize     — force-stop and produce action items
 *
 * State directory layout:
 *   <workspace>/.moa_cache/<task_id>/
 *     state.json              — current MoaState (overwritten each step)
 *     task.txt                — original task description
 *     meta.json               — human-readable metadata (timeline of completeness, models used)
 *     timeline.md             — at-a-glance iteration progression table
 *     iteration_NNN/
 *       planner.json          — Planner output (iter 1 only)
 *       recon_request.json    — gaps to fill (legacy v0.14.x compat)
 *       recon_result.json     — Recon result (注入下游 evidence 的那份 summary;
 *                                单模式 = 单 recon 结果; 并行模式 = Aggregator merged
 *                                并行模式会附加 parallel_sources[] + aggregator_model 字段)
 *       recon/<label>.json    — 仅并行模式: 每个并行 recon 的完整结果 (v0.18.0)
 *       refs/<label>.json     — individual ref outputs (v0.16.0: only refs/, no workers/ alias)
 *       aggregator.json       — aggregator synthesis + gate decision
 *       actor_result.json     — Actor execution result (if triggered)
 *     final.json              — finalizeTask output (summary + action_items)
 *     final.md                — human-readable final report
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as crypto from 'crypto';
import { promises as fs } from 'fs';
// v0.14.14: 统一通过 preset 读取 ref/aggregator 配置
import { getActivePresetConfig } from './presetConfig';
// v0.15.0: 5 角色共享模块
// 注意：只导入新角色（Planner/Recon/Actor）和共享类型，
// buildRefPrompt/buildAggregatorPrompt/buildFinalPrompt/extractJson 仍用本地版本
// （本地版本签名向后兼容，不破坏现有代码）
import {
  PlannerOutput,
  ReconResult,
  ReconReason,
  RefOutput,
  AggregatorOutput as CoreAggregatorOutput,
  AggregatorNextAction,
  ActorResult,
  buildFinalPrompt as buildFinalPromptCore,
} from './moaCore/roles';
import { runPlanner as callPlanner } from './moaCore/runPlanner';
import { callRecon } from './moaCore/runRecon';
import { callActor } from './moaCore/runActor';
import { resolveExecutionConfig } from './moaCore/safeExecutor';
import { EXTENSION_VERSION } from './extension';

// v0.22.0 P0-5: SystemContext builder(基础设施层 4 段动态注入)
import { buildSystemContext, renderForRole, disposeSystemContext, type SystemContext } from './systemContext';
// v0.22.0 P0-7: Role Setup Preset (角色身份层注入)
import { getActivePreset, renderRoleSetup, renderFewShots } from './roleSetupPreset';
// v0.22.0 P0-8: Plan Mode Report
import { setLastPlanReport, type MoaPlanReport } from './planModeReport';
// v0.15.0 hotfix 1: evidence 提取纯函数（独立文件便于单测）
import { buildActorEvidence } from './moaCore/actorEvidence';
// v0.21.0 I-2 / IV-1 / IV-4: 结构化日志 + 本地时间戳 + 自描述文件名 + pipeline 自描述
import {
  formatLocalTimestamp,
  formatLogLine,
  formatTaskBoundary,
  type LogLineOptions,
} from './moaLogUtils';
import { buildPipelineArchitecture } from './moaCore/pipelineArchitecture';

// ─────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────

export interface EvidenceItem {
  source: string;
  snippet: string;
  confidence: 'high' | 'medium' | 'low';
}

/**
 * v0.15.0: Ref 输出记录（v0.17.0 删除 worker_outputs alias 字段）。
 */
export interface RefOutputRecord {
  label: string;
  model: string;
  output: string;
  error?: string;
}

/**
 * v0.15.0: 单轮 iteration 的完整记录（含 5 角色）。
 */
export interface IterationRecord {
  iteration: number;
  started_at: string;

  // ── Planner（仅 iteration 0）──
  planner_output?: PlannerOutput;

  // ── Recon（每轮跑）──
  recon_result?: ReconResult;
  /** 兼容旧字段（v0.14.x recon_result 格式，仅 moa_continue 喂料时填） */
  recon_result_external?: { content: string; source: string };
  recon_reason?: ReconReason;

  // ── Refs（并行）──
  ref_outputs?: RefOutputRecord[];

  // ── Aggregator ──
  aggregator_output?: CoreAggregatorOutput;

  // ── Actor（仅 aggregator 标记 actor_needed 时）──
  actor_result?: ActorResult;

  // ── v0.14.x 兼容字段（recon_request 已被 recon_reason 替代，保留供读取） ──
  recon_request?: { gaps: string[]; prompt: string };

  // ── v0.19.2 §5.1: per-role 耗时记录（秒）──
  //
  // 每个 role 执行时记录 start/end 时间戳，渲染 meta.json 时累加。
  // undefined = 该轮没跑这个 role 或未追踪（向后兼容）。
  planner_elapsed_sec?: number;
  recon_elapsed_sec?: number;
  refs_elapsed_sec?: number;
  aggregator_elapsed_sec?: number;
  // actor 已有 actor_result.elapsed_sec，不重复
}

/**
 * v0.15.0: AggregatorOutput（重新导出，与旧 export 保持兼容）。
 *
 * v0.15.0 关键变更：
 *   - next_action 去掉 need_more_analysis，新增 actor_needed
 *   - 加 recon_reason
 *   - 加 action_items
 *
 * @deprecated v0.15.0 请使用 moaCore/roles.ts 的 AggregatorOutput
 */
export type AggregatorOutput = CoreAggregatorOutput;

/**
 * v0.16.0: 收敛来源标记。让用户在 timeline.md / final.md 一眼看出
 * 「这次是 Aggregator 自然收敛，还是被外部强制收敛」。
 *
 * 原因：单次模式（runSingleIterationAnalyze）和 MAX_ITER 强制收敛
 * 都会让 status='finalized'，但用户看到的 completeness 可能远低于
 * COMPLETENESS_THRESHOLD（如 55%），需要文案明确说明这是强制收敛
 * 而非自然完成，避免误导。
 */
export type ConvergenceSource =
  | 'natural'           // Aggregator 在某轮决策 next_action='finalize'
  | 'single_shot'       // runSingleIterationAnalyze 单次模式强制收敛
  | 'max_iter'          // 达到 MAX_ITER 强制收敛
  | 'should_stop'       // shouldStop() 检测到停滞强制收敛
  | 'manual_finalize';  // 用户手动调 #moa_finalize

export interface MoaState {
  task_id: string;
  task: string;
  created_at: string;
  last_update: string;
  iteration: number;
  evidence: EvidenceItem[];
  synthesis: string;
  gaps: string[];
  completeness: number;        // 0-1
  status: 'running' | 'awaiting_recon' | 'finalized' | 'error';
  history: IterationRecord[];
  error?: string;

  // ── v0.15.0 新字段 ──
  /** Planner 输出（仅首轮，存这里便于恢复） */
  planner?: PlannerOutput;
  /** Actor 历史累积（每轮如有） */
  actor_history?: ActorResult[];
  /** Recon 历史累积（每轮一条） */
  recon_history?: ReconResult[];

  // ── v0.16.0 新字段 ──
  /** 收敛来源（仅 status='finalized' 时有意义；undefined 表示未收敛或老任务） */
  convergence_source?: ConvergenceSource;
  /** 收敛时 Aggregator 的原始 next_action 建议（用于 single_shot 模式透明展示） */
  convergence_raw_next_action?: string;
}

export interface MoaFinalOutput {
  task_id: string;
  summary: string;
  action_items: Array<{
    type: 'write_file' | 'execute' | 'create_roadmap' | 'research_more' | 'inform_user';
    target: string;
    content: string;
    rationale: string;
  }>;
  confidence: number;
  unresolved: string[];
  iterations_used: number;
}

// ─────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────

const MAX_ITER = 12;                  // user-specified: 10-15 range, take middle
const COMPLETENESS_THRESHOLD = 0.8;   // aggregator says ≥0.8 → can finalize
const CONVERGENCE_WINDOW = 3;         // last N iterations checked for stall

// ─────────────────────────────────────────────────────────────────────────
// v0.22.0 P0-5: Per-task SystemContext cache (in-memory only, not serialized)
//
// 设计:
//   - key = taskId
//   - value = SystemContext(在 iter 1 构建,后续 iter 复用)
//   - 任务 finalize/cancel 时清理(避免内存累积)
//   - 不存到 state.json(避免 JSON 体积膨胀;每次新任务重建可接受)
// ─────────────────────────────────────────────────────────────────────────
const _systemContextCache = new Map<string, SystemContext>();

/**
 * 获取(或构建并缓存)指定任务的 SystemContext。
 *
 * - 首次调用(iter 1):构建 + 缓存
 * - 后续调用:命中缓存
 * - 任务结束:调用 clearTaskSystemContext(taskId) 清理
 *
 * 失败处理:构建失败时返回 undefined(上层退化为 v0.21.x 行为,不注入)。
 */
async function getOrBuildSystemContext(
  taskId: string,
  progress?: (msg: string) => void
): Promise<SystemContext | undefined> {
  const cached = _systemContextCache.get(taskId);
  if (cached) return cached;

  try {
    const ctx = await buildSystemContext();
    _systemContextCache.set(taskId, ctx);
    progress?.(
      `[MoA v0.22 P0-5] SystemContext built: ` +
      `env=${ctx.sizes.envContext}b, toolEff=${ctx.sizes.toolEfficiency}b, ` +
      `custom=${ctx.sizes.customInstructions}b (${ctx.instructionCount} files), ` +
      `runtime=${ctx.sizes.runtimeInstructions}b (${ctx.skillCount} skills), ` +
      `${ctx.scanDurationMs}ms`
    );
    if (ctx.warnings.length > 0) {
      progress?.(`[MoA v0.22 P0-5] SystemContext warnings: ${ctx.warnings.length} (see OutputChannel)`);
    }
    return ctx;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    progress?.(`[MoA v0.22 P0-5] SystemContext build FAILED: ${msg} — falling back to v0.21.x behavior (no infrastructure injection)`);
    return undefined;
  }
}

/** 清理指定任务的 SystemContext 缓存(任务结束时调用)。 */
function clearTaskSystemContext(taskId: string): void {
  _systemContextCache.delete(taskId);
  // 同时清理 instructionScanner 的 mtime 缓存
  disposeSystemContext();
}

// ─────────────────────────────────────────────────────────────────────────
// v0.17.0: 5 个独立的 OutputChannel（每个角色一个）
//
// 用户希望能在 VSCode Output 面板（View → Output）里看到 MoA 流水线的
// 完整中间过程，并且按角色拆分到不同的输出端口，避免混杂：
//
//   - "MoA Planner"      — 仅 Planner 输出（仅 iter 1）
//   - "MoA Recon"        — 仅 Recon 输出（每轮 tool_calls / summary / 错误）
//   - "MoA Refs"         — 每个 Ref 的原始输出（多模型对比）
//   - "MoA Aggregator"   — Aggregator 的 raw + parsed JSON
//   - "MoA Actor"        — Actor 的每个 action_item 执行结果 + self_assessment
//
// 5 个 channel 都跟老的 "MoA Bridge Diag" / "MoA Bridge — Ref Output"
// 同一级（下拉可见），用户在排查某角色问题时只看对应 channel，不被其他角色
// 的输出淹没。
//
// 设计：
//   - 懒创建：第一次 log<Role>() 时才 createOutputChannel（避免 activate 时
//     就一次性创建 5 个空 channel 占用 UI）
//   - 失败静默：写入失败只 console.warn，不阻塞状态机
//   - 全程写：不开开关（落盘 JSON 已有，OutputChannel 是镜像 + 即时可见）
// ─────────────────────────────────────────────────────────────────────────

/**
 * 5 个角色的 OutputChannel 单例缓存。
 *
 * 用 map 而非 5 个独立变量，方便统一懒创建逻辑 + 未来加新角色时不需要
 * 改 helper 函数签名。
 */
type PipelineChannelKey = 'planner' | 'recon' | 'refs' | 'aggregator' | 'actor';
const _pipelineChannels: Partial<Record<PipelineChannelKey, vscode.OutputChannel>> = {};

const CHANNEL_NAMES: Record<PipelineChannelKey, string> = {
  planner: 'MoA Planner',
  recon: 'MoA Recon',
  refs: 'MoA Refs',
  aggregator: 'MoA Aggregator',
  actor: 'MoA Actor',
};

/**
 * 获取指定角色的 OutputChannel（懒创建）。
 */
function getPipelineChannel(key: PipelineChannelKey): vscode.OutputChannel {
  let ch = _pipelineChannels[key];
  if (!ch) {
    ch = vscode.window.createOutputChannel(CHANNEL_NAMES[key]);
    _pipelineChannels[key] = ch;
  }
  return ch;
}

/**
 * 把一行内容追加到指定角色的 OutputChannel。
 * 任何错误都静默吞掉（OutputChannel 是 render-only，不阻塞状态机）。
 */
function logPipeline(key: PipelineChannelKey, line: string): void {
  try {
    getPipelineChannel(key).appendLine(line);
  } catch (err) {
    console.warn(`[MoA ${key} log] failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * 把带分隔头的多行块写到指定角色的 OutputChannel。
 *
 * @param key     角色通道（planner / recon / refs / aggregator / actor）
 * @param header  块标题（如 "--- Ref advisor_1 (DeepSeek-V4-Flash) ---"）
 * @param content 块正文（多行字符串）
 */
function logPipelineBlock(
  key: PipelineChannelKey,
  header: string,
  content: string
): void {
  logPipeline(key, '');
  logPipeline(key, header);
  logPipeline(key, content);
}

/** v0.21.0 I-2: 结构化日志（带本地时间戳 + iter/role/model 前缀） */
function logPipelineStructured(key: PipelineChannelKey, opts: LogLineOptions): void {
  logPipeline(key, formatLogLine(opts));
}

// ─────────────────────────────────────────────────────────────────────────
// State persistence
// ─────────────────────────────────────────────────────────────────────────

async function getCacheRoot(): Promise<string> {
  const ws = vscode.workspace.workspaceFolders?.[0];
  if (!ws) {
    throw new Error('MoA orchestrator requires an open workspace');
  }
  const root = path.join(ws.uri.fsPath, '.moa_cache');
  await fs.mkdir(root, { recursive: true });
  // v0.14.10: 首次创建 .moa_cache/ 时同步写入 README（已存在不覆盖）
  try {
    const { ensureCacheReadme } = require('./cacheReadme');
    ensureCacheReadme(root);
  } catch {
    // 模块加载失败不阻塞主流程
  }
  return root;
}

async function getTaskDir(taskId: string): Promise<string> {
  const dir = path.join(await getCacheRoot(), taskId);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

export async function saveState(state: MoaState): Promise<void> {
  const dir = await getTaskDir(state.task_id);
  // v0.21.1: state.json 时间戳也用本地时间（与 meta.json / timeline.md 一致）
  state.last_update = formatLocalTimestamp();
  const statePath = path.join(dir, 'state.json');
  const tmp = `${statePath}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(state, null, 2), 'utf8');
  await fs.rename(tmp, statePath);  // atomic
}

export async function loadState(taskId: string): Promise<MoaState | null> {
  try {
    const statePath = path.join(await getTaskDir(taskId), 'state.json');
    const raw = await fs.readFile(statePath, 'utf8');
    return JSON.parse(raw) as MoaState;
  } catch {
    return null;
  }
}

async function saveIterationArtifact(
  taskId: string,
  iteration: number,
  filename: string,
  data: unknown,
  options?: {
    /** 角色标签（如 'planner' / 'recon/recon_1' / 'refs/advisor_1'），提供时自动生成自描述文件名 */
    role?: string;
    /** 模型名（如 'GLM-5.2'），提供时拼入文件名 */
    model?: string;
    /** 若 true，同时写入新命名（自描述）+ 旧命名（兼容）；默认 false */
    keepLegacy?: boolean;
  }
): Promise<void> {
  const iterDirName = `iteration_${String(iteration).padStart(3, '0')}`;
  const dir = path.join(await getTaskDir(taskId), iterDirName);

  // v0.21.1: 自描述文件名 + role 子目录双层结构
  //   - role='recon/recon_1'   → iteration_NNN/recon/iteration_NNN__recon__recon_1__model.json
  //   - role='refs/advisor_1'  → iteration_NNN/refs/iteration_NNN__refs__advisor_1__model.json
  //   - role='planner'         → iteration_NNN/iteration_NNN__planner__model.json（无子目录）
  //   - role='aggregator'      → iteration_NNN/iteration_NNN__aggregator__model.json（无子目录）
  //   - role 缺省              → 按 filename 原样落盘（向后兼容）
  //
  // 设计目的：role 子目录便于人工浏览汇总（recon/、refs/ 各自独立），
  //          自描述文件名保留 model 信息（无需打开文件即知模型）。
  let finalRelPath: string;  // 相对 iteration_NNN/ 的路径
  if (options?.role) {
    const iterPart = iterDirName;
    const rolePart = options.role.replace(/\//g, '__');
    const modelPart = options.model
      ? '__' + options.model.replace(/[^A-Za-z0-9._-]/g, '_')
      : '';
    const selfDescName = `${iterPart}__${rolePart}${modelPart}.json`;
    const slashIdx = options.role.indexOf('/');
    if (slashIdx > 0) {
      // 形如 'recon/recon_1' / 'refs/advisor_1'：抽取首段作子目录
      const subDir = options.role.substring(0, slashIdx);
      finalRelPath = path.join(subDir, selfDescName);
    } else {
      // 形如 'planner' / 'aggregator'：无子目录
      finalRelPath = selfDescName;
    }
  } else {
    finalRelPath = filename;
  }

  const finalPath = path.join(dir, finalRelPath);
  await fs.mkdir(path.dirname(finalPath), { recursive: true });

  // v0.21.0 IV-1: JSON 内部注入 _meta 字段（task_id / iter / role / model / saved_at）
  const shouldWrap =
    data && typeof data === 'object' && !Array.isArray(data);
  const dataWithMeta = shouldWrap
    ? {
        ...(data as Record<string, unknown>),
        _meta: {
          task_id: taskId,
          iter: iteration,
          role: options?.role ?? filename.replace(/\.json$/, ''),
          model: options?.model,
          saved_at: formatLocalTimestamp(),
        },
      }
    : data;

  await fs.writeFile(finalPath, JSON.stringify(dataWithMeta, null, 2), 'utf8');

  // 向后兼容：同时写旧命名（仅当 keepLegacy=true 且新旧文件名不同）
  if (options?.keepLegacy && finalRelPath !== filename) {
    const legacyPath = path.join(dir, filename);
    await fs.mkdir(path.dirname(legacyPath), { recursive: true });
    await fs.writeFile(legacyPath, JSON.stringify(dataWithMeta, null, 2), 'utf8');
  }
}

// ─────────────────────────────────────────────────────────────────────────
// v0.14.15: Human-readable MD audit rendering (parallel to JSON state)
//
// 设计原则：
//   - JSON 是唯一权威状态源，MD 仅为 render-only 视图
//   - 写入失败只 console.warn，不抛错（保护状态机）
//   - 原子写入（tmp + rename），防止读到半写状态
//   - 每轮覆盖写（meta.json + timeline.md），保证反映最新状态
//
// 落盘文件：
//   <task_id>/meta.json       — 跨轮累积元信息（含 completeness_timeline[]）
//   <task_id>/timeline.md     — 全轮时序表（一目了然）
//   <task_id>/final.md        — finalize 时的最终产出（含 action_items）
// ─────────────────────────────────────────────────────────────────────────

/** Orchestration 任务级元信息（每轮覆盖写）。 */
interface OrchestrationMeta {
  task_id: string;
  task: string;
  created_at: string;
  last_update: string;
  /** finalize 后才填，表示任务完成时间。 */
  finished_at?: string;
  iteration_count: number;
  status: MoaState['status'];
  /** Ref 模型名列表（如 ["DeepSeek-V4-Flash", "DeepSeek-V4-Pro", ...]）。 */
  ref_models: string[];
  /** Aggregator 模型名。 */
  aggregator_model: string;
  /** 每轮 completeness/gaps 数据点，便于画趋势图或人工检视收敛。 */
  completeness_timeline: Array<{
    iteration: number;
    started_at: string;
    completeness: number;
    gaps_count: number;
    next_action: string;
    recon_used: boolean;
    ref_errors: number;
  }>;
  total_evidence_items: number;
  /** finalize 后才填。 */
  final_confidence?: number;

  // ── v0.19.1 §5: 信息可见性增强字段 ──────────────────────────────────

  /** v0.19.1 §5: 任务总耗时（秒）。finalized 后填，运行中为当前累计。 */
  total_elapsed_sec?: number;
  /** v0.19.1 §5: 整个任务的工具调用总数（recon + actor 累加）。 */
  total_tool_calls?: number;
  /** v0.19.1 §5: 收敛来源（max_iter / natural / should_stop）。 */
  convergence_source?: string;

  /** v0.19.1 §5: per-role 汇总（rounds 数 + 总耗时 + 工具调用数）。 */
  per_role_breakdown?: {
    planner: { rounds: number; total_elapsed_sec: number };
    recon: { rounds: number; total_elapsed_sec: number; total_tool_calls: number };
    refs: { rounds: number; total_elapsed_sec: number };
    aggregator: { rounds: number; total_elapsed_sec: number };
    actor: { rounds: number; total_elapsed_sec: number; actions_executed: number; tool_calls: number };
  };

  /** v0.19.1 §5: 每轮每个角色的模型调用记录（可画出"哪一轮用了哪个模型"）。 */
  model_invocations?: Array<{
    iter: number;
    role: 'planner' | 'recon' | 'refs' | 'aggregator' | 'actor';
    model: string;
    elapsed_sec?: number;
    tool_calls?: number;
  }>;

  /** v0.19.1 §5: Actor 执行的所有 action（结构化审计日志）。 */
  actor_actions_log?: Array<{
    iter: number;
    type: string;
    target: string;
    status: string;
    output_chars?: number;
    artifacts?: string[];
    error_message?: string;
  }>;

  // ── v0.21.0 IV-4: pipeline 自描述 + 每轮阶段耗时 ──────────────────

  /** v0.21.0 IV-4: pipeline 架构清单 —— 让 .moa_cache/ 自描述 */
  pipeline_architecture?: {
    version: string;
    description: string;
    roles: unknown[];
    loop_termination: {
      max_iter: number;
      completeness_threshold: number;
      convergence_window: number;
      gate_order: string[];
    };
    file_layout: Record<string, string>;
    settings_snapshot: Record<string, unknown>;
  };

  /** v0.21.0 IV-4: 每轮每阶段耗时（秒），timeline.md 渲染表格用 */
  iteration_timings?: Array<{
    iter: number;
    planner?: number;
    recon?: number;
    refs?: number;
    aggregator?: number;
    actor?: number | null;
    total: number;
  }>;
}

/**
 * 原子化 MD/小文件写入工具。
 * 失败只 console.warn，不抛错（render-only，保护状态机）。
 *
 * @param subdir 相对 task_id 目录的子目录（空串表示 task_id 根目录）
 */
async function writeMdArtifact(
  taskId: string,
  subdir: string,
  filename: string,
  content: string
): Promise<void> {
  try {
    const taskDir = await getTaskDir(taskId);
    const targetDir = subdir ? path.join(taskDir, subdir) : taskDir;
    const filePath = path.join(targetDir, filename);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.tmp`;
    await fs.writeFile(tmp, content, 'utf8');
    await fs.rename(tmp, filePath);
  } catch (err) {
    console.warn(
      `[MoA MD render] failed to write ${filename} for ${taskId}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * 读取已存在的 meta.json（用于保留 ref_models / aggregator_model，
 * 避免每轮重新 resolveRefModels）。失败返回 null。
 *
 * v0.17.0: 兼容老 meta.json（worker_models 字段）——读到旧字段时迁移到新字段。
 */
async function readExistingMeta(taskId: string): Promise<OrchestrationMeta | null> {
  try {
    const metaPath = path.join(await getTaskDir(taskId), 'meta.json');
    const raw = await fs.readFile(metaPath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<OrchestrationMeta> & { worker_models?: string[] };
    // v0.17.0 迁移：worker_models → ref_models（只读迁移，下次覆盖写就自动 normalize）
    if (parsed.worker_models && !parsed.ref_models) {
      parsed.ref_models = parsed.worker_models;
      delete parsed.worker_models;
    }
    return parsed as OrchestrationMeta;
  } catch {
    return null;
  }
}

/**
 * 渲染 meta.json（每轮覆盖写）。
 *
 * 调用点：
 *   - runIteration 末尾（saveState 之后）
 *   - finalizeTask 末尾（写 final.json 之后，补 finished_at + final_confidence）
 *
 * @param taskId           任务 ID
 * @param state            当前 state（唯一权威状态源）
 * @param refModels        本轮 ref model.name 列表（仅第一次需传，之后从 meta 读）
 * @param aggregatorModel  本轮 aggregator model.name（同上）
 */
async function renderMetaJson(
  taskId: string,
  state: MoaState,
  refModels?: string[],
  aggregatorModel?: string
): Promise<void> {
  // 仅当本轮传入新值时覆盖，否则保留已有 meta 的值（避免每轮重新 resolveRefModels）
  let resolvedRefModels = refModels;
  let resolvedAggregator = aggregatorModel;
  if (!resolvedRefModels || !resolvedAggregator) {
    const existing = await readExistingMeta(taskId);
    if (!resolvedRefModels && existing?.ref_models) {
      resolvedRefModels = existing.ref_models;
    }
    if (!resolvedAggregator && existing?.aggregator_model) {
      resolvedAggregator = existing.aggregator_model;
    }
  }

  const meta: OrchestrationMeta = {
    task_id: state.task_id,
    task: state.task,
    created_at: state.created_at,
    last_update: state.last_update,
    finished_at: state.status === 'finalized' ? state.last_update : undefined,
    iteration_count: state.iteration,
    status: state.status,
    ref_models: resolvedRefModels ?? [],
    aggregator_model: resolvedAggregator ?? '',
    completeness_timeline: state.history.map((h) => ({
      iteration: h.iteration,
      started_at: h.started_at,
      completeness: h.aggregator_output?.evidence_coverage ?? 0,
      gaps_count: h.aggregator_output?.critical_gaps?.length ?? 0,
      next_action: h.aggregator_output?.next_action ?? 'unknown',
      recon_used: !!h.recon_result,
      ref_errors: (h.ref_outputs ?? []).filter((w) => w.error).length,
    })),
    total_evidence_items: state.evidence.length,
    final_confidence: state.status === 'finalized' ? state.completeness : undefined,

    // v0.19.1 §5: 信息可见性增强字段
    convergence_source: state.convergence_source,
    total_elapsed_sec: computeTotalElapsedSec(state),
    total_tool_calls: computeTotalToolCalls(state),
    per_role_breakdown: computePerRoleBreakdown(state),
    model_invocations: buildModelInvocations(state, resolvedRefModels ?? [], resolvedAggregator ?? ''),
    actor_actions_log: buildActorActionsLog(state),

    // v0.21.0 IV-4: pipeline 自描述 + 每轮阶段耗时
    pipeline_architecture: buildPipelineArchitecture(readSettingsSnapshot()),
    iteration_timings: buildIterationTimings(state),
  };

  await writeMdArtifact(taskId, '', 'meta.json', JSON.stringify(meta, null, 2));
}

/**
 * v0.21.0 IV-4: 读取 moa.* 关键配置作为 settings_snapshot。
 */
function readSettingsSnapshot(): Record<string, unknown> {
  const config = vscode.workspace.getConfiguration('moa');
  // v0.21.3: 默认值与 package.json 对齐（autopilot / enableActorInLoop=true / maxReconRounds=5）
  return {
    executionPreset: config.get('executionPreset', 'autopilot'),
    approvalMode: config.get('approvalMode', 'batch'),
    safeExecutionMode: config.get('safeExecutionMode', true),
    enableRecon: config.get('enableRecon', true),
    enableActorInLoop: config.get('enableActorInLoop', true),
    refDisplayMode: config.get('refDisplayMode', 'thinking'),
    parallelRefs: config.get('parallelRefs', true),
    parallelRecon: config.get('parallelRecon', true),
    maxReconRounds: config.get('maxReconRounds', 5),
  };
}

/**
 * v0.21.0 IV-4: 每轮每阶段耗时（秒），从 IterationRecord 的 *_elapsed_sec 字段提取。
 */
function buildIterationTimings(state: MoaState): OrchestrationMeta['iteration_timings'] {
  const out: NonNullable<OrchestrationMeta['iteration_timings']> = [];
  for (const h of state.history) {
    const planner = h.planner_elapsed_sec;
    const recon = h.recon_elapsed_sec;
    const refs = h.refs_elapsed_sec;
    const aggregator = h.aggregator_elapsed_sec;
    const actor = h.actor_result ? h.actor_result.elapsed_sec : null;
    const sum = (v: number | undefined | null) => (v === undefined || v === null ? 0 : v);
    const total = sum(planner) + sum(recon) + sum(refs) + sum(aggregator) + sum(actor);
    out.push({ iter: h.iteration, planner, recon, refs, aggregator, actor, total });
  }
  return out;
}

/**
 * v0.19.1 §5: 计算任务总耗时（秒）。
 *
 * v0.21.1 策略变更：累加 iteration_timings 的 per-iter total 字段
 *   （之前用 started_at 差值，但 v0.21.1 把 started_at 改成本地时间格式
 *    非 ISO，new Date() 解析失败；改为累加 per-role elapsed_sec 更可靠）
 * 兜底：返回 0。
 */
function computeTotalElapsedSec(state: MoaState): number {
  let total = 0;
  for (const h of state.history) {
    const sum = (v: number | undefined | null) => (v === undefined || v === null ? 0 : v);
    total += sum(h.planner_elapsed_sec) + sum(h.recon_elapsed_sec)
      + sum(h.refs_elapsed_sec) + sum(h.aggregator_elapsed_sec);
    if (h.actor_result?.elapsed_sec) total += h.actor_result.elapsed_sec;
  }
  return Math.round(total);
}

/**
 * v0.19.1 §5: 统计任务工具调用总数。
 */
function computeTotalToolCalls(state: MoaState): number {
  let total = 0;
  for (const h of state.history) {
    if (h.recon_result?.tool_calls) total += h.recon_result.tool_calls;
    if (h.actor_result?.tool_calls) total += h.actor_result.tool_calls;
  }
  return total;
}

/**
 * v0.19.1 §5 / v0.19.2 §5.1: 构建 per-role breakdown。
 *
 * v0.19.2 §5.1: 现已使用 IterationRecord 的 *_elapsed_sec 字段（真实耗时）。
 * 旧任务（v0.19.1 之前）无这些字段，仍返回 0（向后兼容）。
 */
function computePerRoleBreakdown(state: MoaState): OrchestrationMeta['per_role_breakdown'] {
  let plannerRounds = 0;
  let plannerElapsed = 0;
  let reconRounds = 0;
  let reconElapsed = 0;
  let reconToolCalls = 0;
  let refsRounds = 0;
  let refsElapsed = 0;
  let aggregatorRounds = 0;
  let aggregatorElapsed = 0;
  let actorRounds = 0;
  let actorElapsed = 0;
  let actorActions = 0;
  let actorToolCalls = 0;

  for (const h of state.history) {
    if (h.planner_output) {
      plannerRounds += 1;
      plannerElapsed += h.planner_elapsed_sec ?? 0;
    }
    if (h.recon_result) {
      reconRounds += 1;
      reconElapsed += h.recon_elapsed_sec ?? 0;
      reconToolCalls += h.recon_result.tool_calls ?? 0;
    }
    if (h.ref_outputs && h.ref_outputs.length > 0) {
      refsRounds += 1;
      refsElapsed += h.refs_elapsed_sec ?? 0;
    }
    if (h.aggregator_output) {
      aggregatorRounds += 1;
      aggregatorElapsed += h.aggregator_elapsed_sec ?? 0;
    }
    if (h.actor_result) {
      actorRounds += 1;
      actorElapsed += h.actor_result.elapsed_sec ?? 0;
      actorActions += h.actor_result.executed_actions.length;
      actorToolCalls += h.actor_result.tool_calls ?? 0;
    }
  }

  return {
    planner: { rounds: plannerRounds, total_elapsed_sec: Math.round(plannerElapsed) },
    recon: { rounds: reconRounds, total_elapsed_sec: Math.round(reconElapsed), total_tool_calls: reconToolCalls },
    refs: { rounds: refsRounds, total_elapsed_sec: Math.round(refsElapsed) },
    aggregator: { rounds: aggregatorRounds, total_elapsed_sec: Math.round(aggregatorElapsed) },
    actor: { rounds: actorRounds, total_elapsed_sec: Math.round(actorElapsed), actions_executed: actorActions, tool_calls: actorToolCalls },
  };
}

/**
 * v0.19.1 §5: 构建 model_invocations 列表。
 *
 * 每轮每个角色的模型调用。Refs 每 N 个 advisor 共用一个轮次（合并为 1 条）。
 */
function buildModelInvocations(
  state: MoaState,
  refModels: string[],
  aggregatorModel: string,
): OrchestrationMeta['model_invocations'] {
  const invocations: NonNullable<OrchestrationMeta['model_invocations']>[number][] = [];

  for (const h of state.history) {
    // Planner 只在 iter 1 执行（state 没单独追踪，简化：每轮都打一条）
    invocations.push({
      iter: h.iteration,
      role: 'planner',
      model: aggregatorModel,  // 待 v0.20.x 独立追踪 planner model
      elapsed_sec: h.planner_elapsed_sec,
    });

    if (h.recon_result) {
      invocations.push({
        iter: h.iteration,
        role: 'recon',
        model: '(recon agent)',  // 待 v0.20.x 追踪 recon model
        tool_calls: h.recon_result.tool_calls,
        elapsed_sec: h.recon_elapsed_sec,
      });
    }

    // Refs：合并为一条（用第一个 model 名代表）
    if (h.ref_outputs && h.ref_outputs.length > 0) {
      invocations.push({
        iter: h.iteration,
        role: 'refs',
        model: refModels[0] ?? '(unknown)',
        elapsed_sec: h.refs_elapsed_sec,
      });
    }

    invocations.push({
      iter: h.iteration,
      role: 'aggregator',
      model: aggregatorModel,
      elapsed_sec: h.aggregator_elapsed_sec,
    });

    if (h.actor_result) {
      invocations.push({
        iter: h.iteration,
        role: 'actor',
        model: aggregatorModel,  // 待 v0.20.x 追踪 actor model
        tool_calls: h.actor_result.tool_calls,
        elapsed_sec: h.actor_result.elapsed_sec,
      });
    }
  }

  return invocations;
}

/**
 * v0.19.1 §5: 构建 actor_actions_log。
 */
function buildActorActionsLog(state: MoaState): OrchestrationMeta['actor_actions_log'] {
  const log: NonNullable<OrchestrationMeta['actor_actions_log']>[number][] = [];
  for (const h of state.history) {
    if (!h.actor_result) continue;
    for (const ar of h.actor_result.executed_actions) {
      log.push({
        iter: h.iteration,
        type: ar.action.type,
        target: ar.action.target,
        status: ar.status,
        output_chars: ar.output_chars,
        artifacts: ar.artifacts,
        error_message: ar.error_message,
      });
    }
  }
  return log;
}

/**
 * 渲染 timeline.md（每轮覆盖写）。一张表看完整个迭代历程。
 */
async function renderTimelineMd(taskId: string, state: MoaState): Promise<void> {
  const lines: string[] = [
    `# Timeline — Task \`${taskId}\``,
    '',
    `**Task:** ${state.task}`,
    '',
    `**Status:** ${state.status} | **Iteration:** ${state.iteration}/${MAX_ITER} | **Created:** ${state.created_at}`,
    '',
    '## Iteration Progression',
    '',
    // v0.15.0: 改名 Workers→Refs，新增 Recon Tools 列（显示 Recon 调了几次工具）
    //   新增 Actor 列（显示本轮是否触发 Actor + 成功/失败）
    // v0.17.0: 删除 worker_outputs alias 后简化为直接读 ref_outputs
    '| Iter | Time | Compl. | Δ | Gaps | Recon Tools | Refs OK | Actor | Next |',
    '|---|---|---|---|---|---|---|---|---|',
  ];

  let prevCompl = 0;
  for (const h of state.history) {
    const cov = h.aggregator_output?.evidence_coverage ?? 0;
    const delta = cov - prevCompl;
    const deltaStr = delta >= 0 ? `+${delta.toFixed(2)}` : delta.toFixed(2);
    prevCompl = cov;
    const refList = h.ref_outputs ?? [];
    const refsOk = refList.filter((w) => !w.error).length;
    const ts = h.started_at.length >= 19 ? h.started_at.substring(11, 19) : h.started_at;
    // v0.15.0: Recon Tools 列（tool_calls 数字，无 recon 显示 —）
    const reconTools = h.recon_result?.tool_calls;
    const reconStr = reconTools !== undefined && reconTools > 0
      ? `${reconTools} calls`
      : (h.recon_result ? '0' : '—');
    // v0.15.0: Actor 列（success / failed / skipped / —）
    let actorStr = '—';
    if (h.actor_result) {
      const total = h.actor_result.executed_actions.length;
      const succ = h.actor_result.executed_actions.filter((a) => a.status === 'success').length;
      actorStr = `${succ}/${total}`;
    }
    lines.push(
      `| ${h.iteration} | ${ts} | ${cov.toFixed(2)} | ${deltaStr} | ` +
        `${h.aggregator_output?.critical_gaps?.length ?? 0} | ` +
        `${reconStr} | ${refsOk}/${refList.length} | ${actorStr} | ` +
        `${h.aggregator_output?.next_action ?? '-'} |`
    );
  }

  lines.push('');
  lines.push('## Convergence Notes');
  lines.push('');
  if (state.status === 'finalized') {
    // v0.16.0: 区分 4 种收敛来源，让用户看到真实状态而非误导性的「Converged」
    const complPct = (state.completeness * 100).toFixed(0);
    const thresholdPct = (COMPLETENESS_THRESHOLD * 100).toFixed(0);
    const rawNext = state.convergence_raw_next_action ?? '?';
    switch (state.convergence_source) {
      case 'natural':
        lines.push(`✅ **Naturally converged** at iteration ${state.iteration} | completeness: ${complPct}% (≥ threshold ${thresholdPct}%) | Aggregator decided: \`finalize\``);
        break;
      case 'single_shot':
        lines.push(`🔄 **Single-shot mode forced finalize** at iteration ${state.iteration} | completeness: ${complPct}% (below threshold ${thresholdPct}%) | Aggregator's actual suggestion was \`${rawNext}\` — evidence may be incomplete, consider using \`@moaloop\` or \`#moa_orchestrate\` for iterative refinement.`);
        break;
      case 'max_iter':
        lines.push(`🛑 **MAX_ITER=${MAX_ITER} reached, forced finalize** at iteration ${state.iteration} | completeness: ${complPct}% | Aggregator's last suggestion was \`${rawNext}\` — task did not naturally converge within iteration budget.`);
        break;
      case 'should_stop':
        lines.push(`⏸️ **shouldStop() detected stall, forced finalize** at iteration ${state.iteration} | completeness: ${complPct}% | Aggregator's last suggestion was \`${rawNext}\` — further iterations unlikely to improve completeness.`);
        break;
      case 'manual_finalize':
        lines.push(`👤 **Manually finalized** via \`#moa_finalize\` at iteration ${state.iteration} | completeness: ${complPct}% | Aggregator's last suggestion was \`${rawNext}\``);
        break;
      default:
        // 老任务（v0.15.x 无 convergence_source 字段），向后兼容
        lines.push(`✅ Converged at iteration ${state.iteration} with completeness ${complPct}%.`);
    }
  } else if (state.status === 'awaiting_recon') {
    lines.push(`⏸️  Awaiting recon — ${state.gaps.length} gap(s) need to be filled via \`#moa_continue\`.`);
    if (state.gaps.length > 0) {
      lines.push('');
      for (const g of state.gaps) lines.push(`- ${g}`);
    }
  } else if (state.status === 'error') {
    lines.push(`❌ Error at iteration ${state.iteration}: ${state.error ?? 'unknown'}`);
  } else if (state.status === 'running') {
    lines.push(`🏃 Running — will proceed to iteration ${state.iteration + 1}.`);
  }

  lines.push('');
  await writeMdArtifact(taskId, '', 'timeline.md', lines.join('\n'));
}

/**
 * 渲染 final.md（仅 finalizeTask 末尾调用一次）。
 * 包含：元信息头 + Summary + Action Items（含 rationale + content）+ Unresolved。
 */
async function renderFinalMd(
  taskId: string,
  output: MoaFinalOutput,
  state: MoaState
): Promise<void> {
  // v0.16.0: 收敛来源标签（让用户在 final.md 顶部就看到真实状态）
  const sourceLabel: Record<ConvergenceSource, string> = {
    natural: '✅ Natural converge',
    single_shot: '🔄 Single-shot forced',
    max_iter: '🛑 MAX_ITER forced',
    should_stop: '⏸️ shouldStop forced',
    manual_finalize: '👤 Manual finalize',
  };
  const sourceStr = state.convergence_source
    ? `${sourceLabel[state.convergence_source]}${state.convergence_raw_next_action ? ` (Aggregator suggested: \`${state.convergence_raw_next_action}\`)` : ''}`
    : '(unknown source — pre-v0.16.0 task)';

  // v0.21.3: 强制注入当前 loop 模式 + execution preset 到 final.md 顶部
  //   让用户在审计时一眼看出：(1) 用了哪种 loop 模式 (2) Actor 是否自动执行
  const execConfig = resolveExecutionConfig();
  const settingsSnapshot = readSettingsSnapshot();
  const loopMode = settingsSnapshot.enableActorInLoop === true
    ? '5-role full loop (Planner → Recon → Refs → Aggregator → Actor → feedback)'
    : '4-role loop without Actor (actor_needed degrades to recon_needed)';
  const presetWarn = execConfig.preset === 'autopilot'
    ? '⚠️ **Autopilot mode active** — action_items below have been auto-executed by Actor (with SafeExecutor backup). Audit trail: `.moa_cache/<task_id>/manifest.json`. Rollback: `.bak.<timestamp>` files next to originals.'
    : execConfig.preset === 'yolo'
      ? '🚨 **YOLO mode active** — action_items auto-executed WITHOUT SafeExecutor backup. Changes are irreversible.'
      : `Execution preset: \`${execConfig.preset}\` (autoExecute=${execConfig.autoExecute}, approvalMode=${execConfig.approvalMode}, safeMode=${execConfig.safeMode})`;

  const lines: string[] = [
    `# MoA Final Output — Task \`${taskId}\``,
    '',
    `**Task:** ${state.task}`,
    '',
    '> **Loop & Execution Context** (v0.21.3+)',
    '>',
    `> - **Loop mode:** ${loopMode}`,
    `> - **MAX_ITER cap:** ${MAX_ITER} (this task used ${output.iterations_used})`,
    `> - **Convergence source:** ${sourceStr}`,
    '>',
    `> ${presetWarn}`,
    '',
    '| Field | Value |',
    '|---|---|',
    `| Created | ${state.created_at} |`,
    `| Finalized | ${state.last_update} |`,

    `| Iterations used | ${output.iterations_used}/${MAX_ITER} |`,
    `| Final confidence | ${(output.confidence * 100).toFixed(0)}% |`,
    `| Execution preset | \`${execConfig.preset}\` (safeMode=${execConfig.safeMode ? 'on' : 'off'}) |`,
    `| Actor in loop | ${settingsSnapshot.enableActorInLoop === true ? '✅ enabled' : '❌ disabled'} |`,
    `| Status | ${state.status} |`,
    '',
    '---',
    '',
    '## Summary',
    '',
    output.summary,
    '',
  ];

  if (output.action_items.length > 0) {
    lines.push('## Action Items');
    lines.push('');
    for (let i = 0; i < output.action_items.length; i++) {
      const a = output.action_items[i];
      lines.push(`### ${i + 1}. [${a.type}] ${a.target}`);
      lines.push('');
      lines.push(`**Rationale:** ${a.rationale}`);
      lines.push('');
      lines.push('**Content:**');
      lines.push('```');
      lines.push(a.content);
      lines.push('```');
      lines.push('');
    }
  }

  if (output.unresolved.length > 0) {
    lines.push('## Unresolved Questions');
    lines.push('');
    for (const u of output.unresolved) lines.push(`- ${u}`);
    lines.push('');
  }

  await writeMdArtifact(taskId, '', 'final.md', lines.join('\n'));
}

// ─────────────────────────────────────────────────────────────────────────
// Model resolution (reuses moa.refModels + moa.aggregator config)
// ─────────────────────────────────────────────────────────────────────────

interface ResolvedModel {
  model: vscode.LanguageModelChat;
  label: string;
}

/**
 * v0.15.0: 解析 refs 和 aggregator 模型（重命名自 resolveModels）。
 * v0.17.0: 删除 workers alias 返回值（保留单一 refs 名字）。
 */
async function resolveRefModels(): Promise<{
  refs: ResolvedModel[];
  aggregator: ResolvedModel;
}> {
  const all = await vscode.lm.selectChatModels({});
  const PLACEHOLDER = new Set(['auto', 'automatic', 'default', '']);
  const real = all.filter((m) => !PLACEHOLDER.has(m.name.toLowerCase().trim()));

  // v0.14.14: 统一通过 preset 读取（替代直接 config.get）
  // 解析顺序：moa.presets[activePreset] → legacy flat config → isEmpty
  const activePreset = getActivePresetConfig();
  if (activePreset.isEmpty) {
    throw new Error(
      'No preset configured. Run "Moa: Configure Models" to set up refs/aggregator.'
    );
  }
  const refCfg = activePreset.refModels;
  const aggCfg = activePreset.aggregator;

  const refs: ResolvedModel[] = [];
  for (const cfg of refCfg) {
    let m = real.find((x) => (x.id ?? '') === cfg.model);
    if (!m) m = real.find((x) => x.name.toLowerCase().includes(cfg.model.toLowerCase()));
    if (m) refs.push({ model: m, label: cfg.role || m.name });
  }

  if (refs.length === 0) {
    throw new Error(
      `No usable ref models in preset "${activePreset.activeName}". Run "Moa: Configure Models" to set refs.`
    );
  }

  let aggregator: ResolvedModel | undefined;
  if (aggCfg?.model) {
    const aggModelKey = aggCfg.model;
    let m = real.find((x) => (x.id ?? '') === aggModelKey);
    if (!m) m = real.find((x) => x.name.toLowerCase().includes(aggModelKey.toLowerCase()));
    if (m) aggregator = { model: m, label: 'aggregator' };
  }
  if (!aggregator) aggregator = { model: refs[0].model, label: 'aggregator (fallback to first ref)' };

  return { refs, aggregator };
}

// ─────────────────────────────────────────────────────────────────────────
// Ref / aggregator invocation (NO tool schema injection)
// ─────────────────────────────────────────────────────────────────────────

async function callLLM(
  model: vscode.LanguageModelChat,
  systemPrompt: string,
  userPrompt: string,
  token: vscode.CancellationToken,
  label: string
): Promise<string> {
  // @types/vscode 1.95.0 has no .System() factory — prepend system text to user.
  // This is what the rest of the codebase does (moaRunner uses only .User()).
  const messages = [
    vscode.LanguageModelChatMessage.User(systemPrompt + '\n\n---\n\n' + userPrompt),
  ];

  // CRITICAL: do NOT pass tool references here. We want clean LLM calls
  // without 149-tool schema injection. This is the Hermes MoA spirit.
  const response = await model.sendRequest(messages, {}, token);

  let collected = '';
  for await (const chunk of response.text) {
    collected += chunk;
  }
  return collected;
}

function evidenceBlock(evidence: EvidenceItem[]): string {
  if (evidence.length === 0) return '(none yet)';
  return evidence
    .map((e, i) => `${i + 1}. [${e.confidence}] ${e.source}\n   ${e.snippet}`)
    .join('\n');
}

// v0.17.0 cleanup: buildWorkerPrompt / buildAggregatorPrompt / buildFinalPrompt
// 三个旧签名死函数已删除（自 v0.15.0 起被 params 对象签名版本全面替代，无任何调用方）。
// git 历史可查：git log -p src/moaOrchestrator.ts

// ─────────────────────────────────────────────────────────────────────────
// v0.15.0+: Refs / Aggregator prompt builders（params 对象签名）
// ─────────────────────────────────────────────────────────────────────────

/**
 * v0.15.0 wrapper: Refs prompt（新签名）。
 * 内联实现（与 moaCore buildRefPrompt 行为一致），不依赖本地 buildWorkerPrompt。
 */
function buildRefPrompt(params: {
  task: string;
  iteration: number;
  evidenceBlock: string;
  synthesis: string;
  gaps: string[];
  label: string;
}): { system: string; user: string } {
  const system = [
    `You are a Mixture-of-Agents Ref (label: ${params.label}).`,
    '',
    'You are NOT the acting agent — you cannot call tools.',
    'Your role is to analyze the task against the current evidence and surface:',
    '  - new insights the aggregator missed',
    '  - contradictions in the evidence',
    '  - specific gaps that block a confident answer',
    '  - assessment of previous Actor outputs (if evidence contains actor@iterN)',
    '',
    'Respond in JSON ONLY (no prose, no markdown fences):',
    '{',
    '  "analysis": "<3-5 bullets of your perspective>",',
    '  "new_findings": [{"source": "...", "snippet": "...", "confidence": "high|medium|low"}],',
    '  "confidence": <0-1>,',
    '  "identified_gaps": ["<specific missing info>", ...]',
    '}',
    '',
    'Match the language of the task.',
  ].join('\n');

  const user = [
    'TASK:', params.task, '',
    `CURRENT EVIDENCE (iteration ${params.iteration}):`,
    params.evidenceBlock || '(none yet)', '',
    'CURRENT SYNTHESIS (for critique):',
    params.synthesis || '(none yet — first iteration)', '',
    'REMAINING GAPS:',
    params.gaps.length > 0 ? params.gaps.map((g) => '- ' + g).join('\n') : '(none)',
  ].join('\n');

  return { system, user };
}

/**
 * v0.15.0 wrapper: Aggregator prompt（新签名 + 新 next_action 选项）。
 */
function buildAggregatorPromptV2(params: {
  task: string;
  iteration: number;
  evidenceBlock: string;
  refOutputs: Array<{ label: string; output: string }>;
  hasActorHistory: boolean;
}): { system: string; user: string } {
  const system = [
    'You are the MoA aggregator. Synthesize ref outputs into a coherent view.',
    'You also decide whether enough evidence has been gathered to finalize.',
    '',
    'Respond in JSON ONLY:',
    '{',
    '  "synthesis": "<coherent narrative combining ref insights>",',
    '  "evidence_coverage": <0-1, your judgment>,',
    '  "critical_gaps": ["<specific missing info that blocks confidence>", ...],',
    '  "next_action": "finalize" | "actor_needed" | "recon_needed",',
    '  "recon_reason"?: "initial | missing_data | need_deeper_analysis | actor_failed | contradiction",',
    '  "action_items"?: [{ "type": "write_file|execute|create_roadmap|research_more|inform_user", "target": "...", "content": "...", "rationale": "..." }],',
    '}',
    '',
    '## next_action 决策规则',
    '',
    '- "finalize": 任务已完成；evidence_coverage >= 0.8；refs 没有指出新缺失',
    `- "actor_needed": evidence_coverage >= 0.6；refs 指向具体执行动作；${params.hasActorHistory ? '本轮 Actor 还没跑过（即上轮跑过后还没再跑）' : '本任务还没执行过 Actor'}`,
    '- "recon_needed": evidence_coverage < 0.6 OR refs 指出新缺失 OR 有 research_more action',
    '  - 配合 recon_reason 区分场景',
    '',
    '## 节约成本原则',
    '',
    '**不要为了让流程"看起来完整"而强行多轮。**简单任务 1-2 轮就 finalize。',
    '',
    'Match the language of the task.',
  ].join('\n');

  const user = [
    'TASK:', params.task, '',
    `CURRENT EVIDENCE (iteration ${params.iteration}):`,
    params.evidenceBlock || '(none yet)', '',
    `REF OUTPUTS (iteration ${params.iteration}):`,
    ...params.refOutputs.map((r) => '--- ' + r.label + ' ---\n' + r.output), '',
    `ACTOR HISTORY: ${params.hasActorHistory ? '有上轮 Actor 产出（evidence 中以 actor@iterN 标注）' : '无'}`,
  ].join('\n');

  return { system, user };
}

// ─────────────────────────────────────────────────────────────────────────
// JSON extraction (refs may wrap in fences despite instruction)
// ─────────────────────────────────────────────────────────────────────────

function extractJson(text: string): unknown {
  // Strip markdown fences
  let t = text.trim();
  if (t.startsWith('```')) {
    t = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  }
  // Find first { ... last }
  const first = t.indexOf('{');
  const last = t.lastIndexOf('}');
  if (first === -1 || last === -1 || last <= first) {
    throw new Error('No JSON object found in LLM response');
  }
  return JSON.parse(t.substring(first, last + 1));
}

// ─────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────

export async function createOrchestration(task: string): Promise<MoaState> {
  const taskId = 'moa_' + Date.now().toString(36) + '_' + crypto.randomBytes(3).toString('hex');
  // v0.21.1: created_at / last_update 用本地时间戳（便于人工阅读）
  const now = formatLocalTimestamp();

  const state: MoaState = {
    task_id: taskId,
    task,
    created_at: now,
    last_update: now,
    iteration: 0,
    evidence: [],
    synthesis: '',
    gaps: [],
    completeness: 0,
    status: 'awaiting_recon',
    history: [],
    // v0.15.0: 显式初始化新字段，避免 runIteration/render functions 访问 undefined
    planner: undefined,
    actor_history: [],
    recon_history: [],
  };

  await saveState(state);
  const dir = await getTaskDir(taskId);
  await fs.writeFile(path.join(dir, 'task.txt'), task, 'utf8');

  // v0.14.15: 任务创建时立即写一份初始 meta.json + timeline.md，
  // 让用户能在第一轮 refs 跑完前就看到"任务已启动"的状态
  await renderMetaJson(taskId, state);
  await renderTimelineMd(taskId, state);

  // v0.21.0 I-2: 任务开始边界（OutputChannel 尚未懒创建，console 兜底）
  console.log(formatTaskBoundary('started', { task_id: taskId, task }).join('\n'));

  return state;
}

/**
 * v0.15.0: Run one full iteration with 5 roles: Planner → Recon → Refs → Aggregator → Actor.
 *
 * 流程：
 *   1. Planner（仅 iteration 0，调用一次，注入首轮 Recon 方向）
 *   2. Recon（每轮跑，调工具收集证据）
 *   3. Refs（并行，基于 evidence 池分析）
 *   4. Aggregator（综合 + gate 决策：finalize / actor_needed / recon_needed）
 *   5. Actor（仅 actor_needed 时执行，产出进 evidence，下轮 Refs 自然评估）
 *
 * @param taskId               任务 ID
 * @param subagentResult       外部喂料（保留 v0.14.x moa_continue 机制）
 * @param token                取消令牌
 * @param progress             进度回调
 * @param toolInvocationToken  v0.15.0 新增：VSCode 工具调用 token（Recon/Actor 调内置工具必需）
 */
export async function runIteration(
  taskId: string,
  subagentResult: { content: string; source: string } | undefined,
  token: vscode.CancellationToken,
  progress?: (msg: string) => void,
  toolInvocationToken?: vscode.ChatParticipantToolToken,
  options?: {
    /** v0.22.0 P0-1: 入口类型（@moa/@moasingle/moa_analyze/moa_orchestrate） */
    entryType?: string;
  }
): Promise<MoaState> {
  const state = await loadState(taskId);
  if (!state) throw new Error('Task not found: ' + taskId);
  if (state.status === 'finalized') {
    throw new Error('Task already finalized: ' + taskId);
  }

  state.iteration += 1;
  const iterNum = state.iteration;
  progress?.(`[MoA v${EXTENSION_VERSION}] starting iteration ${iterNum}`);

  // v0.17.0: iteration 起始分隔头分别写到 5 个角色的 OutputChannel
  //   ——每个 channel 自成一体（用户在某个角色 channel 里能看到该角色每轮的完整边界）
  // v0.21.1: iter header 用本地时间戳（与 state.json / meta.json 一致）
  const iterHeaderTop = `═══════════════════════════════════════════════════════════════════════`;
  const iterHeaderBody = `=== MoA iteration ${iterNum} started @ ${formatLocalTimestamp()} ===`;
  const iterHeaderTask = `Task: ${state.task}`;
  for (const key of ['planner', 'recon', 'refs', 'aggregator', 'actor'] as PipelineChannelKey[]) {
    logPipeline(key, '');
    logPipeline(key, iterHeaderTop);
    logPipeline(key, iterHeaderBody);
    logPipeline(key, iterHeaderTask);
    logPipeline(key, iterHeaderTop);
  }

  const record: IterationRecord = {
    iteration: iterNum,
    started_at: formatLocalTimestamp(),
    ref_outputs: [],
  };

  // 初始化 v0.15.0 新字段
  if (!state.actor_history) state.actor_history = [];
  if (!state.recon_history) state.recon_history = [];

  // ═══════════════════════════════════════════════════════════════════════
  // 阶段 1：Planner（仅 iteration 0）
  // v0.22.0 P0-1: 升级为 mini-loop + role_setup 输出
  // ═══════════════════════════════════════════════════════════════════════
  let plannerForRecon: PlannerOutput | undefined = state.planner;
  if (iterNum === 1) {
    progress?.(`[MoA Planner] running...`);
    // v0.19.2 §5.1: per-role 耗时记录
    const plannerStart = Date.now();
    // v0.22.0 P0-1: 获取 SystemContext(若任务首次启动,会构建并缓存)
    //   Planner 自己也看 systemContext(基础设施层),用于消化工作环境
    const plannerSysCtx = await getOrBuildSystemContext(taskId, progress);
    const plannerSysCtxText = plannerSysCtx ? renderForRole(plannerSysCtx, 'planner') : undefined;
    // v0.22.0 P0-1: 入口类型注入(从 options.entryType 读取,默认 '@moa' 兼容旧调用)
    const plannerEntryType = options?.entryType ?? '@moa';
    // v0.22.0 P0-7: 从 Role Setup Preset 加载 few-shot 示例(默认空字符串)
    const activePreset = getActivePreset();
    const fewShotsText = renderFewShots(activePreset);
    plannerForRecon = await callPlanner(state.task, token, progress, {
      entryType: plannerEntryType,
      systemContextText: plannerSysCtxText,
      fewShotsText,
    });
    record.planner_elapsed_sec = (Date.now() - plannerStart) / 1000;
    state.planner = plannerForRecon;
    record.planner_output = plannerForRecon;
    if (plannerForRecon) {
      await saveIterationArtifact(taskId, iterNum, 'planner.json', plannerForRecon, {
        role: 'planner',
      });
      // v0.17.0: 把 Planner 输出写到 "MoA Planner" OutputChannel
      logPipelineBlock('planner', `--- Planner @iter${iterNum} (${record.planner_elapsed_sec.toFixed(1)}s) ---`, JSON.stringify(plannerForRecon, null, 2));
      // v0.21.0 I-2: 结构化日志
      logPipelineStructured('planner', {
        iter: iterNum,
        role: 'Planner',
        elapsed_sec: record.planner_elapsed_sec,
        event: 'response',
        details: {
          sub_questions: (plannerForRecon.sub_questions ?? []).length,
          recon_hints: (plannerForRecon.recon_hints ?? []).length,
        },
      });
    } else {
      logPipelineBlock('planner', `--- Planner @iter${iterNum} (${record.planner_elapsed_sec.toFixed(1)}s, failed/skipped) ---`, '(no output)');
      logPipelineStructured('planner', {
        iter: iterNum,
        role: 'Planner',
        elapsed_sec: record.planner_elapsed_sec,
        event: 'skipped',
      });
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // 阶段 2：Recon（每轮跑）
  // ═══════════════════════════════════════════════════════════════════════
  let reconReason: ReconReason = iterNum === 1 ? 'initial' : 'missing_data';
  // 如果上轮 aggregator 标了 recon_reason，用它
  const lastAgg = state.history.length > 0 ? state.history[state.history.length - 1].aggregator_output : undefined;
  if (lastAgg?.recon_reason) {
    reconReason = lastAgg.recon_reason;
  }

  // 检查上轮 Actor 是否失败 → recon_reason='actor_failed'
  const lastActor = state.actor_history.length > 0 ? state.actor_history[state.actor_history.length - 1] : undefined;
  if (lastActor && !lastActor.self_assessment.all_succeeded) {
    reconReason = 'actor_failed';
  }

  // 接受外部 subagentResult（v0.14.x moa_continue 机制，向后兼容）
  // 如果有外部喂料，跳过内置 Recon，直接用外部结果
  let reconResult: ReconResult | undefined;
  if (subagentResult) {
    record.recon_result_external = subagentResult;
    reconResult = {
      summary: subagentResult.content,
      tool_calls: 0,
      elapsed_sec: 0,
      log: [],
    };
    record.recon_result = reconResult;
    record.recon_reason = 'missing_data';  // 外部喂料视为补缺数据
    state.evidence.push({
      source: subagentResult.source || `subagent@iter${iterNum}`,
      snippet: subagentResult.content.length > 4000
        ? subagentResult.content.substring(0, 4000) + '\n...(truncated)'
        : subagentResult.content,
      confidence: 'high',
    });
    progress?.(`[MoA] ingested external subagent result from ${subagentResult.source} (${subagentResult.content.length} chars)`);
    // v0.17.0: 外部喂料也写 "MoA Recon" OutputChannel
    logPipelineBlock(
      'recon',
      `--- Recon (external @iter${iterNum}, source=${subagentResult.source}, ${subagentResult.content.length} chars) ---`,
      subagentResult.content
    );
  } else {
    // 内置 Recon（v0.18.0: 支持并行多模型 + Recon Aggregator 整合）
    progress?.(`[MoA Recon] iteration ${iterNum}, reason=${reconReason}`);
    const evidenceBrief = buildEvidenceBrief(state.evidence);
    const actorLog = lastActor ? formatActorLog(lastActor) : undefined;

    // v0.19.2 §5.1: per-role 耗时记录
    const reconStart = Date.now();
    // v0.22.0 P0-5: 获取(或构建并缓存)SystemContext,渲染 Recon 可见的 4 段
    const sysCtx = await getOrBuildSystemContext(taskId, progress);
    const reconSysCtxText = sysCtx ? renderForRole(sysCtx, 'recon') : undefined;
    const callResult = await callRecon({
      userPrompt: state.task,
      planner: plannerForRecon,
      reason: reconReason,
      gaps: state.gaps,
      actorLog,
      evidenceBrief,
      iteration: iterNum,
      systemContextText: reconSysCtxText,
      // v0.22.0 P0-7: role_setup 渲染为 roleSetupText 注入到 Recon
      roleSetupText: plannerForRecon?.role_setup?.recon?.tone
        ? renderRoleSetup({
            tone: plannerForRecon.role_setup.recon.tone,
            perspective: plannerForRecon.role_setup.recon.perspective ?? '',
            tool_priority: plannerForRecon.role_setup.recon.tool_priority,
            cautions: plannerForRecon.role_setup.recon.cautions,
          })
        : undefined,
      // v0.22.0 P0-7: Planner 驱动模式下,透传 recon_aggregator role_setup
      reconAggregatorRoleSetup: plannerForRecon?.role_setup?.recon_aggregator,
    }, token, progress, undefined, toolInvocationToken);
    record.recon_elapsed_sec = (Date.now() - reconStart) / 1000;

    // v0.18.0 方案 B：无论单/并行模式，reconResult 都是 Aggregator merged 的
    //   （下游 refs 看到的格式一致，不关心上游几个模型）
    //
    // 落盘约定：
    //   - iteration_NNN/recon_result.json  始终写，是 Aggregator 整合后的 summary
    //   - iteration_NNN/recon/<label>.json v0.22.0 P0-4: 始终写(无论单/并行模式)
    //     用户原话:"原始的 recon capture 也应该落盘,因此到底什么情况,也可以复盘查询"
    reconResult = callResult.merged;

    // v0.22.0 P0-4: 改为始终落盘(原 v0.18.0 仅并行模式落盘)
    //   单模式也落盘便于复盘(对齐 docs/moa-role-design-philosophy-v2.md §4.1)
    for (const r of callResult.results) {
      await saveIterationArtifact(taskId, iterNum, `recon/${r.label}.json`, r, {
        role: `recon/${r.label}`,
        model: r.model,
      });
      const header = r.result.error
        ? `--- ${r.label} (${r.model}) FAILED ---`
        : `--- ${r.label} (${r.model}): ${r.result.tool_calls} calls, ${r.result.elapsed_sec.toFixed(1)}s ---`;
      logPipelineBlock('recon', header, r.result.summary || '(no summary)');
      // v0.21.0 I-2: 结构化日志
      logPipelineStructured('recon', {
        iter: iterNum,
        role: `Recon/${r.label}`,
        model: r.model,
        elapsed_sec: r.result.elapsed_sec,
        event: r.result.error ? 'failed' : 'completed',
        details: {
          tool_calls: r.result.tool_calls,
          summary_chars: (r.result.summary ?? '').length,
        },
      });
    }

    // Recon Aggregator 的 merged summary 始终写到 "MoA Recon" channel
    //   （单模式也写，让用户看到 Aggregator 整理后的结果）
    logPipelineBlock(
      'recon',
      `--- Recon Aggregator (${callResult.aggregatorModel}) ${callResult.mode === 'parallel' ? 'merged' : 'normalized'} ---`,
      callResult.merged.summary || '(no merged summary)'
    );
    // v0.21.0 I-2: Recon Aggregator 结构化日志
    logPipelineStructured('recon', {
      iter: iterNum,
      role: 'ReconAggregator',
      model: callResult.aggregatorModel,
      elapsed_sec: record.recon_elapsed_sec,
      event: callResult.mode === 'parallel' ? 'merge' : 'normalize',
      details: {
        mode: callResult.mode,
        parallel_count: callResult.mode === 'parallel' ? callResult.results.length : 1,
      },
    });

    // 统一落盘 recon_result.json（含 Aggregator 元信息）
    await saveIterationArtifact(taskId, iterNum, 'recon_result.json', {
      ...reconResult,
      // v0.18.0 扩展字段（让审计时能看出是单/并行 + Aggregator 用的什么模型）
      recon_mode: callResult.mode,
      aggregator_model: callResult.aggregatorModel,
      parallel_sources: callResult.mode === 'parallel'
        ? callResult.results.map((r) => ({
            label: r.label,
            model: r.model,
            tool_calls: r.result.tool_calls,
            error: r.result.error,
          }))
        : undefined,
    }, {
      role: 'recon_aggregator',
      model: callResult.aggregatorModel,
    });

    record.recon_result = reconResult;
    record.recon_reason = reconReason;

    // 把 Recon merged summary 加入 evidence（始终是 Aggregator 整理过的）
    if (reconResult.summary && !reconResult.error) {
      state.evidence.push({
        source: `recon@iter${iterNum}`,
        snippet: reconResult.summary.length > 8000
          ? reconResult.summary.substring(0, 8000) + '\n...(truncated)'
          : reconResult.summary,
        confidence: 'high',
      });
    }
    state.recon_history.push(reconResult);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // 阶段 3：Refs（并行）
  // ═══════════════════════════════════════════════════════════════════════
  const { refs, aggregator } = await resolveRefModels();
  progress?.(`[MoA Refs] using ${refs.length} refs + aggregator ${aggregator.label}`);

  const refModelNames = refs.map((r) => r.model.name);
  const aggregatorModelName = aggregator.model.name;

  const evidenceBlockStr = evidenceBlock(state.evidence);

  // v0.19.2 §5.1: per-role 耗时记录（refs 整体并行，记总耗时）
  const refsStart = Date.now();
  const refPromises = refs.map((r) => {
    const { system, user } = buildRefPrompt({
      task: state.task,
      iteration: iterNum,
      evidenceBlock: evidenceBlockStr,
      synthesis: state.synthesis,
      gaps: state.gaps,
      label: r.label,
    });
    return callLLM(r.model, system, user, token, r.label).then(
      (output) => ({ label: r.label, model: r.model.name, output, error: undefined as string | undefined }),
      (err) => ({
        label: r.label,
        model: r.model.name,
        output: '',
        error: err instanceof Error ? err.message : String(err),
      })
    );
  });
  const refOutputs = await Promise.all(refPromises);
  record.refs_elapsed_sec = (Date.now() - refsStart) / 1000;
  record.ref_outputs = refOutputs;

  // v0.16.0: 只写 refs/ 目录（之前 v0.15.0 为兼容 v0.14.x 同时写 workers/ 目录，
  // 但实际无任何代码读 workers/<label>.json 文件——所有读取都走 state.history[].ref_outputs
  // 字段。双写导致落盘文件重复，占用磁盘 + 让用户困惑"两份一样的是不是 bug"）。
  for (const r of refOutputs) {
    await saveIterationArtifact(taskId, iterNum, `refs/${r.label}.json`, r, {
      role: `refs/${r.label}`,
      model: r.model,
    });
    // v0.17.0: 把每个 Ref 的原始输出写到 "MoA Refs" OutputChannel
    // （失败的 ref 也写，便于排查）
    const refHeader = r.error
      ? `--- Ref ${r.label} (${r.model}) @iter${iterNum} FAILED ---`
      : `--- Ref ${r.label} (${r.model}) @iter${iterNum} ---`;
    logPipelineBlock('refs', refHeader, r.error ? `Error: ${r.error}` : r.output);
    // v0.21.0 I-2: 结构化日志
    logPipelineStructured('refs', {
      iter: iterNum,
      role: `Refs/${r.label}`,
      model: r.model,
      event: r.error ? 'failed' : 'response',
      details: r.error
        ? { error_chars: r.error.length }
        : { output_chars: r.output.length },
    });
  }
  progress?.(`[MoA Refs] ${refOutputs.filter((r) => !r.error).length}/${refOutputs.length} refs succeeded`);

  // ═══════════════════════════════════════════════════════════════════════
  // 阶段 4：Aggregator（Gate 决策）
  // ═══════════════════════════════════════════════════════════════════════
  const successfulRefOutputs = refOutputs.filter((r) => !r.error && r.output);
  if (successfulRefOutputs.length === 0) {
    state.status = 'error';
    state.error = `All refs failed in iteration ${iterNum}`;
    state.history.push(record);
    await saveState(state);
    return state;
  }

  const { system: aggSys, user: aggUser } = buildAggregatorPromptV2({
    task: state.task,
    iteration: iterNum,
    evidenceBlock: evidenceBlockStr,
    refOutputs: successfulRefOutputs.map((r) => ({ label: r.label, output: r.output })),
    hasActorHistory: (state.actor_history?.length ?? 0) > 0,
  });

  let aggOutput: CoreAggregatorOutput;
  try {
    // v0.19.2 §5.1: per-role 耗时记录
    const aggregatorStart = Date.now();
    const aggRaw = await callLLM(aggregator.model, aggSys, aggUser, token, 'aggregator');
    record.aggregator_elapsed_sec = (Date.now() - aggregatorStart) / 1000;
    aggOutput = extractJson(aggRaw) as CoreAggregatorOutput;
    record.aggregator_output = aggOutput;
    await saveIterationArtifact(taskId, iterNum, 'aggregator.json', aggOutput, {
      role: 'aggregator',
      model: aggregator.model.name,
    });
    // v0.17.0: 把 Aggregator 原始输出 + 解析后 JSON 都写到 "MoA Aggregator" OutputChannel
    // raw 输出可能含 LLM 的 fence / 解释，parsed 是干净 JSON，都保留便于排查
    logPipelineBlock('aggregator', `--- Aggregator @iter${iterNum} (raw, ${aggregator.model.name}, ${record.aggregator_elapsed_sec.toFixed(1)}s) ---`, aggRaw);
    logPipelineBlock('aggregator', `--- Aggregator @iter${iterNum} (parsed) ---`, JSON.stringify(aggOutput, null, 2));
    // v0.21.0 I-2: 结构化日志（含 completeness / next_action）
    logPipelineStructured('aggregator', {
      iter: iterNum,
      role: 'Aggregator',
      model: aggregator.model.name,
      elapsed_sec: record.aggregator_elapsed_sec,
      event: 'fuse',
      details: {
        completeness: aggOutput.evidence_coverage.toFixed(2),
        next_action: aggOutput.next_action,
        action_items: (aggOutput.action_items ?? []).length,
        gaps: (aggOutput.critical_gaps ?? []).length,
      },
    });
  } catch (err) {
    state.status = 'error';
    state.error = `Aggregator failed in iteration ${iterNum}: ${err instanceof Error ? err.message : String(err)}`;
    state.history.push(record);
    await saveState(state);
    // v0.17.0: Aggregator 失败也写 "MoA Aggregator" OutputChannel
    logPipelineBlock(
      'aggregator',
      `--- Aggregator FAILED @iter${iterNum} ---`,
      `Error: ${err instanceof Error ? err.message : String(err)}`
    );
    return state;
  }

  // 更新 state
  state.synthesis = aggOutput.synthesis;
  state.completeness = aggOutput.evidence_coverage;
  state.gaps = aggOutput.critical_gaps ?? [];

  // 提取 ref 的 new_findings 进 evidence
  for (const r of refOutputs) {
    if (r.error || !r.output) continue;
    try {
      const parsed = extractJson(r.output) as RefOutput;
      if (Array.isArray(parsed.new_findings)) {
        for (const f of parsed.new_findings.slice(0, 3)) {
          if (f.source && f.snippet) {
            state.evidence.push({
              source: f.source,
              snippet: f.snippet,
              confidence: f.confidence || 'medium',
            });
          }
        }
      }
    } catch {
      // ref 输出非 JSON，跳过提取
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // 阶段 5：Gate 决策（finalize / actor_needed / recon_needed）
  // ═══════════════════════════════════════════════════════════════════════
  // v0.18.4: 调整 gate 顺序——actor_needed 必须在 shouldStop 之前判断。
  //
  // 历史背景（v0.18.3 及之前）：
  //   原 gate 顺序为 max_iter → finalize → shouldStop → actor_needed。
  //   当 Aggregator 连续 3 轮要求 actor_needed 但 completeness 不变时，
  //   shouldStop() 会先返回 true，在 Actor 真正执行前就强制 finalize，
  //   导致 Actor 角色整轮空跑（timeline 中 Actor 列为 0/0）。
  //
  // v0.18.4 修复：
  //   actor_needed gate 提前到 shouldStop 之前。这样当 Aggregator 要求
  //   执行 Actor 时，先真正跑完 Actor，下一轮 Refs 自然评估 Actor 产出，
  //   completeness 会上升，shouldStop 不再误触发。
  //
  // 硬保底：iteration 上限
  if (state.iteration >= MAX_ITER) {
    state.status = 'finalized';
    state.convergence_source = 'max_iter';
    state.convergence_raw_next_action = aggOutput.next_action;
    progress?.(`[MoA] MAX_ITER=${MAX_ITER} reached, forcing finalize (last aggregator suggestion: ${aggOutput.next_action})`);
  } else if (aggOutput.next_action === 'finalize') {
    state.status = 'finalized';
    state.convergence_source = 'natural';
    state.convergence_raw_next_action = aggOutput.next_action;
    progress?.(`[MoA] naturally converged at iteration ${iterNum}, completeness=${state.completeness.toFixed(2)}`);
  } else if (aggOutput.next_action === 'actor_needed' && aggOutput.action_items && aggOutput.action_items.length > 0) {
    // v0.19.0 §2: 接线 moa.enableActorInLoop 配置项
    //
    // 设计哲学：
    //   - 默认 false（保守原则）——Actor 有副作用（写文件、跑终端命令）
    //   - 与 moa.enableActingAgent 独立（后者控制 moaRunner 单次模式）
    //   - 关闭时降级为 recon_needed，让 Loop 继续（而不是卡死或空跑）
    //
    // 关键：v0.18.4 修复 gate 顺序后，Actor 确实会执行，但 Layer 2 bug
    //      （actingAgent 撞 iteration cap 时 finalOutput 为空）会导致
    //      executed_actions=[]。v0.19.0 §1 已修复 Layer 2，但默认仍关闭
    //      Actor，让用户显式启用。
    const actorEnabled = vscode.workspace.getConfiguration('moa').get<boolean>('enableActorInLoop', false);
    if (!actorEnabled) {
      // Actor 被禁用，降级为 recon_needed（让 Loop 继续）
      progress?.(
        `[MoA] Actor disabled by config (moa.enableActorInLoop=false). ` +
        `Downgrading actor_needed → recon_needed. ` +
        `Enable Actor in Settings to execute action_items.`
      );
      logPipelineBlock('actor',
        `--- Actor @iter${iterNum} SKIPPED (moa.enableActorInLoop=false) ---`,
        `Aggregator suggested ${aggOutput.action_items.length} action(s) but Actor is disabled.\n` +
        `Downgrading to recon_needed. The next iteration's Recon will investigate the same gaps.\n` +
        `To enable Actor, set "moa.enableActorInLoop": true in Settings.`
      );
      state.status = 'running';
      // 标记当前轮为"actor 被跳过"，让下轮 Recon 接手 gaps
      if (state.gaps.length === 0 && aggOutput.critical_gaps && aggOutput.critical_gaps.length > 0) {
        state.gaps = [...aggOutput.critical_gaps];
      }
    } else {
      // Actor 启用，正常执行（v0.18.4 gate 顺序已修复 + v0.19.0 §1 Layer 2 已修复）
      progress?.(`[MoA Actor] running with ${aggOutput.action_items.length} action(s)...`);
      // v0.19.1 §3: 传入 taskDir 以启用 SafeExecutor（保守执行模式）
      const actorTaskDir = await getTaskDir(taskId);
      // v0.22.0 P0-5: 复用任务的 SystemContext(已由 Recon 阶段构建并缓存),渲染 Actor 可见的 4 段
      const actorSysCtx = _systemContextCache.get(taskId);
      const actorSysCtxText = actorSysCtx ? renderForRole(actorSysCtx, 'actor') : undefined;
      const actorResult = await callActor({
        task: state.task,
        actionItems: aggOutput.action_items,
        iteration: iterNum,
        taskDir: actorTaskDir,
        systemContextText: actorSysCtxText,
        // v0.22.0 P0-7: role_setup 渲染为 roleSetupText 注入到 Actor
        roleSetupText: plannerForRecon?.role_setup?.actor?.tone
          ? renderRoleSetup({
              tone: plannerForRecon.role_setup.actor.tone,
              perspective: plannerForRecon.role_setup.actor.perspective ?? '',
              tool_priority: plannerForRecon.role_setup.actor.tool_priority,
              cautions: plannerForRecon.role_setup.actor.cautions,
            })
          : undefined,
      }, token, progress, undefined, toolInvocationToken);
      record.actor_result = actorResult;
      state.actor_history.push(actorResult);
      await saveIterationArtifact(taskId, iterNum, 'actor_result.json', actorResult, {
        role: 'actor',
      });

      // v0.17.0: 把 Actor 执行结果写到 OutputChannel
      //   - 每个 action_item 的 status / artifacts / error_message
      //   - self_assessment（all_succeeded / should_recon）
      const actorLogLines: string[] = [];
      actorLogLines.push(`Elapsed: ${actorResult.elapsed_sec.toFixed(1)}s | Tool calls: ${actorResult.tool_calls}`);
      actorLogLines.push('');
      actorLogLines.push('Executed actions:');
      for (let i = 0; i < actorResult.executed_actions.length; i++) {
        const ar = actorResult.executed_actions[i];
        actorLogLines.push(
          `  ${i + 1}. [${ar.action.type}] ${ar.action.target} → ${ar.status}` +
          (ar.error_message ? ` (${ar.error_message})` : '') +
          (ar.artifacts.length > 0 ? ` [${ar.artifacts.join(', ')}]` : '')
        );
      }
      actorLogLines.push('');
      actorLogLines.push(
        `Self-assessment: all_succeeded=${actorResult.self_assessment.all_succeeded}, ` +
        `should_recon=${actorResult.self_assessment.should_recon}, ` +
        `reason=${actorResult.self_assessment.reason}`
      );
      if (actorResult.error) {
        actorLogLines.push('');
        actorLogLines.push(`Actor error: ${actorResult.error}`);
      }
      logPipelineBlock('actor', `--- Actor @iter${iterNum} ---`, actorLogLines.join('\n'));
      if (actorResult.error) {
        logPipelineBlock('actor', `--- Actor FAILED @iter${iterNum} ---`, actorResult.error);
      }
      // v0.21.0 I-2: 结构化日志
      const executedN = actorResult.executed_actions.length;
      const succeededN = actorResult.executed_actions.filter((a) => a.status === 'success').length;
      const failedN = executedN - succeededN;
      logPipelineStructured('actor', {
        iter: iterNum,
        role: 'Actor',
        elapsed_sec: actorResult.elapsed_sec,
        event: actorResult.error ? 'failed' : 'completed',
        details: {
          executed: executedN,
          succeeded: succeededN,
          failed: failedN,
          tool_calls: actorResult.tool_calls,
          all_succeeded: actorResult.self_assessment.all_succeeded,
        },
      });

      // Actor 产出进 evidence（high confidence，下轮 Refs 自然评估质量）
      // v0.15.0 hotfix 1: Actor LLM 经常不回填 action.content，必须防御性访问
      //   （否则抛 "Cannot read properties of undefined (reading 'length')"，导致 history 不入栈）
      for (const ar of actorResult.executed_actions) {
        const ev = buildActorEvidence(ar, iterNum);
        if (ev) state.evidence.push(ev);
      }
      // 状态设为 running，下轮 Recon 会读 Actor 产出
      state.status = 'running';
      progress?.(`[MoA] iteration ${iterNum} complete (Actor done), continuing to next iteration`);
    }
  } else if (shouldStop(state)) {
    // v0.18.4: shouldStop gate 移到 actor 之后，避免 Actor 还没跑就被杀
    state.status = 'finalized';
    state.convergence_source = 'should_stop';
    state.convergence_raw_next_action = aggOutput.next_action;
    progress?.(`[MoA] shouldStop() triggered at iteration ${iterNum}, forcing finalize (last aggregator suggestion: ${aggOutput.next_action})`);
  } else {
    // recon_needed：什么都不做，下一轮 Recon 自然会基于 gaps 调查
    state.status = 'running';
    // 兼容 v0.14.x：写一份 recon_request.json（虽然现在不用主会话喂了）
    if (state.gaps.length > 0) {
      record.recon_request = {
        gaps: state.gaps,
        prompt: '(v0.15.0 auto-recon — main session does not need to feed back)',
      };
      await saveIterationArtifact(taskId, iterNum, 'recon_request.json', record.recon_request, {
        role: 'recon_request',
      });
    }
    progress?.(`[MoA] iteration ${iterNum} complete (recon_needed), continuing with reason=${aggOutput.recon_reason ?? 'missing_data'}`);
  }

  // v0.17.0: iteration 结尾汇总写到 "MoA Aggregator" OutputChannel
  //   —— 这些字段（completeness / next_action / status）本质上是 Aggregator 决策的产物，
  //   归在 aggregator channel 最合适，用户看 Aggregator 时能完整看到决策结果。
  logPipeline('aggregator', '');
  logPipeline('aggregator', `--- iteration ${iterNum} summary ---`);
  logPipeline('aggregator', `  status:         ${state.status}`);
  logPipeline('aggregator', `  completeness:   ${state.completeness.toFixed(2)}`);
  logPipeline('aggregator', `  gaps count:     ${state.gaps.length}`);
  logPipeline('aggregator', `  evidence items: ${state.evidence.length}`);
  logPipeline('aggregator', `  next_action:    ${aggOutput.next_action}`);
  if (state.convergence_source) {
    logPipeline('aggregator', `  convergence:    ${state.convergence_source}`);
  }
  logPipeline('aggregator', `=== iteration ${iterNum} complete @ ${formatLocalTimestamp()} ===`);
  logPipeline('aggregator', '');

  state.history.push(record);
  await saveState(state);

  // v0.14.15+: 渲染 MD 视图
  await renderMetaJson(taskId, state, refModelNames, aggregatorModelName);
  await renderTimelineMd(taskId, state);

  // v0.15.0 hotfix: 自动收敛时（next_action='finalize' 或 MAX_ITER 或 shouldStop）
  // 直接调 finalizeTask 生成 final.md/final.json + 再次覆盖 meta/timeline。
  // 否则用户看到 status=finalized 但 final.md 缺失，需要手动再调 #moa_finalize。
  // 注意：finalizeTask 内部会重新 saveState + render，开销可接受（多 1 次 LLM 调用做 summary）。
  if (state.status === 'finalized') {
    progress?.(`[MoA] auto-finalizing at iteration ${iterNum}, generating final.md...`);
    try {
      await finalizeTask(taskId, token);
    } catch (err) {
      // finalizeTask 失败不应阻塞 runIteration 返回（state 已 finalize）
      progress?.(`[MoA] auto-finalize warning: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return state;
}

/**
 * v0.15.0: 构建给 Recon prompt 用的 evidence 摘要（防止重复查）。
 */
function buildEvidenceBrief(evidence: EvidenceItem[]): string {
  if (evidence.length === 0) return '';
  // 取最近 8 条作为 brief
  const recent = evidence.slice(-8);
  return recent.map((e, i) => `${i + 1}. [${e.confidence}] ${e.source}: ${e.snippet.substring(0, 200)}${e.snippet.length > 200 ? '...' : ''}`).join('\n');
}

/**
 * v0.15.0: 格式化 Actor 日志供 Recon prompt 用。
 */
function formatActorLog(actor: ActorResult): string {
  const lines: string[] = [];
  for (const ar of actor.executed_actions) {
    lines.push(`- [${ar.action.type}] ${ar.action.target}: ${ar.status}${ar.error_message ? ' (' + ar.error_message + ')' : ''}`);
  }
  lines.push(`Self-assessment: all_succeeded=${actor.self_assessment.all_succeeded}, should_recon=${actor.self_assessment.should_recon}, reason=${actor.self_assessment.reason}`);
  return lines.join('\n');
}

function buildReconPrompt(state: MoaState): string {
  return [
    'You are a MoA recon subagent.',
    '',
    'Task context:',
    state.task,
    '',
    'The aggregator has identified the following gaps that must be filled:',
    ...state.gaps.map((g, i) => `${i + 1}. ${g}`),
    '',
    'For each gap, gather concrete evidence (read files, search code, fetch URLs, etc.).',
    'Return a single Markdown block with your findings, including source paths.',
  ].join('\n');
}

function shouldStop(state: MoaState): boolean {
  if (state.iteration >= MAX_ITER) return true;
  if (state.completeness >= COMPLETENESS_THRESHOLD && state.gaps.length === 0) return true;

  // Convergence detection: last N iterations show no completeness growth
  const tail = state.history.slice(-CONVERGENCE_WINDOW);
  if (tail.length === CONVERGENCE_WINDOW) {
    const aggOutputs = tail
      .map((r) => r.aggregator_output?.evidence_coverage ?? 0);
    const allEqual = aggOutputs.every((v) => v === aggOutputs[0]);
    const noGapsChange = tail.every((r) => {
      const gapsLen = r.aggregator_output?.critical_gaps?.length ?? 0;
      return gapsLen === (tail[0].aggregator_output?.critical_gaps?.length ?? 0);
    });
    if (allEqual && noGapsChange) return true;
  }

  return false;
}

export async function finalizeTask(
  taskId: string,
  token: vscode.CancellationToken
): Promise<MoaFinalOutput> {
  const state = await loadState(taskId);
  if (!state) throw new Error('Task not found: ' + taskId);

  const { aggregator } = await resolveRefModels();
  // v0.17.0: 改用 moaCore 的 buildFinalPrompt（params 对象签名）
  //   旧的本地 buildFinalPrompt(task, state) 已删除（死代码）
  const { system, user } = buildFinalPromptCore({
    task: state.task,
    synthesis: state.synthesis,
    evidence: state.evidence,
    iterations: state.iteration,
    completeness: state.completeness,
  });
  const raw = await callLLM(aggregator.model, system, user, token, 'finalizer');

  let parsed: Partial<MoaFinalOutput>;
  try {
    parsed = extractJson(raw) as Partial<MoaFinalOutput>;
  } catch {
    parsed = {
      summary: raw,
      action_items: [],
      confidence: state.completeness,
      unresolved: state.gaps,
    };
  }

  // v0.17.0: 把 finalizer raw + parsed 写到 "MoA Aggregator" OutputChannel
  //   —— finalizer 本质是 aggregator 在收敛后做的 summary，归在 aggregator channel 合理
  logPipelineBlock('aggregator', `--- Finalizer (raw, ${aggregator.model.name}) ---`, raw);
  logPipelineBlock('aggregator', '--- Finalizer (parsed) ---', JSON.stringify(parsed, null, 2));

  const output: MoaFinalOutput = {
    task_id: taskId,
    summary: parsed.summary || '(no summary produced)',
    action_items: Array.isArray(parsed.action_items) ? parsed.action_items : [],
    // v0.16.0: confidence 统一用 state.completeness（Aggregator 在每轮迭代里的真实评估）
    // 不再采用 finalizer 阶段 Aggregator 给的 confidence（那个是「强制收尾时再问一次」的值，
    // 与迭代过程中的 completeness 打架，导致 55% vs 90% 不一致）
    confidence: state.completeness,
    unresolved: Array.isArray(parsed.unresolved) ? parsed.unresolved : state.gaps,
    iterations_used: state.iteration,
  };

  state.status = 'finalized';
  // v0.16.0: 标记收敛来源（finalizeTask 被显式调用时，说明不是 runIteration 自动收敛）
  // 如果上游已经设了 convergence_source（如 single_shot），保留它
  if (!state.convergence_source) {
    state.convergence_source = 'manual_finalize';
  }
  state.history = state.history;  // unchanged
  await saveState(state);

  // v0.22.0 P0-5: 任务 finalize 后清理 SystemContext 缓存
  //   (避免长寿命进程中累积多个任务的 systemContext)
  clearTaskSystemContext(taskId);

  const dir = await getTaskDir(taskId);
  await fs.writeFile(path.join(dir, 'final.json'), JSON.stringify(output, null, 2), 'utf8');

  // v0.14.15: 渲染 MD 视图
  // - final.md（仅此处生成，含 action_items + summary + 元信息头）
  // - 再次覆盖 meta.json（补 finished_at + final_confidence）
  // - 再次覆盖 timeline.md（状态变为 finalized，Convergence Notes 显示收敛）
  await renderFinalMd(taskId, output, state);
  await renderMetaJson(taskId, state);
  await renderTimelineMd(taskId, state);

  // v0.20.0: autopilot 触发（executionPreset 控制）。
  // 仅当 execConfig.autoExecute=true 时执行 finalize 后的 action_items。
  // 默认 `manual` preset 不触发（与 v0.19.x 行为兼容）。
  // `yolo` preset 关闭 SafeExecutor backup，但 Actor 仍跑（用户对效率极致追求）。
  const execConfigFinal = resolveExecutionConfig();
  if (execConfigFinal.autoExecute && output.action_items.length > 0) {
    try {
      logPipelineBlock('actor', `--- Autopilot triggered (executionPreset=${execConfigFinal.preset}) ---`,
        `Executing ${output.action_items.length} action_items for task ${taskId}`);
      const execResult = await executeFinalActions(taskId, output.action_items, state.task, token);
      // 把执行结果合并进 output（不重新写 final.json，避免破坏 finalize 时间戳）
      (output as MoaFinalOutput & { executed_actions?: unknown[] }).executed_actions = execResult.executed_actions;
      logPipelineBlock('actor', `--- Autopilot completed ---`, JSON.stringify(execResult.executed_actions.length) + ' action(s) executed');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logPipelineBlock('actor', `--- Autopilot failed ---`, msg);
      // autopilot 失败不阻塞 finalize 返回（已收敛的任务结果完整保留）
    }
  }

  // v0.21.0 I-2: 任务结束边界（只广播到懒创建过的 channel）
  const finalizeLines = formatTaskBoundary('finalized', {
    task_id: taskId,
    task: state.task,
    iter: state.iteration,
    extra: {
      completeness: state.completeness.toFixed(2),
      convergence: state.convergence_source ?? 'unknown',
    },
  });
  for (const key of Object.keys(_pipelineChannels) as PipelineChannelKey[]) {
    for (const line of finalizeLines) {
      logPipeline(key, line);
    }
  }

  return output;
}

/**
 * v0.20.0: 执行 finalize 后 action_items（actor autopilot）。
 *
 * 复用 src/moaCore/runActor.ts 的 callActor，通过 resolveExecutionConfig()
 * 拿到生效的 approvalMode + safeMode。SafeExecutor 的 manifest.json 自动
 * 追加本轮（iter=-1 表示 finalize 后路径）记录。
 *
 * @returns ActorResult（executeFinalActions 直接返回它，让调用方按需展示）
 */
export async function executeFinalActions(
  taskId: string,
  actionItems: MoaFinalOutput['action_items'],
  taskText: string,
  token: vscode.CancellationToken,
  options?: {
    progress?: (msg: string) => void;
    stream?: vscode.ChatResponseStream;
    toolInvocationToken?: vscode.ChatParticipantToolToken;
  }
): Promise<ActorResult> {
  const dir = await getTaskDir(taskId);
  const progress = options?.progress ?? ((msg: string) => logPipelineBlock('actor', msg, ''));

  // 过滤可执行类型（research_more 留给 recon，inform_user 仅展示不需执行）
  const executableTypes = new Set(['write_file', 'execute', 'create_roadmap']);
  const executable = actionItems.filter((a) => executableTypes.has(a.type));
  if (executable.length === 0) {
    progress?.(`[executeFinalActions] No executable action_items (all are research_more/inform_user); skipping`);
    return {
      executed_actions: [],
      self_assessment: {
        all_succeeded: true,
        missing_dependencies: [],
        should_recon: false,
        reason: 'No executable action_items to execute',
      },
      elapsed_sec: 0,
      tool_calls: 0,
    };
  }

  progress?.(`[executeFinalActions] Executing ${executable.length}/${actionItems.length} executable action(s)`);

  // 写 autopilot.log（人类可读执行日志）
  const logPath = path.join(dir, 'autopilot.log');
  const logLines: string[] = [
    `# MoA Autopilot Log`,
    `# task_id: ${taskId}`,
    `# started_at: ${formatLocalTimestamp()}`,
    `# action_items: ${executable.length}`,
    ``,
  ];

  const execConfig = resolveExecutionConfig();
  progress?.(`[executeFinalActions] executionPreset=${execConfig.preset} | approvalMode=${execConfig.approvalMode}`);

  const result = await callActor({
    task: taskText,
    actionItems: executable,
    iteration: -1,  // 哨兵值：标记"finalize 后"路径（区别于 Loop 内 Actor 的正数 iter）
    taskDir: dir,
  }, token, progress, options?.stream, options?.toolInvocationToken);

  logLines.push(
    `# completed_at: ${formatLocalTimestamp()}`,
    `# elapsed_sec: ${result.elapsed_sec.toFixed(2)}`,
    `# tool_calls: ${result.tool_calls}`,
    `# self_assessment: ${JSON.stringify(result.self_assessment)}`,
    ``,
    `## Executed actions (${result.executed_actions.length})`,
    ...result.executed_actions.map((a, i) => {
      const lines: string[] = [];
      lines.push(`${i + 1}. [${a.status}] ${a.action.type} ${a.action.target}`);
      if (a.action.rationale) lines.push(`   Rationale: ${a.action.rationale.substring(0, 200)}`);
      if (a.error_message) lines.push(`   Error: ${a.error_message.substring(0, 200)}`);
      if (a.artifacts.length > 0) lines.push(`   Artifacts: ${a.artifacts.join(', ')}`);
      return lines.join('\n');
    })
  );
  await fs.writeFile(logPath, logLines.join('\n'), 'utf8');

  return result;
}

// ─────────────────────────────────────────────────────────────────────────
// v0.15.0 批次 2: moa_analyze 走 5 角色单次流程（轻量代理方案）
// ─────────────────────────────────────────────────────────────────────────

/**
 * 单次 analyze 流程：启动 orchestrate → 跑 1 轮 → 自动 finalize。
 *
 * 用于 #moa_analyze 工具，让 analyze 复用 orchestrate 的 5 角色架构
 * （Planner → Recon → Refs → Aggregator → Actor），但只跑一轮就收敛。
 *
 * 与 runP1Fanout 的差异：
 *   - runP1Fanout 是老路径（1700+ 行，streaming UI + dump 逻辑 + Phase 0 recon）
 *   - runSingleIterationAnalyze 是新路径（5 角色 + 自动 Actor + final.md 落盘）
 *
 * @returns MoaFinalOutput + task_id（用于 chat 展示落盘文件路径）
 */
export async function runSingleIterationAnalyze(
  prompt: string,
  token: vscode.CancellationToken,
  options?: {
    /** 预收集的 recon context（跳过 Recon，直接注入 evidence） */
    reconContext?: string;
    /** reconContext 来源（文件路径列表，仅用于日志） */
    reconSources?: string[];
    /** progress 回调（用于 chat UI 显示进度） */
    progress?: (msg: string) => void;
    /** toolInvocationToken（必需，让内置工具可调） */
    toolInvocationToken?: vscode.ChatParticipantToolToken;
    /** v0.22.0 P0-1: 入口类型（@moa/@moasingle/moa_analyze/moa_orchestrate） */
    entryType?: string;
  }
): Promise<MoaFinalOutput & { task_id: string }> {
  const reconContext = options?.reconContext?.trim();
  const reconSources = options?.reconSources ?? [];
  const progress = options?.progress;
  const toolInvocationToken = options?.toolInvocationToken;

  // 1. 启动 orchestrate 任务
  progress?.(`[MoA Single] starting 5-role single-shot pipeline (will force finalize after iter 1)...`);
  const initialState = await createOrchestration(prompt);
  const taskId = initialState.task_id;

  // 2. 跑 1 轮（如果 reconContext 提供，作为 subagentResult 注入 evidence）
  progress?.(`[MoA Single] running iteration 1 (Planner → Recon → Refs → Aggregator → Actor)...`);
  let subagentResult: { content: string; source: string } | undefined;
  if (reconContext && reconContext.length > 0) {
    subagentResult = {
      content: reconContext,
      source: reconSources.length > 0 ? reconSources.join(', ') : 'caller-supplied',
    };
    progress?.(`[MoA Single] using pre-collected reconContext (${reconContext.length} chars from ${reconSources.length} source(s)) — Recon phase will be skipped`);
  }

  await runIteration(taskId, subagentResult, token, progress, toolInvocationToken);

  // 3. 检查状态，如果未 finalized，强制 finalize（单次语义）+ 标记 single_shot 收敛来源
  const stateAfter = await loadState(taskId);
  if (!stateAfter) throw new Error(`Analyze failed: task ${taskId} state lost`);
  if (stateAfter.status !== 'finalized') {
    // v0.16.0: 标记为 single_shot（强制收敛，Aggregator 的真实建议被覆盖）
    stateAfter.convergence_source = 'single_shot';
    // convergence_raw_next_action 在 runIteration 阶段已被记录（aggOutput.next_action）
    await saveState(stateAfter);
    progress?.(`[MoA Single] forcing finalize (single-shot semantic, status was ${stateAfter.status}, Aggregator's actual suggestion: ${stateAfter.convergence_raw_next_action ?? '?'})`);
    const output = await finalizeTask(taskId, token);
    return output;
  }

  // 4. 已 finalized（Aggregator 在第 1 轮就决定 finalize，罕见但可能）
  // 这种情况 convergence_source 已在 runIteration 里设为 'natural'
  const dir = await getTaskDir(taskId);
  const finalJsonPath = path.join(dir, 'final.json');
  const finalJsonRaw = await fs.readFile(finalJsonPath, 'utf8');
  const finalOutput = JSON.parse(finalJsonRaw) as MoaFinalOutput;
  return finalOutput;
}

// ─────────────────────────────────────────────────────────────────────────
// v0.16.0: @moa / @moaloop 默认走完整 loop 模式
// ─────────────────────────────────────────────────────────────────────────

/**
 * 完整 loop analyze：启动 orchestrate → 循环 runIteration 直到自然收敛 / MAX_ITER。
 *
 * 与 runSingleIterationAnalyze 的差异：
 *   - 单次模式：1 轮强制收敛（不论 Aggregator 建议）
 *   - loop 模式：让 Aggregator 自然决策，recon_needed 就继续，直到 finalize / MAX_ITER
 *
 * @param maxIterations 可选上限（默认 MAX_ITER=12；用户可设更小值如 3-5 限制 chat 耗时）
 */
export async function runMoaLoopAnalyze(
  prompt: string,
  token: vscode.CancellationToken,
  options?: {
    reconContext?: string;
    reconSources?: string[];
    progress?: (msg: string) => void;
    toolInvocationToken?: vscode.ChatParticipantToolToken;
    /** 最大迭代数（默认 MAX_ITER=12） */
    maxIterations?: number;
    /** v0.22.0 P0-1: 入口类型（@moa/@moasingle/moa_analyze/moa_orchestrate） */
    entryType?: string;
  }
): Promise<MoaFinalOutput & { task_id: string }> {
  const reconContext = options?.reconContext?.trim();
  const reconSources = options?.reconSources ?? [];
  const progress = options?.progress;
  const toolInvocationToken = options?.toolInvocationToken;
  const maxIter = options?.maxIterations ?? MAX_ITER;

  progress?.(`[MoA Loop] starting 5-role iterative pipeline (max ${maxIter} iterations, will let Aggregator decide convergence)...`);
  const initialState = await createOrchestration(prompt);
  const taskId = initialState.task_id;

  // 首轮（如有 reconContext，作为 subagentResult 注入）
  let subagentResult: { content: string; source: string } | undefined;
  if (reconContext && reconContext.length > 0) {
    subagentResult = {
      content: reconContext,
      source: reconSources.length > 0 ? reconSources.join(', ') : 'caller-supplied',
    };
    progress?.(`[MoA Loop] using pre-collected reconContext (${reconContext.length} chars from ${reconSources.length} source(s)) — Recon phase will be skipped in iter 1`);
  }

  let state = await runIteration(taskId, subagentResult, token, progress, toolInvocationToken, {
    entryType: options?.entryType,
  });
  let iterCount = 1;

  // 循环直到 finalized 或达到 maxIter
  while (state.status !== 'finalized' && iterCount < maxIter) {
    if (token.isCancellationRequested) {
      progress?.(`[MoA Loop] cancelled by user at iteration ${iterCount}`);
      break;
    }
    iterCount += 1;
    progress?.(`[MoA Loop] proceeding to iteration ${iterCount} (Aggregator said: ${state.history[state.history.length - 1].aggregator_output?.next_action ?? '?'})...`);
    // 后续轮次不再注入 reconContext（只首轮使用，避免重复）
    state = await runIteration(taskId, undefined, token, progress, toolInvocationToken, {
      entryType: options?.entryType,
    });
  }

  // 兜底：如果达到 maxIter 仍未 finalized（理论上 runIteration 内部会处理 MAX_ITER，
  // 但用户传的 maxIter < MAX_ITER 时需要这里兜底）
  if (state.status !== 'finalized') {
    progress?.(`[MoA Loop] reached maxIterations=${maxIter}, forcing finalize`);
    state.convergence_source = 'max_iter';
    state.convergence_raw_next_action = state.history[state.history.length - 1]?.aggregator_output?.next_action;
    await saveState(state);
    const output = await finalizeTask(taskId, token);
    return output;
  }

  // 已 finalized（自然收敛或 MAX_ITER），读 final.json
  const dir = await getTaskDir(taskId);
  const finalJsonPath = path.join(dir, 'final.json');
  const finalJsonRaw = await fs.readFile(finalJsonPath, 'utf8');
  const finalOutput = JSON.parse(finalJsonRaw) as MoaFinalOutput;
  progress?.(`[MoA Loop] done in ${iterCount} iteration(s) | convergence: ${state.convergence_source} | completeness: ${(state.completeness * 100).toFixed(0)}%`);

  // v0.22.0 P0-8: 设 Plan Mode Report(给主会话展示)
  try {
    const planReport: MoaPlanReport = {
      task_id: taskId,
      iterationsRun: iterCount,
      planCoverageHistory: (state.planner?.plan_coverage !== undefined)
        ? [state.planner.plan_coverage]
        : [],
      needsReplan: state.planner?.needs_replan ?? false,
      askUserTriggered: state.planner?.ask_user ?? false,
      convergedReason: state.convergence_source === 'natural'
        ? 'natural'
        : state.convergence_source === 'max_iter'
          ? 'max-iter'
          : 'natural',
      totalElapsedSec: 0,
    };
    setLastPlanReport(planReport);
  } catch (err) {
    progress?.(`[MoA Loop] failed to set Plan Report: ${err instanceof Error ? err.message : String(err)}`);
  }

  return finalOutput;
}

// ─────────────────────────────────────────────────────────────────────────
// Status reporting for tool results
// ─────────────────────────────────────────────────────────────────────────

export function formatStatusMarkdown(state: MoaState): string {
  const lines: string[] = [
    `### MoA Task \`${state.task_id}\``,
    '',
    `**Status:** ${state.status}  `,
    `**Iteration:** ${state.iteration}/${MAX_ITER}  `,
    `**Completeness:** ${(state.completeness * 100).toFixed(0)}%  `,
    `**Evidence items:** ${state.evidence.length}  `,
    '',
  ];

  if (state.synthesis) {
    lines.push('#### Current synthesis');
    lines.push('');
    lines.push('> ' + state.synthesis.replace(/\n/g, '\n> '));
    lines.push('');
  }

  if (state.gaps.length > 0) {
    lines.push('#### Open gaps');
    lines.push('');
    for (const g of state.gaps) lines.push(`- ${g}`);
    lines.push('');
  }

  if (state.status === 'awaiting_recon') {
    const lastIter = state.history[state.history.length - 1];
    if (lastIter?.recon_request) {
      lines.push('#### Recon needed');
      lines.push('');
      lines.push('Call `#runSubagent` with this prompt, then feed the result back via `#moa_continue`:');
      lines.push('');
      lines.push('```');
      lines.push(lastIter.recon_request.prompt);
      lines.push('```');
      lines.push('');
    }
  }

  if (state.status === 'finalized' || shouldStop(state)) {
    lines.push('Call `#moa_finalize` to produce action items.');
    lines.push('');
  }

  if (state.error) {
    lines.push(`**Error:** ${state.error}`);
    lines.push('');
  }

  return lines.join('\n');
}
