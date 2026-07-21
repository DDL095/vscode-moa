# vscode-moa 长期路线图（Long-Term Roadmap）

> **状态**：滚动规划，按优先级分阶段实施
> **最后更新**：2026-07-21（v0.20.4 发布后）
> **维护者**：DDL095
> **当前版本**：v0.20.4（见 [CHANGELOG.md](../../CHANGELOG.md)）

本文档是 vscode-moa 的长期演进路线图。每条目包含：
- 现状（Current State）
- 痛点（Pain Point）
- 目标（Goal）
- 实现方案（Implementation，含源码定位 + API 签名 + 文件路径）
- 工作量估算（Effort）
- 优先级（Priority）
- 状态（Status：✅ DONE / 🚧 NEXT / ⏸ PAUSED）

---

## 目录

- [进度总览](#进度总览)
- [🚧 下一阶段 — v0.21.0（聚焦：日志 + 自描述缓存）](#-下一阶段--v0210聚焦日志--自描述缓存)
  - [I-2 OutputChannel 日志格式增强](#i-2-outputchannel-日志格式增强)
  - [IV-1 JSON 文件名加轮次标记](#iv-1-json-文件名加轮次标记)
  - [IV-4 meta.json pipeline_architecture 字段](#iv-4-metajson-pipeline_architecture-字段)
- [⏸ 暂缓阶段 — v0.22.0+（聚焦：可视化）](#-暂缓阶段--v0220聚焦可视化)
- [附录 A — 已完成项归档](#附录-a--已完成项归档)
- [附录 B — 优先级矩阵](#附录-b--优先级矩阵)
- [附录 C — 用户原话归档（决策依据）](#附录-c--用户原话归档决策依据)
- [附录 D — v0.21.0 实施顺序建议](#附录-d--v0210-实施顺序建议)

---

## 进度总览

| 阶段 | 原计划版本 | 实际完成版本 | 状态 |
|---|---|---|---|
| I-1 Settings UI 双语化 | v0.19.x | v0.20.2（超额：覆盖 20+ 项 vs 原计划 17 项） | ✅ DONE |
| I-2 OutputChannel 日志格式 | v0.19.x | — | 🚧 **NEXT v0.21.0** |
| I-3 meta.json 扩充（per_role + model_invocations） | v0.19.x | v0.19.2 §5.1（部分完成，缺 pipeline_architecture / actor_actions_log） | ⏠ 部分完成 |
| II-1 MoA Webview Panel | v0.20.x | — | ⏸ PAUSED（依赖 I-2 完成） |
| II-2 任务历史列表 | v0.20.x | — | ⏸ PAUSED（依赖 II-1） |
| III-1 Actor 开关（enableActorInLoop） | v0.21.x | v0.18.4（基础）+ v0.20.0（超额：approvalMode 4 档） | ✅ DONE |
| III-2 保守执行模式（SafeExecutor + manifest） | v0.21.x | v0.19.1（基础）+ v0.20.0（超额：executionPreset + autopilot） | ✅ DONE |
| III-3 全工具 subagent | v0.21.x | v0.13.0（移除前缀过滤）+ v0.19.1（SafeExecutor 语义黑名单） | ✅ DONE |
| IV-1 JSON 文件名加轮次标记 | v0.22.x | — | 🚧 **NEXT v0.21.0** |
| IV-2 recon 顶层文件夹总览 | v0.22.x | — | ⏸ 低优先级 |
| IV-3 aggregator JSON 扩充（merged_from_refs / conflicts_detected） | v0.22.x | — | ⏸ 低优先级 |
| IV-4 meta.json pipeline_architecture 字段 | v0.22.x | — | 🚧 **NEXT v0.21.0** |
| V-1 自动 CHANGELOG 生成 | v0.23+ | — | ⏸ 低优先级 |
| V-2 Pipeline 可视化编辑器 | v0.23+ | — | ⏸ 低优先级 |
| V-3 跨任务知识图谱 | v0.23+ | — | ⏸ 低优先级 |

**版本号语义变更说明**：原路线图把版本号与阶段绑定（v0.19=阶段 I、v0.20=阶段 II、v0.21=阶段 III、v0.22=阶段 IV）。实际开发顺序不同——v0.19 提前做了阶段 III（Actor 安全），v0.20 提前做了阶段 I-1（i18n）+ executionPreset。**v0.21 起不再绑定版本号与阶段**，按优先级灵活安排。

---

## 🚧 下一阶段 — v0.21.0（聚焦：日志 + 自描述缓存）

**目标**：完成 I-2 + IV-1 + IV-4 三项。预计工作量 8-11 小时。

**为什么是这三项**：
1. **I-2** 是用户原话 #8 #9 明确要求过的"信息粒度不够详细、缺乏全局性查看运行状态"。
2. **IV-1 + IV-4** 是用户原话 #13 #14 明确要求过的"json 文件名加轮次标记、能自组织架构"。
3. **I-2 是 II-1 Webview 的前置条件** —— Webview 要展示日志数据，日志格式不规整就没东西可展示。
4. 三项工作量都小（各 2-6 小时），可在单次 sprint 内完成。

---

### I-2 OutputChannel 日志格式增强

**状态**：🚧 NEXT（v0.21.0 首项）
**优先级**：🟢 高（用户明确要求 + II-1 前置）
**工作量**：中（4-6 小时）

#### 现状

v0.17.0 引入了 5 个独立 OutputChannel（Planner / Recon / Refs / Aggregator / Actor），但每个 channel 的日志粒度不够详细：

```typescript
// src/moaOrchestrator.ts L257-289（当前实现）
function logPipeline(key: PipelineChannelKey, line: string): void {
  try {
    getPipelineChannel(key).appendLine(line);
  } catch (err) {
    console.warn(`[MoA ${key} log] failed: ...`);
  }
}

function logPipelineBlock(key, header, content) {
  logPipeline(key, '');
  logPipeline(key, header);   // 例如 "--- Ref advisor_1 (DeepSeek-V4-Flash) ---"
  logPipeline(key, content);  // 原始 LLM 输出
}
```

问题：
- 无时间戳
- 无 iter 号（只在 chat progress 显示，不在 OutputChannel）
- 无 token 数 / 模型名 / 耗时（这些信息散落在不同函数局部变量里）
- 无"任务开始 / 结束"标记行

#### 目标

每个 OutputChannel 的每条日志都带结构化前缀（**本地时间戳**，不再用 ISO 8601 UTC）：

```
[2026-07-21 18:30:45.123 CST] [iter 3] [Refs/advisor_1] [model: DeepSeek-V4-Flash]
  → callLLM (system 450 chars, user 12,340 chars)
  ← response (8,901 chars, elapsed 3.2s, tool_calls: 0)
  → JSON parse OK, confidence=0.85, new_findings=3
```

**时间戳本地化**（v0.21.0 新增需求，用户原话 2026-07-21）：

```typescript
// src/moaLogUtils.ts
function formatLocalTimestamp(date: Date = new Date()): string {
  // 读取用户本地时区，格式：YYYY-MM-DD HH:mm:ss.SSS TZ
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone; // 如 'Asia/Shanghai'
  const offsetMin = -date.getTimezoneOffset();                  // +480 for UTC+8
  const sign = offsetMin >= 0 ? '+' : '-';
  const off = `${sign}${String(Math.floor(Math.abs(offsetMin) / 60)).padStart(2,'0')}:${String(Math.abs(offsetMin) % 60).padStart(2,'0')}`;
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())} `
       + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(),3)} `
       + `${tz} (UTC${off})`;
}
// 输出示例：'2026-07-21 18:30:45.123 Asia/Shanghai (UTC+08:00)'
```

向后兼容：`task_id` 内嵌的 ISO 时间戳保持 UTC（task_id 是机器标识符，UTC 跨时区一致）；仅 OutputChannel / timeline.md / meta.json 中展示给人类的时间字段改为本地。

#### 实现方案

**Step 1 — 新建日志工具模块** `src/moaLogUtils.ts`（新文件）：

```typescript
// 统一格式化函数（所有 5 个 channel 共用）
export function formatLogLine(opts: {
  iter?: number;
  role?: string;       // 'Planner' / 'Recon/advisor_1' / 'Refs/advisor_2' / ...
  model?: string;
  elapsed_sec?: number;
  event: string;       // 'callLLM' / 'response' / 'JSON parse OK' / 'tool_call' / ...
  details?: Record<string, unknown>;
}): string {
  const ts = formatLocalTimestamp();   // 本地时间戳（不再用 new Date().toISOString()）
  const iterPart = opts.iter !== undefined ? ` [iter ${opts.iter}]` : '';
  const rolePart = opts.role ? ` [${opts.role}]` : '';
  const modelPart = opts.model ? ` [model: ${opts.model}]` : '';
  const elapsedPart = opts.elapsed_sec !== undefined
    ? ` (${opts.elapsed_sec.toFixed(1)}s)` : '';
  const detailsPart = opts.details
    ? ' ' + Object.entries(opts.details)
        .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
        .join(', ')
    : '';
  return `[${ts}]${iterPart}${rolePart}${modelPart} ${opts.event}${elapsedPart}${detailsPart}`;
}

// 任务级标记行
export function formatTaskBoundary(event: 'started' | 'finalized' | 'crashed', meta: {
  task_id: string;
  task: string;
  iter?: number;
  elapsed_sec?: number;
}): string[] {
  const line = '='.repeat(60);
  return [
    line,
    `=== Task ${event.toUpperCase()} ===`,
    `task_id   : ${meta.task_id}`,
    `task      : ${meta.task.substring(0, 120)}${meta.task.length > 120 ? '...' : ''}`,
    meta.iter !== undefined ? `iters     : ${meta.iter}` : '',
    meta.elapsed_sec !== undefined ? `elapsed   : ${meta.elapsed_sec.toFixed(1)}s` : '',
    `timestamp : ${new Date().toISOString()}`,
    line,
  ].filter(Boolean);
}
```

**Step 2 — 改造 5 个角色的 hook 点**（[src/moaOrchestrator.ts](../../src/moaOrchestrator.ts)）：

| 角色 | 调用位置（line） | 改造点 |
|---|---|---|
| Planner | L1190 `callPlanner(...)` | 在调用前后包 `formatLogLine({iter, role:'Planner', model, event:'callLLM'/'response', elapsed_sec})` |
| Recon | L1254 `callRecon(...)` | 每个 `r` in results 包 `formatLogLine({iter, role:'Recon/'+r.label, model:r.model, event:'tool_call'/'early_stop', details:{tools:N, chars:M}})` |
| Refs | L1364 区域 | 每个 `r` 包 `formatLogLine({iter, role:'Refs/'+r.label, model:r.model, event:'callLLM'/'response'/'JSON parse OK', details:{confidence, new_findings}})` |
| Aggregator | L1402 `saveIterationArtifact(...aggregator.json)` 前后 | 包 `formatLogLine({iter, role:'Aggregator', model, event:'fuse', details:{completeness, next_action}})` |
| Actor | L1510 `callActor(...)` 前后 + runActor 内部工具调用 | 包 `formatLogLine({iter, role:'Actor', model, event:'action', details:{type, target, status}})` |

**Step 3 — 任务边界标记**：

- `createOrchestration()` 返回前：在每个 channel 写 `formatTaskBoundary('started', {task_id, task})`
- `finalizeTask()` 返回前：写 `formatTaskBoundary('finalized', {task_id, task, iter, elapsed_sec})`
- 任何 catch 块顶层：写 `formatTaskBoundary('crashed', ...)`

**Step 4 — 兼容性**：

- 旧的 `logPipelineBlock` 保留，内部改为 `formatLogLine` 包装（不破坏现有调用点）
- 新增 `logPipelineStructured(key, opts)` 替代直接 `logPipeline(key, line)`
- 5 个 OutputChannel 的 channel 名（如 `MoA Planner`）不变

**Step 5 — 测试**：

新增 `test/moaLogUtils.test.ts`：
- `formatLogLine` 各字段组合（无 iter / 无 model / 无 details 等）
- `formatTaskBoundary` 三种 event
- 时间戳格式（ISO 8601 + milliseconds）
- 长字符串截断（task > 120 字符）

#### 依赖

无（独立项）。可立即开工。

#### 与 II-1 的关系

完成后，II-1 Webview 可以：
1. 订阅 5 个 OutputChannel 的 onDidChange 事件
2. 解析结构化前缀（regex 提取 iter / role / model / elapsed）
3. 渲染到 Webview 表格

---

### IV-1 JSON 文件名加轮次标记

**状态**：🚧 NEXT（v0.21.0 第二项）
**优先级**：🟡 中（用户原话 #13 #14）
**工作量**：小（2 小时）

#### 现状

`saveIterationArtifact` 在 [src/moaOrchestrator.ts L328](../../src/moaOrchestrator.ts#L328) 当前签名：

```typescript
async function saveIterationArtifact(
  taskId: string,
  iteration: number,
  filename: string,    // 调用方拼好的相对路径，如 'planner.json' / 'refs/advisor_1.json'
  data: unknown
): Promise<void> {
  const dir = path.join(await getTaskDir(taskId),
    `iteration_${String(iteration).padStart(3, '0')}`);
  const filePath = path.join(dir, filename);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
}
```

调用方传入的 `filename` 不含轮次信息（如 `planner.json` / `refs/advisor_1.json`），复制到其他位置就丢失上下文。

#### 目标

文件名自描述，复制出来也能识别来源：

```
iteration_001/
  iteration_001__planner__GLM-5.2.json
  iteration_001__recon__DeepSeek-V4-Pro.json
  iteration_001__recon__MiniMax-M3.json
  iteration_001__recon_aggregator__GLM-5.2.json
  iteration_001__refs__advisor_1__DeepSeek-V4-Flash.json
  iteration_001__refs__advisor_2__MiniMax-M3.json
  iteration_001__refs__advisor_3__GLM-5.2.json
  iteration_001__aggregator__GLM-5.2.json
  iteration_001__actor__GLM-5.2.json     # 仅 actor_needed 时
```

#### 实现方案

**Step 1 — 扩展 saveIterationArtifact 签名**：

```typescript
async function saveIterationArtifact(
  taskId: string,
  iteration: number,
  filename: string,
  data: unknown,
  options?: {
    /** 角色标签（如 'planner' / 'recon' / 'refs/advisor_1'）；提供时自动生成自描述文件名 */
    role?: string;
    /** 模型名（如 'GLM-5.2'）；提供时拼入文件名 */
    model?: string;
    /** 若 true，同时写入新命名（自描述）+ 旧命名（兼容）；默认 false（仅新命名） */
    keepLegacy?: boolean;
  }
): Promise<void> {
  // ... 原目录构造 ...

  // 生成自描述文件名：iteration_NNN__role__model.json
  let finalFilename = filename;
  if (options?.role) {
    const iterPart = `iteration_${String(iteration).padStart(3, '0')}`;
    const rolePart = options.role.replace('/', '__');   // refs/advisor_1 → refs__advisor_1
    const modelPart = options.model
      ? '__' + options.model.replace(/[^A-Za-z0-9._-]/g, '_')
      : '';
    finalFilename = `${iterPart}__${rolePart}${modelPart}.json`;
  }

  const finalPath = path.join(dir, finalFilename);
  await fs.mkdir(path.dirname(finalPath), { recursive: true });
  await fs.writeFile(finalPath, JSON.stringify(data, null, 2), 'utf8');

  // 向后兼容：同时写入旧命名
  if (options?.keepLegacy && finalFilename !== filename) {
    const legacyPath = path.join(dir, filename);
    await fs.writeFile(legacyPath, JSON.stringify(data, null, 2), 'utf8');
  }
}
```

**Step 2 — 更新所有 7 处调用点**：

| 调用位置（line） | 当前 filename | 新增 options |
|---|---|---|
| L1195 | `'planner.json'` | `{role:'planner', model: state.planner_model ?? state.aggregator_model}` |
| L1276 | `` `recon/${r.label}.json` `` | `{role:'recon/'+r.label, model: r.model}` |
| L1293 | `'recon_result.json'` | `{role:'recon_aggregator', model: state.recon_aggregator_model}` |
| L1364 | `` `refs/${r.label}.json` `` | `{role:'refs/'+r.label, model: r.model}` |
| L1402 | `'aggregator.json'` | `{role:'aggregator', model: state.aggregator_model}` |
| L1518 | `'actor_result.json'` | `{role:'actor', model: state.actor_model ?? state.aggregator_model}` |
| L1576 | `'recon_request.json'` | `{role:'recon_request'}`（无 model） |

**注意**：v0.21.0 默认 `keepLegacy: false`（破坏性变更）。若要保留旧命名一版本作为过渡，临时设默认 `keepLegacy: true`，v0.22.0 改为 `false`。

**Step 3 — 读取兼容**：

检查代码中所有读取 iteration 文件的地方（用 grep 找 `readFile` + `iteration_`）：

```bash
grep -rn "iteration_" src/ --include="*.ts"
```

确保读取方支持新命名（通常是 meta.json 渲染器读 `iteration_NNN/*.json`，改为 glob `iteration_NNN/iteration_NNN__*.json`）。

**Step 4 — 测试**：

新增 `test/saveIterationArtifact.test.ts`：
- `role + model` 生成正确文件名（含特殊字符如 `/` `(` `)`）
- `role` 无 model 时只生成 `role.json`
- `keepLegacy: true` 同时写两份
- 目录自动创建

#### 依赖

无（独立项）。可与 I-2 并行。

---

### IV-4 meta.json pipeline_architecture 字段 + timeline.md 阶段耗时

**状态**：🚧 NEXT（v0.21.0 第三项）
**优先级**：🟡 中（让 `.moa_cache/` 真正自描述，用户原话 #13 #14 引申 + 2026-07-21 timeline 耗时需求）
**工作量**：小（3-4 小时，原 2-3 小时 + 新增 timeline 阶段耗时 1 小时）

#### 现状（meta.json）

`OrchestrationMeta` 接口（[src/moaOrchestrator.ts L380-L410](../../src/moaOrchestrator.ts#L380)）当前字段：

```typescript
interface OrchestrationMeta {
  task_id, task, created_at, finished_at, iteration_count, status,
  convergence_source,
  ref_models, aggregator_model,
  completeness_timeline, total_evidence_items, final_confidence,
  // v0.19.2 §5.1 已加：
  total_elapsed_sec?,
  per_role_breakdown?: { planner, recon, refs, aggregator, actor },
  model_invocations?: Array<{iter, role, model, elapsed_sec, tool_calls}>,
}
```

问题：没有 `pipeline_architecture` 字段。把 `.moa_cache/` 整个目录喂给无上下文 AI，它能看出用了哪些模型、跑了多少轮，但**看不出**这个 pipeline 是什么架构（5 角色？loop 怎么收敛？completeness 阈值多少？）。

#### 现状（timeline.md）

当前 `timeline.md`（[src/moaOrchestrator.ts](../../src/moaOrchestrator.ts) `renderTimelineMarkdown` 函数）每轮一行，仅显示 iter 号 / 模型 / completeness Δ，**不显示每个阶段的运行时间**。用户原话 2026-07-21："timeline 中能否加入每个阶段的运行时间？"

#### 目标 1：meta.json 加 pipeline_architecture 字段

`meta.json` 增加 `pipeline_architecture` 字段，作为"自描述清单"：

```json
{
  "pipeline_architecture": {
    "version": "0.21.0",
    "description": "5-role Hermes-style MoA pipeline (Planner → Recon → Refs → Aggregator → Actor)",
    "roles": [
      {
        "name": "Planner",
        "order": 1,
        "runs_when": "iter 1 only",
        "description": "Clarify task, emit sub_questions + recon_hints",
        "output_file_pattern": "iteration_{NNN}/iteration_{NNN}__planner__{model}.json"
      },
      {
        "name": "Recon",
        "order": 2,
        "runs_when": "every iter (unless reconContext provided)",
        "description": "Gather file contents relevant to the task",
        "output_file_pattern": "iteration_{NNN}/iteration_{NNN}__recon__{label}__{model}.json"
      }
      // ... 其他 5 个角色 ...
    ],
    "loop_termination": {
      "max_iter": 12,
      "completeness_threshold": 0.8,
      "convergence_window": 3,
      "gate_order": ["max_iter", "finalize", "actor_needed", "shouldStop", "recon_needed"]
    },
    "file_layout": {
      "state": "state.json",
      "meta": "meta.json",
      "timeline": "timeline.md",
      "final": "final.md / final.json",
      "iterations": "iteration_NNN/iteration_NNN__{role}__{model}.json",
      "manifest": "manifest.json (SafeExecutor, v0.19.1+)",
      "autopilot_log": "autopilot.log (v0.20.0+)"
    },
    "settings_snapshot": {
      "executionPreset": "manual",
      "approvalMode": "batch",
      "safeExecutionMode": true,
      "enableRecon": true,
      "enableActorInLoop": false,
      "refDisplayMode": "thinking"
    }
  }
}
```

#### 实现方案

**Step 1 — 定义架构常量** `src/moaCore/pipelineArchitecture.ts`（新文件）：

```typescript
export const PIPELINE_ARCHITECTURE_VERSION = '0.21.0';

export interface RoleSpec {
  name: string;
  order: number;
  runs_when: string;
  description: string;
  output_file_pattern: string;
}

export const PIPELINE_ROLES: RoleSpec[] = [
  { name: 'Planner', order: 1, runs_when: 'iter 1 only', ... },
  { name: 'Recon', order: 2, runs_when: 'every iter', ... },
  { name: 'Recon Aggregator', order: 2.5, runs_when: 'after Recon fan-out', ... },
  { name: 'Refs', order: 3, runs_when: 'every iter', ... },
  { name: 'Aggregator', order: 4, runs_when: 'every iter', ... },
  { name: 'Actor', order: 5, runs_when: 'on actor_needed', ... },
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

export function buildPipelineArchitecture(settingsSnapshot: Record<string, unknown>) {
  return {
    version: PIPELINE_ARCHITECTURE_VERSION,
    description: '5-role Hermes-style MoA pipeline (Planner → Recon → Refs → Aggregator → Actor)',
    roles: PIPELINE_ROLES,
    loop_termination: LOOP_TERMINATION,
    file_layout: FILE_LAYOUT,
    settings_snapshot: settingsSnapshot,
  };
}
```

**Step 2 — OrchestrationMeta 接口扩展**（[src/moaOrchestrator.ts](../../src/moaOrchestrator.ts)）：

```typescript
interface OrchestrationMeta {
  // ... 原有字段 ...
  pipeline_architecture?: ReturnType<typeof buildPipelineArchitecture>;
}
```

**Step 3 — renderMetaJson 注入**：

在 `computeMetaJson`（[src/moaOrchestrator.ts L520](../../src/moaOrchestrator.ts#L520)）末尾添加：

```typescript
const settingsSnapshot = {
  executionPreset: config.get('executionPreset', 'manual'),
  approvalMode: config.get('approvalMode', 'batch'),
  safeExecutionMode: config.get('safeExecutionMode', true),
  enableRecon: config.get('enableRecon', true),
  enableActorInLoop: config.get('enableActorInLoop', false),
  refDisplayMode: config.get('refDisplayMode', 'thinking'),
};
meta.pipeline_architecture = buildPipelineArchitecture(settingsSnapshot);
```

**Step 4 — 测试**：

新增 `test/pipelineArchitecture.test.ts`：
- `buildPipelineArchitecture` 返回所有必填字段
- `PIPELINE_ROLES` 6 个角色顺序正确
- `settings_snapshot` 含 6 个核心配置
- 序列化后 JSON 可读、字段类型正确

#### 目标 2：timeline.md 每轮加入阶段运行时间

当前 timeline.md（伪表格示例）：

```
| iter | planner | recon | refs | aggregator | completeness | Δ  |
|------|---------|-------|------|------------|--------------|----|
|  1   |    ✓    | 8     | 8/8  |     ✓      |   0.32       | —  |
```

目标（v0.21.0）：

```
| iter | planner | recon        | refs           | aggregator | actor | total  | compl | Δ    |
|------|---------|--------------|----------------|------------|-------|--------|-------|------|
|  1   | 1.2s    | 18.5s (2 ag) | 12.4s (3 adv)  | 3.8s       | —     | 35.9s  | 0.32  |  —   |
|  2   | —       | 12.1s (2 ag) | 9.8s (3 adv)   | 3.2s       | —     | 25.1s  | 0.57  | +.25 |
|  3   | —       | 8.4s (1 ag)  | 7.5s (3 adv)   | 2.9s       | 5.1s  | 23.9s  | 0.85  | +.28 |
```

新增列：每个角色的 wall-clock 耗时（秒）+ 该轮 total + 各阶段的并发数（`(2 ag)` 表示 2 个 Recon Agent 并行）。

#### timeline.md 阶段耗时实现方案

**Step A — 收集 per-role 耗时**（在 [src/moaOrchestrator.ts](../../src/moaOrchestrator.ts) `runIteration` 内部）：

```typescript
// 在每个角色调用前后记录时间戳
const t_planner_start = Date.now();
const plannerResult = await callPlanner(...);
const planner_elapsed_sec = (Date.now() - t_planner_start) / 1000;

const t_recon_start = Date.now();
const reconResults = await Promise.all(reconAgents.map(callRecon));
const recon_elapsed_sec = (Date.now() - t_recon_start) / 1000;  // wall-clock（并行取最大）

const t_refs_start = Date.now();
const refsResults = await Promise.all(refAdvisors.map(callRef));
const refs_elapsed_sec = (Date.now() - t_refs_start) / 1000;

const t_agg_start = Date.now();
const aggResult = await callAggregator(...);
const agg_elapsed_sec = (Date.now() - t_agg_start) / 1000;

let actor_elapsed_sec: number | null = null;
if (aggResult.next_action === 'actor_needed') {
  const t_actor_start = Date.now();
  await callActor(...);
  actor_elapsed_sec = (Date.now() - t_actor_start) / 1000;
}

// 累积到 state.iteration_timings
state.iteration_timings[iter] = {
  planner: planner_elapsed_sec,
  recon: recon_elapsed_sec,
  recon_parallel_count: reconAgents.length,
  refs: refs_elapsed_sec,
  refs_parallel_count: refAdvisors.length,
  aggregator: agg_elapsed_sec,
  actor: actor_elapsed_sec,
  total: planner_elapsed_sec + recon_elapsed_sec + refs_elapsed_sec + agg_elapsed_sec + (actor_elapsed_sec ?? 0),
};
```

**Step B — 渲染 timeline.md 时新增列**：

在 `renderTimelineMarkdown()`（[src/moaOrchestrator.ts](../../src/moaOrchestrator.ts)）渲染表格时，从 `state.iteration_timings` 读取并渲染新列。需注意：

- iter 1 才有 planner，其他轮显示 `—`
- actor 只在 `actor_needed` 时有，否则显示 `—`
- 时间格式：`< 60s` 显示 `12.4s`，`≥ 60s` 显示 `1m 23s`

**Step C — meta.json 同步加字段**（与 IV-4 主字段一起）：

```typescript
interface OrchestrationMeta {
  // ... 原有字段 ...
  iteration_timings?: Array<{
    iter: number;
    planner?: number;       // 秒
    recon?: number;
    recon_parallel_count?: number;
    refs?: number;
    refs_parallel_count?: number;
    aggregator?: number;
    actor?: number | null;
    total: number;
  }>;
}
```

**Step D — 本地时间戳**：

timeline.md 内所有时间戳（表头、started_at、finished_at）使用 I-2 的 `formatLocalTimestamp()`，不再用 UTC。

#### 依赖

**软依赖 IV-1**（`output_file_pattern` 引用了 IV-1 的新文件名格式）。若 IV-1 先做，pattern 直接对齐；若 IV-1 未做，pattern 用旧格式即可，后续再更新。

**硬依赖 I-2**（timeline.md 本地时间戳使用 I-2 的 `formatLocalTimestamp()`）。

---

## ⏸ 暂缓阶段 — v0.22.0+（聚焦：可视化）

> 此阶段暂不开工，待 v0.21.0 完成后根据用户反馈决定优先级。

### II-1 MoA Webview Panel（任务仪表盘）

**状态**：⏸ PAUSED
**优先级**：🟢 高（用户最直观能感受到的功能）
**工作量**：大（12-16 小时）
**依赖**：I-2 必须完成（Webview 要展示日志数据）

#### 目标 UI

```
┌─ MoA Task Dashboard ─────────────────────────────────┐
│                                                        │
│  Active Task: moa_mrswvdj3_14d628  [Finalized]        │
│  Iterations: 10/12  |  Confidence: 95%                │
│  Convergence: ⏸️ shouldStop forced                     │
│                                                        │
│  ┌─ Roles Timeline ───────────────────────────────┐  │
│  │ Iter │ Planner │ Recon │ Refs │ Agg │ Actor │ Δ │  │
│  │  1   │    ✓    │  8    │ 8/8  │ ✓   │  —    │+.15│  │
│  │  2   │    —    │  6    │ 8/8  │ ✓   │  —    │+.57│  │
│  │ ...                                              │  │
│  └──────────────────────────────────────────────────┘  │
│                                                        │
│  [📋 View final.md]  [📊 View timeline.md]            │
│  [🗂️ Open cache folder]  [🗑️ Cleanup task]            │
│                                                        │
└────────────────────────────────────────────────────────┘
```

#### 实现方案要点

1. 新建 `src/webviewDashboard.ts`：`registerDashboardCommand(context)` 注册 `moa.showDashboard`
2. 用 `vscode.window.createWebviewPanel` 创建 panel
3. Webview 通过 `postMessage` 与扩展通信（刷新、打开文件、清理）
4. 实时更新：监听 `.moa_cache/<task_id>/state.json` 的 `vscode.workspace.onDidSaveTextDocument`
5. 数据源：meta.json + I-2 新增的结构化日志（解析 OutputChannel）

待 I-2 完成后再细化。

### II-2 任务历史列表

**状态**：⏸ PAUSED（依赖 II-1）
**工作量**：小（2-3 小时）

扫描 `.moa_cache/` 下所有 task 目录，读 `meta.json`，渲染为 Webview 侧边栏表格。

### IV-2 recon 顶层文件夹总览

**状态**：⏸ 低优先级
**工作量**：小（2-3 小时）

新增顶层 `recon/` 目录，汇总所有轮次的 recon 结果（仍保留 `iteration_NNN/recon/` 原位置）。

### IV-3 aggregator JSON 扩充

**状态**：⏸ 低优先级
**工作量**：中（3-4 小时）

`AggregatorOutput` 接口添加 `merged_from_refs[]` / `conflicts_detected[]` / `key_decisions[]` 字段。

### V-1 / V-2 / V-3 长期愿景

- **V-1 自动 CHANGELOG**：从 git commit + roadmap 自动生成（4-5h）
- **V-2 Pipeline 可视化编辑器**：Webview 拖拽编辑（20+h）
- **V-3 跨任务知识图谱**：evidence 重用、相似任务检索（30+h）

均暂缓。

---

## 附录 A — 已完成项归档

### I-1 Settings UI 全量双语化 ✅

**完成版本**：v0.20.2（超额）
**实际产出**：
- 全部 20+ `moa.*` 配置项 description 中英双语
- 所有 enumDescriptions（executionPreset / approvalMode / refDisplayMode）双语
- 子字段（role / model / systemHint / temperature）双语
- `package.nls.zh-cn.json` 补全 v0.20.0 三个 key 的英文段
- warning 标注（refDisplayMode / forceDirect / autoExecuteAfterFinalize）

### I-3 meta.json 扩充（部分完成）✅

**完成版本**：v0.19.2 §5.1
**实际产出**：
- `per_role_breakdown`：planner / recon / refs / aggregator / actor 各自的 rounds + total_elapsed_sec + total_tool_calls
- `model_invocations[]`：per-call 模型调用记录
- `total_elapsed_sec`
**缺口**（推到 IV-4）：
- `pipeline_architecture`（移到 IV-4 单独立项）
- `actor_actions_log[]`（SafeExecutor manifest.json 已覆盖此需求，不再单列）
- `total_tokens_consumed`（vscode.lm API 不暴露 token 数，无法实现）

### III-1 Actor 开关 + 用户可见化 ✅

**完成版本**：v0.18.4（基础）+ v0.20.0（超额）
**实际产出**：
- `moa.enableActorInLoop` 配置项（v0.18.4）
- `moa.approvalMode` 4 档（v0.20.0）：none / batch / per_call / batch_plus_per_call
- Gate-A（入口 QuickPick 多选）+ Gate-B（每次破坏性调用前 Yes/No）
- `ApprovalRejectedError`（source: gate_a / gate_b / reject_all）

### III-2 保守执行模式（SafeExecutor）✅

**完成版本**：v0.19.1（基础）+ v0.20.0（超额）
**实际产出**：
- `src/safeExecutor.ts` 模块
- write_file 备份到 `<target>.bak.<timestamp>`
- delete 移到 `.moa_cache/<task_id>/_trash/`
- manifest.json 审计日志（iter/seq/type/target/backup_path/status）
- v0.20.0 新增 `moa.executionPreset`（manual/supervised/autopilot/yolo/custom）
- v0.20.0 新增 `#moa_execute` LM 工具
- v0.20.0 新增 `autopilot.log`

### III-3 全工具 subagent ✅

**完成版本**：v0.13.0 + v0.19.1
**实际产出**：
- v0.13.0 移除 `copilot_` 前缀过滤，所有 vscode.lm.tools 可见
- v0.19.1 SafeExecutor 按动作语义做黑名单（write/edit/delete/run/exec/terminal/git）

---

## 附录 B — 优先级矩阵

| ID | 项目 | 优先级 | 工作量 | 状态 | 依赖 |
|---|---|---|---|---|---|
| I-1 | Settings UI 双语 | 🟡 中 | 中 | ✅ DONE v0.20.2 | 无 |
| **I-2** | **OutputChannel 粒度增强** | **🟢 高** | **中 (4-6h)** | **🚧 NEXT v0.21.0** | **无** |
| I-3 | meta.json 扩充 | 🟡 中 | 中 | ✅ 部分完成 v0.19.2 | 无 |
| II-1 | Webview Panel | 🟢 高 | 大 (12-16h) | ⏸ PAUSED | I-2 |
| II-2 | 任务历史列表 | 🟡 中 | 小 (2-3h) | ⏸ PAUSED | II-1 |
| III-1 | Actor 开关 | 🟢 高 | 中 | ✅ DONE v0.18.4 + v0.20.0 | 无 |
| III-2 | SafeExecutor | 🟢 高 | 大 | ✅ DONE v0.19.1 + v0.20.0 | III-1 |
| III-3 | 全工具 subagent | 🟡 中 | 中 | ✅ DONE v0.13.0 + v0.19.1 | III-2 |
| **IV-1** | **JSON 文件名加轮次** | **🟡 中** | **小 (2h)** | **🚧 NEXT v0.21.0** | **无** |
| IV-2 | recon 文件夹总览 | 🟢 低 | 小 (2-3h) | ⏸ PAUSED | IV-1 |
| IV-3 | aggregator JSON 扩充 | 🟡 中 | 中 (3-4h) | ⏸ PAUSED | 无 |
| **IV-4** | **meta.json pipeline_architecture** | **🟡 中** | **小 (2-3h)** | **🚧 NEXT v0.21.0** | **软依赖 IV-1** |
| V-1 | 自动 CHANGELOG | 🔴 低 | 中 (4-5h) | ⏸ PAUSED | 无 |
| V-2 | Pipeline 可视化编辑器 | 🔴 低 | 大 (20+h) | ⏸ PAUSED | II-1 |
| V-3 | 跨任务知识图谱 | 🔴 低 | 大 (30+h) | ⏸ PAUSED | 无 |

---

## 附录 C — 用户原话归档（决策依据）

> 1. actor 为什么会空跑？是开关问题还是历史逻辑判断问题？ → 已解决（v0.18.4 Actor gate 顺序 bug）
> 2. 中文化还是需要的，就中英都有 → 已解决（v0.20.2 + v0.20.3 + v0.20.4）
> 3. 版本号要动态化，就统一写 → 已解决（v0.18.4 EXTENSION_VERSION 常量）
> 4. 源码内的版本注释说明不删除（开发者与 AI 才看得到） → 持续遵循
> 5. changelog 与 roadmap 也更新一下 → 本次更新（v0.21.0 路线图重写）
> 6. 每个对话与 moa 的任务缓存，是怎么管理的？ → 已解决（v0.19.1 cacheManager + v0.20.2 cacheTtlDays=0）
> 7. 现在在最终的主会话中，没有一个总览性的对话内容能看到 → 部分解决（v0.19.2 §5.1 per-role breakdown），II-1 Webview 待做
> 8. 每个在 vscode 输出窗口的内容，似乎信息粒度不够详细 → **I-2 待做**
> 9. 缺乏全局性的查看运行状态的情况（当前进行到哪里、调用了什么模型、什么时候开始）→ **I-2 待做**
> 10. 类似于 gcmp 插件有一个可视化的插件页面 → II-1 待做
> 11. 整体状态汇总是不是需要一个 recorder 来记录？ → 已解决（v0.19.2 §5.1 meta.json 扩充）
> 12. 每个角色的提交信息都有汇报么？ → 部分解决（per_role_breakdown），OutputChannel 待 I-2
> 13. json 文件内只有文件夹中有轮次与相关排版，json 内容缺乏相应的标记 → **IV-1 待做**
> 14. 轮次是否可以也在文件名上标记，json 中则有更详细的内容 → **IV-1 待做**

---

## 附录 D — v0.21.0 实施顺序建议

```
v0.21.0 sprint（建议 1-2 天）：

Day 1 上午 (3h)：
  ├─ I-2 Step 1: 新建 src/moaLogUtils.ts + formatLogLine + formatTaskBoundary
  └─ I-2 Step 5: 测试 moaLogUtils.test.ts（先写测试，TDD）

Day 1 下午 (3h)：
  ├─ I-2 Step 2: 改造 5 个角色 hook 点（Planner / Recon / Refs / Aggregator / Actor）
  └─ I-2 Step 3: 任务边界标记（createOrchestration / finalizeTask / catch）

Day 2 上午 (2h)：
  ├─ IV-1 Step 1: 扩展 saveIterationArtifact 签名
  └─ IV-1 Step 2: 更新 7 处调用点

Day 2 下午 (3h)：
  ├─ IV-4 Step 1: 新建 src/moaCore/pipelineArchitecture.ts
  ├─ IV-4 Step 2-3: OrchestrationMeta 扩展 + renderMetaJson 注入
  ├─ IV-1 + IV-4 测试
  └─ bump v0.21.0 + 打包 + 发布
```

每步完成后 commit + 测试，避免一次性大改动难回滚。
