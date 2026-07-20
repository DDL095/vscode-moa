# vscode-moa 长期路线图（Long-Term Roadmap）

> **状态**：规划草案，按优先级分阶段实施
> **起始日期**：2026-07-20（v0.18.4 之后）
> **维护者**：DDL095
> **触发**：v0.18.4 修订过程中用户提出的 8+ 项改进方向

本文档是 vscode-moa 的长期演进路线图。每个条目包含：
- 现状（Current State）
- 痛点（Pain Point）
- 目标（Goal）
- 实现方案（Implementation）
- 工作量估算（Effort）
- 优先级（Priority）

---

## 目录

- [阶段 I — 信息可见性增强（v0.19.x）](#阶段-i--信息可见性增强v019x)
- [阶段 II — 可视化与 Webview（v0.20.x）](#阶段-ii--可视化与-webviewv020x)
- [阶段 III — Actor 安全执行模式（v0.21.x）](#阶段-iii--actor-安全执行模式v021x)
- [阶段 IV — 缓存自组织架构（v0.22.x）](#阶段-iv--缓存自组织架构v022x)
- [阶段 V — 长期愿景](#阶段-v--长期愿景)

---

## 阶段 I — 信息可见性增强（v0.19.x）

### I-1 Settings UI 全量双语化

**现状**：v0.18.4 只把 `displayName` / `description` 启用了 `%` NLS 占位符。
17 个 `moa.*` 配置项的 description 依然是英文硬编码。

**痛点**：中文用户在 VSCode Settings UI 中看到的 MoA 配置项说明全是英文，
与 Extensions 面板的中文 displayName 体验割裂。

**目标**：Settings UI 所有 `moa.*` 配置项的 description 在中文 VSCode
中显示中文，英文 VSCode 中显示英文。

**实现方案**：

1. 在 [package.json](../../package.json) 的 `contributes.configuration.properties`
   中，把每个 `description` 改为 `markdownDescription: "%moa.config.xxx%"`。
2. 在 `package.nls.json` 中添加对应的英文 key。
3. 在 `package.nls.zh-cn.json` 中添加对应的中文 key。
4. 测试：切换 VSCode 显示语言（`Configure Display Language`），验证两种语言切换正常。

**涉及配置项**（17 个）：

- `moa.refModels`, `moa.aggregator`, `moa.parallelRefs`, `moa.parallelRecon`
- `moa.presets`, `moa.activePreset`, `moa.sharedRefPrompt`, `moa.refDisplayMode`
- `moa.enableActingAgent`, `moa.enableRecon`, `moa.maxReconRounds`
- `moa.reconContextChars`, `moa.forceDirect`, `moa.maxReconIterations`
- `moa.reconAllowTerminal`, `moa.reconEarlyStopStagnant`, `moa.reconEarlyStopSaturated`
- `moa.reconL3Threshold`, `moa.reconL3MaxCalls`, `moa.reconL3TargetChars`
- `moa.reconModel`, `moa.l3Summarizer`

**工作量**：中（2-3 小时，主要是翻译 + 测试）

**优先级**：🟡 中（用户体验提升，非功能缺陷）

---

### I-2 VSCode 输出窗口粒度增强

**现状**：v0.17.0 引入了 5 个独立 OutputChannel（Planner / Recon / Refs /
Aggregator / Actor），但每个 channel 的日志粒度不够详细。

**痛点**：用户反馈"信息粒度不够详细，缺乏全局性的查看运行状态的情况，
比如当前进行到哪里了、调用了什么模型、什么时候开始的"。

**目标**：每个 OutputChannel 的每条日志包含完整的元信息：

```
[2026-07-20T10:30:45.123Z] [iter 3] [Refs/advisor_1] [model: DeepSeek-V4-Flash]
  → callLLM (system 450 chars, user 12,340 chars)
  ← response (8,901 chars, elapsed 3.2s, tool_calls: 0)
  → JSON parse OK, confidence=0.85, new_findings=3
```

**实现方案**：

1. 在 [src/moaOrchestrator.ts](../../src/moaOrchestrator.ts) 的 `logPipelineBlock`
   函数中，扩展日志格式。
2. 给每个角色的 log 行加：时间戳 / iter 号 / 角色标签 / 模型名 /
   token 数（如能从 response 获取）/ 耗时 / 工具调用序列。
3. 新增"任务开始 / 结束"标记行（`=== Task started ===` / `=== Task finalized ===`），
   带完整任务元信息。

**字段扩展**：

| 角色 | 当前日志 | 扩展后 |
|---|---|---|
| Planner | `--- Planner ---` + raw | + 模型名 + 耗时 + sub_questions 数 + recon_hints 数 |
| Recon | `tool_calls` + summary | + 模型名 + 每个工具的 name/input摘要/output 长度 + 早停原因 |
| Refs | 每个 ref 的 raw | + 模型名 + token 数 + 耗时 + JSON parse 状态 |
| Aggregator | raw + parsed JSON | + 模型名 + 耗时 + next_action 决策依据 |
| Actor | 每个 action_item 的 status | + 模型名 + 每个工具调用的完整 input/output + 备份文件路径 |

**工作量**：中（4-6 小时，主要是日志格式设计 + 5 个角色的 hook 点扩展）

**优先级**：🟡 中

---

### I-3 recorder 整体状态汇总（meta.json 扩充）

**现状**：`meta.json` 字段少（task_id / task / created_at / iteration_count /
status / ref_models / aggregator_model / completeness_timeline /
total_evidence_items / final_confidence）。

**痛点**：用户反馈"想要查看相关流程进度确实只有 timeline 一个文件能看，
汇总信息不足"。

**目标**：`meta.json` 成为"单一聚合状态文件"，包含：

```json
{
  "task_id": "...",
  "task": "...",
  "created_at": "...",
  "finished_at": "...",
  "iteration_count": 10,
  "status": "finalized",
  "convergence_source": "should_stop",

  "pipeline_architecture": {
    "version": "0.19.0",
    "roles": ["Planner", "Recon", "Refs", "Aggregator", "Actor"],
    "max_iter": 12,
    "completeness_threshold": 0.8
  },

  "models": {
    "refs": ["DeepSeek-V4-Flash", "DeepSeek-V4-Pro", ...],
    "aggregator": "GLM-5.2 (CodingPlan)",
    "recon": ["DeepSeek-V4-Pro", "MiniMax-M3"],
    "recon_aggregator": "GLM-5.2 (CodingPlan)",
    "planner": "GLM-5.2 (CodingPlan)",
    "actor": "GLM-5.2 (CodingPlan)",
    "l3_summarizer": "MiniMax-M3 (TokenPlan)"
  },

  "model_invocations": [
    { "iter": 1, "role": "planner", "model": "...", "elapsed_sec": 3.2, "tool_calls": 0 },
    { "iter": 1, "role": "recon", "model": "...", "elapsed_sec": 12.5, "tool_calls": 8 },
    ...
  ],

  "per_role_breakdown": {
    "planner": { "rounds": 1, "total_elapsed_sec": 3.2 },
    "recon": { "rounds": 7, "total_elapsed_sec": 87.3, "total_tool_calls": 412 },
    "refs": { "rounds": 10, "total_elapsed_sec": 156.8 },
    "aggregator": { "rounds": 10, "total_elapsed_sec": 45.2 },
    "actor": { "rounds": 3, "total_elapsed_sec": 67.1, "actions_executed": 5 }
  },

  "actor_actions_log": [
    { "iter": 3, "type": "write_file", "target": "...", "status": "success", "artifacts": [...] },
    ...
  ],

  "completeness_timeline": [...],
  "total_tokens_consumed": 125000,
  "total_elapsed_sec": 432.5
}
```

**实现方案**：

1. 在 [src/moaOrchestrator.ts](../../src/moaOrchestrator.ts) 的 `OrchestrationMeta`
   接口中添加上述字段。
2. 在每个角色执行点（callPlanner / callRecon / callRefs / callAggregator /
   callActor）记录 `model_invocations[]`。
3. `renderMetaJson` 末尾汇总 `per_role_breakdown` 和 `total_*`。

**工作量**：中（4-5 小时）

**优先级**：🟡 中（与 I-2 配套）

---

## 阶段 II — 可视化与 Webview（v0.20.x）

### II-1 MoA Webview Panel（核心可视化）

**现状**：用户只能在 VSCode Output 面板看 5 个角色的文本日志，或读
`.moa_cache/<task_id>/` 下的 JSON/MD 文件。

**痛点**：用户反馈"这个最终我觉得可以类似于 gcmp 插件有一个可视化的插件页面，
实时查看相应的细节与内容"。

**目标**：新增命令 `MoA: Show Task Dashboard`，打开 Webview panel：

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
│  │  3   │    —    │  9    │ 8/8  │ ✓   │ 1/1   │-.07│  │
│  │ ...                                              │  │
│  └──────────────────────────────────────────────────┘  │
│                                                        │
│  ┌─ Models Used ──────────────────────────────────┐  │
│  │ Refs: DeepSeek-V4-Flash / DeepSeek-V4-Pro / ... │  │
│  │ Aggregator: GLM-5.2 (CodingPlan)                │  │
│  │ Actor: GLM-5.2 (CodingPlan) [3 rounds]          │  │
│  └──────────────────────────────────────────────────┘  │
│                                                        │
│  [📋 View final.md]  [📊 View timeline.md]            │
│  [🗂️ Open cache folder]  [🗑️ Cleanup task]            │
│                                                        │
└────────────────────────────────────────────────────────┘
```

**实现方案**：

1. 新增 [src/webviewDashboard.ts](../../src/webviewDashboard.ts)：
   - `registerDashboardCommand(context)` 注册 `moa.showDashboard` 命令
   - `renderDashboard(state, meta)` 生成 HTML
   - 用 `vscode.window.createWebviewPanel` 创建 panel
2. Webview 通过 `postMessage` 与扩展通信（刷新状态、打开文件、清理任务）
3. 实时更新：监听 `.moa_cache/<task_id>/state.json` 的 `onDidChangeFiles`
4. 复用现有 5 个 OutputChannel 的日志数据

**工作量**：大（12-16 小时，主要是 Webview UI 设计 + 实时更新逻辑）

**优先级**：🟢 高（用户明确要求）

**依赖**：I-2 / I-3（meta.json 字段扩充后再做 Webview 更有信息可展示）

---

### II-2 任务历史列表

**现状**：`.moa_cache/` 下有多个 task 目录，但没有总览视图。

**目标**：Webview 侧边栏显示所有历史任务列表，点击切换查看详情。

**实现方案**：

1. 扫描 `.moa_cache/` 下所有 task 目录
2. 读每个 `meta.json`，提取 task_id / task / created_at / status / confidence
3. 渲染为表格

**工作量**：小（2-3 小时，依赖 II-1）

**优先级**：🟡 中

---

## 阶段 III — Actor 安全执行模式（v0.21.x）

### III-1 Actor 开关 + 用户可见化

**现状**：v0.18.4 修复了 Actor 空跑 bug，但 Actor 一旦触发就会自动执行，
用户在 chat 中看不到详细的执行过程（只在 OutputChannel 有日志）。

**痛点**：用户反馈"actor 可以做个开关，来进行限制，如果要用的话，
让用户能在对话窗口看到相应的操作"。

**目标**：

1. 新增配置项 `moa.enableActorInLoop`（默认 `false`）：
   - `false`：Actor 角色被跳过，Aggregator 的 `actor_needed` 建议被忽略，
     loop 继续走 recon_needed 路径（与 v0.18.3 行为类似，但不再空跑）
   - `true`：Actor 正常执行（v0.18.4 默认行为）
2. Actor 执行时，每个 action_item 的执行过程实时流式打到 chat（不只是 progress）
3. 新增配置项 `moa.actorConfirmationMode`（默认 `'silent'`）：
   - `'silent'`：自动执行，事后汇总（当前行为）
   - `'confirm_each'`：每个 action_item 执行前弹窗确认
   - `'confirm_destructive'`：只有 write_file / execute 类 action 需确认

**实现方案**：

1. [package.json](../../package.json) 新增 2 个配置项
2. [src/moaOrchestrator.ts](../../src/moaOrchestrator.ts) 阶段 5：
   ```typescript
   if (aggOutput.next_action === 'actor_needed' && !config.enableActorInLoop) {
     // Actor 被禁用，降级为 recon_needed（或直接 finalize）
     state.status = 'running';
     progress?.(`[MoA] Actor disabled, continuing with recon_needed`);
   } else if (aggOutput.next_action === 'actor_needed' && ...) {
     // 正常执行 Actor（v0.18.4 行为）
   }
   ```
3. [src/moaCore/runActor.ts](../../src/moaCore/runActor.ts)：执行每个
   action_item 时通过 stream.markdown 实时输出

**工作量**：中（4-5 小时）

**优先级**：🟢 高

---

### III-2 保守执行模式（bak 备份 + manifest 落盘）

**现状**：Actor 执行 `write_file` / `execute` 类 action 时直接操作，
没有备份，没有操作清单。

**痛点**：用户反馈"不管是内置开关让内置可用，还是到主会话再拉起，
都必须保守性的执行，遇到删除就都进行 bak 备份，然后将清单落盘，
保证信息传递准确度，最后汇总给用户，是否清理与删除要让用户进行操作"。

**目标**：新增模块 [src/safeExecutor.ts](../../src/safeExecutor.ts)，所有
副作用类 action（write_file / execute / delete）走安全执行路径：

```
1. 预检查：
   - 工具白名单（只允许 read/grep/write_file/run_in_terminal）
   - 路径合法性（禁止相对路径越界、禁止系统目录）

2. 备份（write_file / delete 类）：
   - 目标文件存在 → 复制到 `<target>.bak.<timestamp>`
   - 记录到 manifest.json

3. 执行：
   - write_file：先写 .tmp，再 rename（原子化）
   - execute：run_in_terminal，捕获 stdout/stderr/exit_code
   - delete：移动到 .moa_cache/<task_id>/_trash/ 而非真删

4. 落盘 manifest：
   .moa_cache/<task_id>/manifest.json
   [
     {
       "iter": 3,
       "type": "write_file",
       "target": "/path/to/file.ts",
       "backup": "/path/to/file.ts.bak.20260720-103045",
       "status": "success",
       "bytes_written": 1234,
       "timestamp": "..."
     },
     ...
   ]

5. 汇总：
   - Actor 末尾在 chat 显示完整 manifest 表
   - 用户可选择：
     a. 确认保留（删除 .bak 文件）
     b. 回滚（从 .bak 恢复）
     c. 推迟到以后
```

**实现方案**：

1. 新增 [src/safeExecutor.ts](../../src/safeExecutor.ts)：
   - `class SafeExecutor` 封装所有副作用类操作
   - 内置白名单 / 黑名单 / 备份 / manifest 逻辑
2. [src/moaCore/runActor.ts](../../src/moaCore/runActor.ts) 改为调 SafeExecutor
3. [package.json](../../package.json) 新增配置项 `moa.safeExecutionMode`
   （默认 `'on'`，可关闭）
4. manifest.json 格式标准化，支持后续审计 / 回滚

**工作量**：大（10-12 小时，主要是边界情况处理 + 测试）

**优先级**：🟢 高（用户明确要求的安全特性）

---

### III-3 LLM 拉全工具 subagent 执行

**现状**：Actor 只能用 `vscode.lm.tools` 中已注册的工具。

**痛点**：用户反馈"不知道能否让 llm 或者 vscode 拉取全工具的 subagent
去执行相应内容"。

**目标**：Actor 角色在执行时，可以调用**所有**已注册的 vscode.lm 工具
（包括 Copilot Chat 的内置工具、MCP 工具、第三方扩展工具）。

**实现方案**：

1. 在 [src/moaCore/runActor.ts](../../src/moaCore/runActor.ts) 的
   `runActingAgent` 调用中，传入完整的 `vscode.lm.tools` 列表（不再过滤）
2. 工具黑名单迁移到 SafeExecutor（按动作语义过滤，而非工具名前缀）
3. 测试：验证 Actor 能调用 copilot_editFile / mcp_* / gcmp_* 等工具

**工作量**：中（3-4 小时，主要是测试覆盖）

**优先级**：🟡 中（依赖 III-2 的 SafeExecutor 提供安全边界）

---

## 阶段 IV — 缓存自组织架构（v0.22.x）

### IV-1 JSON 文件名加轮次标记

**现状**：`iteration_001/refs/advisor_1.json`（路径已有轮次，但文件名无）。

**痛点**：用户反馈"json 内容缺乏相应的标记，轮次是否可以也在文件名上标记"。

**目标**：JSON 文件名自描述，复制到任何地方都能识别来源：

```
iteration_001__planner__GLM-5.2.json
iteration_001__recon__DeepSeek-V4-Pro.json
iteration_001__refs__advisor_1__DeepSeek-V4-Flash.json
iteration_001__aggregator__GLM-5.2.json
iteration_001__actor__GLM-5.2.json
```

**实现方案**：

1. 在 `saveIterationArtifact` 函数中，把 iteration 号 + 角色 + 模型名
   拼入文件名
2. 保留原目录结构（iteration_NNN/）作为视觉分组
3. 向后兼容：读取时同时支持新旧命名

**工作量**：小（2 小时）

**优先级**：🟡 中

---

### IV-2 recon 按文件夹放置 + 顶层总览

**现状**：`iteration_NNN/recon/*.json` 分散在各轮目录。

**痛点**：用户反馈"recon 的内容有按照文件夹放置么？"

**目标**：

1. 新增顶层 `recon/` 目录，汇总所有轮次的 recon 结果：
   ```
   .moa_cache/<task_id>/
     recon/
       iter_001__DeepSeek-V4-Pro.json
       iter_001__MiniMax-M3.json
       iter_002__DeepSeek-V4-Pro.json
       ...
     iteration_001/
       recon/  ← 保留原位置（软链接或复制）
   ```
2. 顶层 `recon/README.md` 自动生成，列出每轮 recon 的摘要

**工作量**：小（2-3 小时）

**优先级**：🟢 低

---

### IV-3 aggregator JSON 扩充

**现状**：aggregator JSON 只有 synthesis / completeness / gaps / next_action。

**痛点**：用户反馈"aggregator 当中好像都是单纯的内容与单文件"。

**目标**：aggregator JSON 扩充为：

```json
{
  "synthesis": "...",
  "completeness": 0.85,
  "critical_gaps": [...],
  "next_action": "actor_needed",

  "merged_from_refs": [
    { "ref": "advisor_1", "contribution": "...", "weight": 0.3 },
    { "ref": "advisor_2", "contribution": "...", "weight": 0.4 },
    ...
  ],

  "conflicts_detected": [
    {
      "topic": "...",
      "ref_a": "advisor_1",
      "ref_b": "advisor_3",
      "position_a": "...",
      "position_b": "...",
      "resolution": "..."
    }
  ],

  "key_decisions": [
    {
      "decision": "选择方案 A 而非方案 B",
      "rationale": "...",
      "supporting_refs": ["advisor_1", "advisor_2"]
    }
  ]
}
```

**实现方案**：

1. 在 [src/moaCore/roles.ts](../../src/moaCore/roles.ts) 的 AggregatorOutput
   接口中添加上述字段
2. 修改 [src/moaOrchestrator.ts](../../src/moaOrchestrator.ts) 的
   `buildAggregatorPromptV2`，让 Aggregator LLM 输出新字段
3. 读取时兼容老格式（字段缺失时用默认值）

**工作量**：中（3-4 小时）

**优先级**：🟡 中

---

### IV-4 meta.json 自组织架构字段

**现状**：meta.json 只是状态记录，不能让无上下文 AI 还原整个 MoA 架构。

**痛点**：用户反馈"如果将全部文件提取出来喂给一个无上下文背景的 ai，
应该能根据 json 内的字段，自组织起来与现在完整的架构"。

**目标**：meta.json 增加 `pipeline_architecture` 字段：

```json
{
  "pipeline_architecture": {
    "version": "0.22.0",
    "description": "5-role Hermes-style MoA pipeline",
    "roles": [
      {
        "name": "Planner",
        "order": 1,
        "runs_when": "iter 1 only",
        "description": "Clarify task, emit sub_questions / recon_hints",
        "output_file_pattern": "iteration_{NNN}/planner.json"
      },
      {
        "name": "Recon",
        "order": 2,
        "runs_when": "every iter (unless reconContext provided)",
        "description": "Gather file contents relevant to the task",
        "output_file_pattern": "iteration_{NNN}/recon/*.json"
      },
      ...
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
      "iterations": "iteration_NNN/{role}.json"
    }
  }
}
```

**实现方案**：

1. 在 `OrchestrationMeta` 接口中添加 `pipeline_architecture` 字段
2. 用常量定义架构（避免每次发版手改）
3. `renderMetaJson` 末尾写入

**工作量**：小（2-3 小时）

**优先级**：🟡 中（是 IV-1/2/3 的元数据基础）

---

## 阶段 V — 长期愿景

### V-1 自动 CHANGELOG 生成

**现状**：每次发版手工编写 CHANGELOG。

**目标**：从 git commit 历史 + roadmap 文档自动生成 CHANGELOG 草稿。

**工作量**：中（4-5 小时）

**优先级**：🔴 低

---

### V-2 MoA Pipeline 可视化编辑器

**现状**：用户只能通过 8 步 Configure Models 命令配置 pipeline。

**目标**：Webview 中可视化编辑 pipeline（拖拽角色节点、连线、设置模型）。

**工作量**：大（20+ 小时）

**优先级**：🔴 低

---

### V-3 跨任务知识图谱

**现状**：每个 `.moa_cache/<task_id>/` 是独立的，任务间的 knowledge 不共享。

**目标**：建立跨任务的知识图谱（evidence 重用、相似任务检索）。

**工作量**：大（30+ 小时）

**优先级**：🔴 低

---

## 附录 A — 优先级矩阵

| 阶段 | 项目 | 优先级 | 工作量 | 依赖 |
|---|---|---|---|---|
| I-1 | Settings UI 双语 | 🟡 中 | 中 | 无 |
| I-2 | OutputChannel 粒度增强 | 🟡 中 | 中 | 无 |
| I-3 | meta.json 扩充 | 🟡 中 | 中 | 无 |
| II-1 | Webview Panel | 🟢 高 | 大 | I-2, I-3 |
| II-2 | 任务历史列表 | 🟡 中 | 小 | II-1 |
| III-1 | Actor 开关 + 可见化 | 🟢 高 | 中 | 无 |
| III-2 | 保守执行模式 | 🟢 高 | 大 | III-1 |
| III-3 | 全工具 subagent | 🟡 中 | 中 | III-2 |
| IV-1 | JSON 文件名加轮次 | 🟡 中 | 小 | 无 |
| IV-2 | recon 文件夹总览 | 🟢 低 | 小 | 无 |
| IV-3 | aggregator JSON 扩充 | 🟡 中 | 中 | 无 |
| IV-4 | meta.json 自组织 | 🟡 中 | 小 | IV-1, IV-3 |
| V-1 | 自动 CHANGELOG | 🔴 低 | 中 | 无 |
| V-2 | Pipeline 可视化编辑器 | 🔴 低 | 大 | II-1 |
| V-3 | 跨任务知识图谱 | 🔴 低 | 大 | 无 |

---

## 附录 B — 建议发版节奏

- **v0.19.0**（8 月）：I-1 + I-2 + I-3（信息可见性增强）
- **v0.20.0**（9 月）：II-1 + II-2（Webview 可视化）
- **v0.21.0**（10 月）：III-1 + III-2 + III-3（Actor 安全执行）
- **v0.22.0**（11 月）：IV-1 + IV-2 + IV-3 + IV-4（缓存自组织）
- **v0.23.0+**：V-1 / V-2 / V-3（长期愿景，择机实施）

---

## 附录 C — 用户原话归档（决策依据）

> 1. actor 为什么会空跑？是开关问题还是历史逻辑判断问题？
> 2. 中文化还是需要的，就中英都有
> 3. 版本号要动态化，就统一写
> 4. 源码内的版本注释说明不删除（开发者与 AI 才看得到）
> 5. changelog 与 roadmap 也更新一下
> 6. 每个对话与 moa 的任务缓存，是怎么管理的？
> 7. 现在在最终的主会话中，没有一个总览性的对话内容能看到
> 8. 每个在 vscode 输出窗口的内容，似乎信息粒度不够详细
> 9. 缺乏全局性的查看运行状态的情况（当前进行到哪里、调用了什么模型、什么时候开始）
> 10. 类似于 gcmp 插件有一个可视化的插件页面
> 11. 整体状态汇总是不是需要一个 recorder 来记录？
> 12. 每个角色的提交信息都有汇报么？
> 13. json 文件内只有文件夹中有轮次与相关排版，json 内容缺乏相应的标记
> 14. 轮次是否可以也在文件名上标记，json 中则有更详细的内容
> 15. recon 的内容有按照文件夹放置么？
> 16. 如果将全部文件提取出来喂给一个无上下文背景的 ai，应该能根据 json 内的字段，自组织起来与现在完整的架构
> 17. aggregator 当中好像都是单纯的内容与单文件
> 18. actor 可以做个开关，来进行限制，如果要用的话，让用户能在对话窗口看到相应的操作
> 19. 不知道能否让 llm 或者 vscode 拉取全工具的 subagent 去执行相应内容
> 20. 不管是内置开关让内置可用，还是到主会话再拉起，都必须保守性的执行
> 21. 遇到删除就都进行 bak 备份，然后将清单落盘，保证信息传递准确度
> 22. 最后汇总给用户，是否清理与删除要让用户进行操作
> 23. 相应的操作可以有日志

以上 23 条用户反馈已全部映射到本路线图的某个项目或已在 v0.18.4 中解决。
