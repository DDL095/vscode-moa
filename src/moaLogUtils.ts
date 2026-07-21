/**
 * MoA 流水线日志格式化工具（v0.21.0+）
 *
 * 设计目标：
 *   - 每条 OutputChannel 日志带结构化前缀：[本地时间戳] [iter N] [role/label] [model: X] event (Ys) details
 *   - 时间戳使用用户本地时区（不再用 ISO 8601 UTC），方便用户判断
 *   - 任务级边界（started / finalized / crashed）以醒目分隔块呈现
 *
 * 文档：docs/roadmap/long-term-roadmap.md §I-2
 */

// ─────────────────────────────────────────────────────────────────────────
// 本地时间戳格式化
// ─────────────────────────────────────────────────────────────────────────

/**
 * 把 Date 格式化为本地时区字符串：
 *   'YYYY-MM-DD HH:mm:ss.SSS <TZ> (UTC+HH:MM)'
 *
 * 例如：'2026-07-21 18:30:45.123 Asia/Shanghai (UTC+08:00)'
 *
 * 实现说明：
 *   - 使用 Intl.DateTimeFormat().resolvedOptions().timeZone 读 IANA 时区名
 *   - 使用 Date#getTimezoneOffset() 算 UTC 偏移（注意符号：getTimezoneOffset 返回的是 UTC - local 的分钟数，故取负）
 *   - 不依赖第三方库（dayjs/date-fns 等），保持 bundle 小
 */
export function formatLocalTimestamp(date: Date = new Date()): string {
  let tz: string;
  try {
    tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Local';
  } catch {
    tz = 'Local';
  }

  const offsetMin = -date.getTimezoneOffset(); // +480 for UTC+8
  const sign = offsetMin >= 0 ? '+' : '-';
  const absOff = Math.abs(offsetMin);
  const off = `UTC${sign}${String(Math.floor(absOff / 60)).padStart(2, '0')}:${String(absOff % 60).padStart(2, '0')}`;

  const pad = (n: number, w = 2): string => String(n).padStart(w, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)} ` +
    `${tz} (${off})`
  );
}

// ─────────────────────────────────────────────────────────────────────────
// 单行结构化日志
// ─────────────────────────────────────────────────────────────────────────

export interface LogLineOptions {
  /** 迭代号（1-based）。undefined 时不显示 iter 段。 */
  iter?: number;
  /**
   * 角色标签。建议格式：
   *   - 'Planner'
   *   - 'Recon/advisor_1' / 'Recon/advisor_2'
   *   - 'Refs/advisor_1' / 'Refs/advisor_2'
   *   - 'Aggregator' / 'Actor'
   *   - 'ReconAggregator'
   */
  role?: string;
  /** 模型名（如 'GLM-5.2'）。undefined 时不显示 model 段。 */
  model?: string;
  /** 该事件耗时（秒）。undefined 时不显示 elapsed 段。 */
  elapsed_sec?: number;
  /** 事件名（如 'callLLM' / 'response' / 'JSON parse OK' / 'tool_call'）。 */
  event: string;
  /** 附加详情键值对。值为字符串原样输出，其他类型 JSON.stringify。 */
  details?: Record<string, unknown>;
}

/**
 * 生成带结构化前缀的单行日志：
 *
 *   [2026-07-21 18:30:45.123 Asia/Shanghai (UTC+08:00)] [iter 3] [Refs/advisor_1] [model: DeepSeek-V4-Flash] response (3.2s) confidence=0.85, new_findings=3
 */
export function formatLogLine(opts: LogLineOptions): string {
  const ts = formatLocalTimestamp();
  const iterPart = opts.iter !== undefined ? ` [iter ${opts.iter}]` : '';
  const rolePart = opts.role ? ` [${opts.role}]` : '';
  const modelPart = opts.model ? ` [model: ${opts.model}]` : '';
  const elapsedPart =
    opts.elapsed_sec !== undefined ? ` (${opts.elapsed_sec.toFixed(1)}s)` : '';
  const detailsPart = opts.details
    ? ' ' +
      Object.entries(opts.details)
        .map(
          ([k, v]) =>
            `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`
        )
        .join(', ')
    : '';
  return `[${ts}]${iterPart}${rolePart}${modelPart} ${opts.event}${elapsedPart}${detailsPart}`;
}

// ─────────────────────────────────────────────────────────────────────────
// 任务级边界（多行块）
// ─────────────────────────────────────────────────────────────────────────

export type TaskBoundaryEvent = 'started' | 'finalized' | 'crashed';

export interface TaskBoundaryMeta {
  task_id: string;
  task: string;
  iter?: number;
  elapsed_sec?: number;
  /** 额外字段（如 finalize 时的 completeness / convergence_source；crash 时的 error_message） */
  extra?: Record<string, unknown>;
}

/**
 * 生成任务边界多行块（started / finalized / crashed）。
 *
 * 输出示例（finalized）：
 *   ════════════════════════════════════════════════════════════
 *   === Task FINALIZED ===
 *   task_id   : moa_abc123
 *   task      : refactor src/foo.ts to extract...
 *   iters     : 10
 *   elapsed   : 245.8s
 *   timestamp : 2026-07-21 18:30:45.123 Asia/Shanghai (UTC+08:00)
 *   ════════════════════════════════════════════════════════════
 *
 * `extra` 字段会逐条追加到块中（在 timestamp 前）。
 */
export function formatTaskBoundary(
  event: TaskBoundaryEvent,
  meta: TaskBoundaryMeta
): string[] {
  const line = '═'.repeat(60);
  const lines: string[] = [line, `=== Task ${event.toUpperCase()} ===`];
  lines.push(`task_id   : ${meta.task_id}`);
  const truncatedTask =
    meta.task.length > 120 ? meta.task.substring(0, 120) + '...' : meta.task;
  lines.push(`task      : ${truncatedTask}`);
  if (meta.iter !== undefined) {
    lines.push(`iters     : ${meta.iter}`);
  }
  if (meta.elapsed_sec !== undefined) {
    lines.push(`elapsed   : ${meta.elapsed_sec.toFixed(1)}s`);
  }
  if (meta.extra) {
    for (const [k, v] of Object.entries(meta.extra)) {
      const valueStr =
        typeof v === 'string' ? v : JSON.stringify(v);
      // 直接输出 key : value，不做 padding 截断（保持 key 完整可读）
      lines.push(`${k} : ${valueStr}`);
    }
  }
  lines.push(`timestamp : ${formatLocalTimestamp()}`);
  lines.push(line);
  return lines;
}
