/**
 * v0.21.0 IV-4: Pipeline 架构常量 + meta.json 自描述字段。
 *
 * 目的：把 `.moa_cache/<task_id>/meta.json` 做成"自描述"清单 ——
 * 即使把整个 cache 目录喂给无上下文 AI（或几个月后的自己），也能看出
 *   - 这是什么 pipeline（5 角色 / Hermes loop）
 *   - loop 怎么收敛（max_iter / completeness_threshold / convergence_window）
 *   - 文件布局（state.json / meta.json / iteration_NNN/...）
 *   - 当时的运行配置（executionPreset / approvalMode / ...）
 *
 * 路线图：docs/roadmap/long-term-roadmap.md §IV-4
 */

export const PIPELINE_ARCHITECTURE_VERSION = '0.21.0';

export interface RoleSpec {
  name: string;
  /** 执行顺序（1-5，Recon Aggregator 用 2.5 表示在 Recon 之后） */
  order: number;
  /** 运行时机（如 'iter 1 only' / 'every iter' / 'on actor_needed'） */
  runs_when: string;
  /** 一句话描述职责 */
  description: string;
  /**
   * 对应的 iteration 产物文件名 pattern。
   * v0.21.0 IV-1 起新命名规则：iteration_NNN__role__model.json
   */
  output_file_pattern: string;
}

export const PIPELINE_ROLES: RoleSpec[] = [
  {
    name: 'Planner',
    order: 1,
    runs_when: 'iter 1 only',
    description: 'Clarify task + emit sub_questions + recon_hints',
    output_file_pattern: 'iteration_{NNN}/iteration_{NNN}__planner__{model}.json',
  },
  {
    name: 'Recon',
    order: 2,
    runs_when: 'every iter (unless reconContext pre-injected)',
    description: 'Gather file contents relevant to the task (N parallel agents)',
    output_file_pattern: 'iteration_{NNN}/iteration_{NNN}__recon__{label}__{model}.json',
  },
  {
    name: 'Recon Aggregator',
    order: 2.5,
    runs_when: 'always after Recon fan-out',
    description: 'Merge + dedupe N parallel Recon outputs into universal_aggregated_evidence',
    output_file_pattern: 'iteration_{NNN}/iteration_{NNN}__recon_aggregator__{model}.json',
  },
  {
    name: 'Refs',
    order: 3,
    runs_when: 'every iter',
    description: 'N parallel advisors analyze evidence + emit JSON (findings/confidence/missing)',
    output_file_pattern: 'iteration_{NNN}/iteration_{NNN}__refs__{label}__{model}.json',
  },
  {
    name: 'Aggregator',
    order: 4,
    runs_when: 'every iter',
    description: 'Fuse N ref outputs + score completeness + decide next_action',
    output_file_pattern: 'iteration_{NNN}/iteration_{NNN}__aggregator__{model}.json',
  },
  {
    name: 'Actor',
    order: 5,
    runs_when: 'on actor_needed',
    description: 'Execute action_items via full tools (write_file / execute / inform_user)',
    output_file_pattern: 'iteration_{NNN}/iteration_{NNN}__actor__{model}.json',
  },
];

export const LOOP_TERMINATION = {
  max_iter: 12,
  completeness_threshold: 0.8,
  convergence_window: 3,
  gate_order: ['max_iter', 'finalize', 'actor_needed', 'shouldStop', 'recon_needed'],
};

export const FILE_LAYOUT = {
  state: 'state.json',
  meta: 'meta.json',
  timeline: 'timeline.md',
  final: 'final.md / final.json',
  iterations: 'iteration_NNN/iteration_NNN__{role}__{model}.json',
  manifest: 'manifest.json (SafeExecutor, v0.19.1+)',
  autopilot_log: 'autopilot.log (v0.20.0+)',
};

export interface PipelineArchitecture {
  version: string;
  description: string;
  roles: RoleSpec[];
  loop_termination: typeof LOOP_TERMINATION;
  file_layout: typeof FILE_LAYOUT;
  settings_snapshot: Record<string, unknown>;
}

/**
 * 构造完整的 pipeline_architecture 对象，注入 meta.json。
 *
 * @param settingsSnapshot 从 vscode.workspace.getConfiguration('moa') 读出的关键配置
 */
export function buildPipelineArchitecture(
  settingsSnapshot: Record<string, unknown>
): PipelineArchitecture {
  return {
    version: PIPELINE_ARCHITECTURE_VERSION,
    description:
      '5-role Hermes-style MoA pipeline (Planner → Recon → Refs → Aggregator → Actor) with Recon Aggregator post-processing (v0.18+)',
    roles: PIPELINE_ROLES,
    loop_termination: LOOP_TERMINATION,
    file_layout: FILE_LAYOUT,
    settings_snapshot: settingsSnapshot,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// v0.21.0 IV-4: timeline.md 阶段耗时辅助函数
// ─────────────────────────────────────────────────────────────────────────

/**
 * IterationRecord 中每轮的 per-role 耗时数据（与 src/moaOrchestrator.ts 的 IterationRecord 对齐）。
 *
 * 来自 IterationRecord.{planner,recon,refs,aggregator,actor}_elapsed_sec 字段。
 * 本接口用于 timeline.md 渲染时的解耦类型。
 */
export interface IterationTimings {
  iter: number;
  planner?: number;
  recon?: number;
  recon_parallel_count?: number;
  refs?: number;
  refs_parallel_count?: number;
  aggregator?: number;
  actor?: number | null;
  total: number;
}

/**
 * 把秒数格式化为人类可读短字符串：
 *   - < 60s    → '12.4s'
 *   - >= 60s   → '1m 23s'
 *   - null     → '—'
 */
export function formatDuration(sec: number | null | undefined): string {
  if (sec === null || sec === undefined) return '—';
  if (sec < 60) return `${sec.toFixed(1)}s`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec - m * 60);
  return `${m}m ${s}s`;
}
