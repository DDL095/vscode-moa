# vscode-moa Configuration Reference / 配置完整参考

> 所有配置都在 `moa.*` 命名空间下。通过 `settings.json` 编辑，或用 **`Moa: Configure Models`** 8 步引导流程。VSCode 设置 UI 描述已在 v0.20.2+ 全部双语化（中文 + 英文）。
>
> All configs live under the `moa.*` namespace. Edit via `settings.json` or use the **`Moa: Configure Models`** 8-step guided flow. VSCode settings UI descriptions have been fully bilingual (CN + EN) since v0.20.2+.

## 目录 / Table of contents

- [Models / 模型](#models--模型)
- [Pipeline behavior / 流水线行为](#pipeline-behavior--流水线行为)
- [Recon tuning / Recon 调优 (v0.13.0+)](#recon-tuning--recon-调优-v0130)
- [Actor execution control / Actor 执行控制 (v0.20.0+)](#actor-execution-control--actor-执行控制-v0200)
- [Cache & lifecycle / 缓存与生命周期 (v0.19.1+, v0.20.2)](#cache--lifecycle--缓存与生命周期-v0191-v0202)
- [**Planner mini-loop / Planner mini-loop (v0.22.0+)**](#planner-mini-loop--planner-mini-loop-v0220)
- [**Recon Aggregator self-iteration / Recon Aggregator 自迭代 (v0.22.0+)**](#recon-aggregator-self-iteration--recon-aggregator-自迭代-v0220)
- [**Role Setup Preset / 角色设定预设 (v0.22.0+)**](#role-setup-preset--角色设定预设-v0220)
- [**Plan Mode Report & final.md inline / Plan 报告与 final.md 内嵌 (v0.22.0+)**](#plan-mode-report--finalmd-inline--plan-报告与-finalmd-内嵌-v0220)

---

## Models / 模型

| Key | Type | Default | Description |
|---|---|---|---|
| `moa.presets` | `Object<name, MoaPreset>` | `{}` | 命名预设组，每个打包 refs + aggregator + recon + L3。通过 **`Moa: Switch Preset`** 切换。*(v0.14.14+；v0.18.0: preset schema 新增 `reconModels[]` + `reconAggregator`)* |
| `moa.activePreset` | string | `"default"` | `moa.presets` 中当前激活组的 key。*(v0.14.14+)* |
| `moa.refModels` | `Array<{role, model}>` | `[]` | 参考顾问。`model` 作为子串匹配 `LanguageModelChat.id`。*(旧扁平配置；首次使用时自动迁移到 `presets.default`)* |
| `moa.aggregator` | `{model, temperature?}` | `{}` | Aggregator 模型（子串匹配）。 |
| `moa.reconModel` | `{model}` | `{model: ""}` | 单个 Recon 模型。空 = 复用 aggregator。*(并行多模型 Recon 请用 `preset.reconModels[]` —— v0.18.0)* |
| `moa.l3Summarizer` | `{model}` | `{model: ""}` | L3 孙代理模型。空 = 禁用 L3。 |

## Pipeline behavior / 流水线行为

| Key | Type | Default | Description |
|---|---|---|---|
| `moa.parallelRefs` | boolean | `true` | 并行扇出 refs（`Promise.allSettled`）—— wall-clock = 最慢的 ref。设 `false` 为串行扇出（适合 provider 限并发的场景）。*(v0.14.14: 默认从 `false` 翻转为 `true`)* |
| `moa.parallelRecon` | boolean | `true` | `preset.reconModels` 有 2+ 个模型时并行扇出 Recon agent。`false` 或只配 1 个 recon 模型时，串行运行。*(v0.18.0)* |
| `moa.sharedRefPrompt` | string | `""` | 覆盖共享 ref system prompt。空 = 内置 Hermes prompt。 |
| `moa.refDisplayMode` | `"thinking"` \| `"verbose"` | `"thinking"` | ⚠️ **保持 `thinking`（默认，强烈推荐）**。`thinking` 让 refs 不进 chat history（Hermes 风格 —— refs 写入 'MoA Refs' 面板，aggregator 只读内存中的 JSON）。`verbose` 把 refs 以 markdown 内联流式输出 **且** 记入 chat history —— ⚠️ **上下文污染风险**：数千 token × N refs × M 轮迭代会累积到 Copilot 上下文，拖慢 follow-up，甚至让 aggregator 混乱。仅当你明确需要 Copilot follow-up 引用单个 ref 意见时才用 `verbose`。 |
| `moa.enableRecon` | boolean | `true` | 切换 Phase 0。 |
| `moa.enableActingAgent` | boolean | `true` | 切换 Phase 3。 |
| `moa.forceDirect` | boolean | `false` | ⚠️ **警告 —— 绕过多模型安全网。** 跳过整个流水线 —— acting agent 直接跑。失去：(1) 跨模型校验、(2) recon 收集的证据、(3) aggregator 综合。仅在反复遭遇多模型失败后才用。 |
| `moa.maxReconRounds` | number (1-20) | `3` | 充分性 loop 上限。v0.20.1 上限从 5 → 10；v0.20.2 进一步提到 20 以支持深度研究。 |

## Recon tuning / Recon 调优 (v0.13.0+)

| Key | Default | Description |
|---|---|---|
| `moa.maxReconIterations` | `50` | Recon 每个任务的硬性工具调用上限。v0.20.1 上限从 100 → 200；v0.20.2 进一步提到 500 以支持超大型 monorepo / 深度研究。 |
| `moa.reconContextChars` | `500000` | **[DEPRECATED v0.14.5]** 不再作上限；仅作为审计指标记录到 `meta.json`。原 v0.13.0 角色（字符预算截断）在 v0.14.5 被移除 —— refs 单轮无历史 + 1M 上下文模型可消化任意大小；如果 recon 真爆了，那是 LLM 的搜索方向问题，不是截断问题。保留仅为向后兼容。 |
| `moa.reconAllowTerminal` | `false` | 允许 recon 用 terminal 工具（默认关，以策安全）。 |
| `moa.reconEarlyStopStagnant` | `2` (max 50) | 连续 N 次工具签名完全相同后停止。v0.20.2 上限从 10 → 50。 |
| `moa.reconEarlyStopSaturated` | `200` (max 50000) | iterations > 5 后，连续 N 轮新增 <200 字符则停止。v0.20.2 上限从 5000 → 50000。 |
| `moa.reconL3Threshold` | `200000` (min 10000) | 触发 L3 摘要的单文件大小（字符）。v0.14.4 从 60k → 200k —— 现代 1M 上下文模型很少需要 L3；只有真正巨型文件（生成的 schema、minified bundle）才触发。v0.20.2 minimum 从 50000 → 10000 允许更激进触发。 |
| `moa.reconL3MaxCalls` | `5` (max 100) | 单次 MoA 任务最多派多少个 L3 孙代理。`0` 禁用。v0.20.2 上限从 20 → 100。 |
| `moa.reconL3TargetChars` | `50000` (max 500000) | L3 目标输出长度（字符）。v0.14.4 从 10k → 50k 避免过度压缩。v0.20.2 新增 maximum=500000 上限。 |

## Actor execution control / Actor 执行控制 (v0.20.0+)

Actor 角色（Phase 5）会**真正执行** Aggregator 给出的 `action_items` —— 可能写文件、跑终端命令、产生副作用。v0.20.0 引入分层控制系统来门控这种权力。

### 速查表 / Quick reference —— 4+1 个 `executionPreset` 模式

| Preset | finalize 后自动执行？ | 审批弹窗 | `.bak.<ts>` 备份 | 适用场景 |
|---|---|---|---|---|
| `manual`（默认） | ❌ 只返回 markdown，需用户/主会话显式调用 `#moa_execute` | `batch`（Gate-A QuickPick） | ✅ | 首次使用、探索性任务 |
| `supervised` | ✅ | `batch`（每轮 Gate-A QuickPick 多选） | ✅ | 有人值守的常规任务 |
| `autopilot` | ✅ | `none`（零人工介入） | ✅（唯一安全网） | 可信 CI / 重试流水线 |
| `yolo` | ✅ | `none` | ❌（不可逆） | 沙盒 / 一次性运行 |
| `custom` | 由 `autoExecuteAfterFinalize` 控制 | 由 `approvalMode` 控制 | 由 `safeExecutionMode` 控制 | 手动细粒度控制 |

### 每个 preset 的执行流程 / Execution flow per preset

```
finalize 完成
   │
   ├─ manual:        返回 markdown → 用户/主会话调用 #moa_execute → Gate-A QuickPick → 执行
   ├─ supervised:    自动调 Actor → Gate-A QuickPick 多选 → 执行（safeMode 开）
   ├─ autopilot:     自动调 Actor → 立即执行（safeMode 开，无弹窗）
   ├─ yolo:          自动调 Actor → 立即执行（safeMode 关，无弹窗，无备份）
   └─ custom:        行为由下方 3 个细粒度配置驱动
```

### 3 个细粒度配置 / Fine-grained configs（仅在 `executionPreset='custom'` 时生效）

| Key | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `moa.autoExecuteAfterFinalize` | boolean | `false` | `true` = `finalizeTask()` 自动调用 Actor；`false` = 只返回 markdown，需手动 `#moa_execute`。 |
| `moa.approvalMode` | `none` \| `batch` \| `per_call` \| `batch_plus_per_call` | `batch` | 破坏性工具调用前的审批门。`batch` = Gate-A 入口 QuickPick；`per_call` = Gate-B 每次破坏性调用前 Yes/No 对话框；`batch_plus_per_call` = 双门。 |
| `moa.safeExecutionMode` | boolean | `true` | `true` = SafeExecutor 把每个 `write_file` 备份到 `<目标>.bak.<时间戳>`，所有操作记录到 `manifest.json`。`false` = 无备份（不可逆）。 |

### 审批门 —— 两种风格 / Approval gates

- **Gate-A（批量 / batch）**：每次 Actor 调用入口弹 QuickPick 多选框，列出所有 `action_items`（type + target + rationale），用户可反选不想要的项。被拒绝的项以 `status: rejected_by_user` 记入 `manifest.json` 以便审计。
- **Gate-B（逐次 / per_call）**：每个破坏性工具调用前（`write_file` / `delete` / `execute`）弹 Yes/No/Yes to All/Reject All 对话框。`Yes to All` 在本任务内跳过后续 Gate-B 提示；`Reject All` 抛 `ApprovalRejectedError` 并中止 Actor。

### 审计与回滚 / Audit & recovery

- 任何 preset 下的每个副作用操作都被记录到 `.moa_cache/<task_id>/manifest.json`，字段含 `iter` / `seq` / `type` / `target` / `tool_name` / `input_summary` / `status` / `backup_path` / `output_chars` / `timestamp`。
- 备份写入 `<target>.bak.<timestamp>`（原文件旁边）。要回滚：删新文件，把 `.bak.<ts>` 改回原名即可。
- 任务目录里的 `autopilot.log`（v0.20.0）是人类可读摘要：`started_at` / `elapsed_sec` / `tool_calls` / 每个 action 的 status。适合 CI 日志。

### 每个场景的推荐 preset / Recommended preset per scenario

| 场景 | 推荐 preset | 原因 |
|---|---|---|
| 首次用户尝试 MoA | `manual` | 先看流水线产出什么，再决定是否执行 |
| 日常编码助手（你在屏幕前） | `supervised` | 自动执行 + 可视审批 |
| 夜间批处理 / CI 流水线 | `autopilot` | 零人工介入，备份作为安全网 |
| 沙盒实验（VM / 容器） | `yolo` | 快速迭代，无备份开销 |
| 需要混搭行为 | `custom` | 独立控制 3 个维度 |

## Cache & lifecycle / 缓存与生命周期 (v0.19.1+, v0.20.2)

| Key | 默认值 | 说明 |
|---|---|---|
| `moa.cacheTtlDays` | `30` | 超过此 TTL（天）的任务会在运行 `MoA: Cleanup Old Tasks` 命令时被清理。**v0.20.2：设为 0 完全禁用 TTL 清理**（任务永不自动删除，需手动删 `.moa_cache/`）。上限从 365 提到 36500（约 100 年）以支持长期归档。 |
| `moa.cacheRootDir` | `""` (空) | 覆盖缓存根目录。默认空（用 `<workspaceFolder>/.moa_cache/`）。设为绝对路径可跨工作区集中存储所有 MoA 任务缓存。 |

### 常见模式 / Common patterns

- **默认（30 天）**：适合多数用户；过期实验每月自动清理。
- **`0`（永不删除）**：长期研究项目，几个月后还想审计每个任务。
- **`365`（1 年）**：保留期与磁盘占用的平衡。
- **自定义 `cacheRootDir`**：设为如 `D:/moa_cache` 可跨多个工作区共享缓存（适合 CI）。

---

## Planner mini-loop / Planner mini-loop (v0.22.0+)

> **核心改动**：Planner 从"单次调用"升级为"可迭代 mini-loop"，并新增 `role_setup` 字段（Planner 设计下游 3 角色 recon/recon_aggregator/actor 的身份）。完整设计见 [roadmap/v0.22.0-role-injection-overhaul.md](roadmap/v0.22.0-role-injection-overhaul.md) P0-1。

| Key | Type | Default | Description |
|---|---|---|---|
| `moa.enablePlannerIteration` | boolean | `true` | 开启 Planner mini-loop（带 plan_coverage 收敛判断）。**关闭则回退到 v0.21.x 单次调用模式**——向后兼容开关。 |
| `moa.plannerMaxIterations` | number (1-20) | `5` | Planner mini-loop 最大迭代次数。`1` = 单次模式（与 `enablePlannerIteration=false` 等价）；绝对硬上限 20。简单任务通常 1-2 次即收敛。 |
| `moa.plannerCoverageThreshold` | number (0.5-1.0) | `0.9` | plan_coverage 收敛阈值。Planner 自评 ≥ 此值则停止迭代。低于 0.5 且 iter ≥ 2 触发 `ask_user` 询问用户。 |
| `moa.plannerAllowTools` | boolean | `true` | iter 2+ 是否允许 Planner 调用 read-only 工具（`read_file` / `list_dir` / `grep_search` / `get_errors`）。每轮最多 3 次工具调用（防过度探索）。 |

**典型场景**：

| 任务难度 | 通常迭代次数 | 说明 |
|---|---|---|
| 简单（single 模式）| 1 | plan_coverage 首次即 ≥ 0.9 |
| 中等 | 2-3 | 第 2 次补查 1-2 个文件后收敛 |
| 复杂 / 模糊 | 3-5 | 多次探索 + 可能触发 `ask_user` |
| 极端不可解 | 触发 ask_user | plan_coverage < 0.5 时停止并询问用户 |

**输出 schema 扩展**：PlannerOutput 新增 7 字段（全部可选，向后兼容）：`task_type` / `process_language` / `plan_coverage` / `needs_replan` / `ask_user` / `ask_user_questions` / `role_setup`。

---

## Recon Aggregator self-iteration / Recon Aggregator 自迭代 (v0.22.0+)

> **核心改动**：(1) Recon Aggregator 始终运行（无论 single 还是 parallel 模式，统一证据清洁度）；(2) 支持自迭代 + 启发式评分（零额外 LLM 成本）。完整设计见 [roadmap/v0.22.0-role-injection-overhaul.md](roadmap/v0.22.0-role-injection-overhaul.md) P0-4 + P0-9。

| Key | Type | Default | Description |
|---|---|---|---|
| `moa.reconAggregatorMode` | `"default"` \| `"planner"` | `"default"` | Recon Aggregator 角色提示词来源。`default` = 内置静态 prompt；`planner` = 使用 Planner 输出的 `role_setup.recon_aggregator` 覆盖默认。 |
| `moa.reconAggregatorMaxIterations` | number (1-10) | `1` | Recon Aggregator 自迭代上限。**`1` = 单次（默认，不启用评分阈值）**；`>1` 启用启发式评分收敛判断。 |
| `moa.reconAggregatorScoreThreshold` | number (0.0-1.0) | `0.85` | **仅在 `maxIterations > 1` 时生效**。聚合度（aggregation）+ 忠诚度（fidelity）综合分 ≥ 此值则收敛。 |

**评分公式**（启发式，零额外 LLM 调用）：

- `aggregation` = 每个 recon 前 50 字符签名是否出现在 summary 中（signature 覆盖率）
- `fidelity` = 每个 recon 抽取 5 个 4+ 字符关键词（减停用词）后在 summary 中的命中比例
- 长度惩罚：summary > 3× 最长 recon 时扣分

**v3 决策依据**：默认 1 次时**不**启用评分阈值（只跑 1 次无收敛判断可做）；仅当用户主动配置 `maxIterations > 1` 时启用阈值收敛。

---

## Role Setup Preset / 角色设定预设 (v0.22.0+)

> **核心定位**（用户原话）："VSCode 内长出来的个人 MOA 檞寄生" —— 让用户对 LLM 角色身份有完全主权。完整设计见 [docs/moa-role-customization-blueprint-v2.md](moa-role-customization-blueprint-v2.md)。

| Key | Type | Default | Description |
|---|---|---|---|
| `moa.roleSetup.activePreset` | string | `"default"` | 当前激活的 Role Setup Preset 名称。预设列表从 `~/.moa/role-setup-presets.json` 加载（全局持久，跨任务/会话）。 |
| `moa.roleSetup.aiGeneration` | `Object` | `{ enabled: true, autoAccept: false, confirmationUI: true }` | AI 自生成 Role Setup 的采纳控制。`enabled` = Planner 是否允许 LLM 生成预设建议；`autoAccept` = 是否跳过用户确认自动写入；`confirmationUI` = 是否显示确认对话框。 |

**预设存储**：`~/.moa/role-setup-presets.json`（全局，**不**随 workspace 走；首次启动自动创建含 `default` 预设）

**default 预设不可删除**（架构保证至少有一个生效预设）。

**RoleSetupPreset v2 schema**：

```jsonc
{
  "name": "default",
  "description": "内置默认预设",
  "recon": {
    "tone": "faithful-integrator",         // 7 个枚举值之一
    "perspective": "忠实整合多源证据",      // 自由文本，任意语言
    "tool_priority": ["read_file", "grep_search", "list_dir"],
    "cautions": ["避免重复读取同一文件"],
    "focus": ["证据来源标注"]
  },
  "recon_aggregator": { /* 同上结构 */ },
  "actor": { /* 同上结构 */ },
  "few_shot_examples": [                    // 可选，用户自定义 few-shot
    { "input": "...", "role_setup": { /* ... */ } }
  ],
  "meta": { "created_at": "...", "version": "v2" }
}
```

**TonePreset 枚举**（7 个预设值）：

| Tone | 适用场景 |
|---|---|
| `strict-evidence` | 学术研究 / 严格证据驱动 |
| `faithful-integrator` | 默认 recon / recon_aggregator 风格 |
| `neutral-judge` | 默认 aggregator 风格（中立裁判）|
| `strict-executor` | 默认 actor 风格（严格按指令执行）|
| `creative-explorer` | 发散性探索任务 |
| `conservative` | 风险敏感场景（生产代码修改）|
| `aggressive` | 速度优先场景（沙盒实验）|

**8 + 3 命令**（详见 README.md "v0.22 命令" 章节）：

- CRUD：`moa.createRolePreset` / `switchRolePreset` / `editRolePreset` / `deleteRolePreset`
- 分享：`moa.exportRolePreset` / `importRolePreset`（社区分享提前到 v0.22）
- 主权：`moa.toggleAIGeneration`（开/关 AI 自生成）
- 报告：`moa.togglePlanModeReport` / `moa.showPlanModeReport` / `moa.toggleFinalMdInlineDisplay`

**JSON schema 校验失败时**：显示 IDE 风格具体错误 + **保留编辑不强制保存**（类似红线报错），让用户修正后再保存。

---

## Plan Mode Report & final.md inline / Plan 报告与 final.md 内嵌 (v0.22.0+)

> **核心定位**：(1) 借鉴 Copilot Plan Agent 实时报告 plan + role_setup + Planner 状态（**不**报告 token 消耗）；(2) task complete 后把 final.md 关键内容直接内嵌到主会话，让下一轮对话无需工具调用即可获取上下文。

| Key | Type | Default | Description |
|---|---|---|---|
| `moa.planModeReport.enabled` | boolean | `false` | Planner mini-loop 收敛后是否实时弹出 `vscode_askQuestions` 报告 plan + role_setup + 当前状态。 |
| `moa.finalMdInlineDisplay` | `"full"` \| `"summary"` \| `"structured-summary"` \| `"off"` | `"structured-summary"` | task complete 时 final.md 在主会话的展示方式。`off` = 仅显示一句"任务完成，见 .moa_cache/..."。 |
| `moa.finalMdInlineThresholds` | `Object` | `{ "full": 2000, "summary": 8000 }` | 长度阈值（字符数）。final.md < 2000 → `full`；2000-8000 → `summary`（TL;DR + 关键发现 + 行动项）；> 8000 → `structured-summary`（更激进提炼）。 |

**MoaPlanReport schema**（v3 修订：删除 token 估算字段）：

```jsonc
{
  "task_id": "...",
  "iterationsRun": 2,                       // Planner mini-loop 实际迭代次数
  "planCoverageHistory": [0.65, 0.92],      // 每轮 plan_coverage
  "needsReplan": false,                     // 最后一轮是否建议再迭代
  "askUserTriggered": false,                // 是否触发了 ask_user
  "convergedReason": "threshold_met",       // threshold_met | max_iter | ask_user | manual
  "totalElapsedSec": 12.5
}
```

**借鉴 Copilot Plan Agent 但不照搬**：

| Copilot Plan Agent | MoA v0.22 |
|---|---|
| Discovery / Alignment / Design / Refinement 4 阶段 | Planner mini-loop 已涵盖 |
| `searchSubagent` 并行搜索 | 不需要（Recon 才是并行搜索者）|
| `askQuestions` 澄清 | ✅ 借鉴 |
| 必须显示 plan | ✅ 借鉴 |
| handoffs 按钮 | ✅ 借鉴（用户可选"编辑 Role Setup"/"切换 Preset"/"再迭代"）|
| 持久化到 `/memories/session/plan.md` | ❌ MoA 持久化到 `.moa_cache/<task_id>/planner/` |
