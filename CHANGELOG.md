# Change Log

All notable changes to the **vscode-moa** extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.21.0] - 2026-07-21

### Added — I-2 OutputChannel 日志格式增强（用户原话 #8 #9）

**问题**：v0.17.0 引入的 5 个 OutputChannel 粒度不够详细 —— 无时间戳、无 iter 号（只在 chat progress 显示）、无 token 数/模型名/耗时、无任务起止标记。

**修复**：

- 新增 `src/moaLogUtils.ts`：
  - `formatLocalTimestamp()` —— 本地时区时间戳（`YYYY-MM-DD HH:mm:ss.SSS <TZ> (UTC+HH:MM)`），不再用 ISO 8601 UTC
  - `formatLogLine()` —— 结构化前缀 `[ts] [iter N] [role/label] [model: X] event (Ys) details`
  - `formatTaskBoundary()` —— 任务级多行块（started / finalized / crashed）
- 5 个角色 hook 点（Planner / Recon / ReconAggregator / Refs / Aggregator / Actor）每个都输出结构化日志
- 任务 started 边界（createOrchestration 末尾，console 兜底）+ finalized 边界（finalizeTask 末尾，广播到所有已激活 channel）
- 新增 `test/moaLogUtils.test.ts`（14 个测试用例，覆盖各字段组合 + 边界 + 截断）

### Added — IV-1 JSON 文件名 + 内部字段加轮次与项目信息（用户原话 #13 #14）

**问题**：iteration 目录下的 JSON 文件名（`planner.json` / `refs/advisor_1.json` 等）不含轮次/角色/模型信息，复制出来后丢失上下文。

**修复**：

- `saveIterationArtifact()` 新增 `options: { role?, model?, keepLegacy? }` 参数
- 新文件名格式：`iteration_NNN__role__model.json`（如 `iteration_001__refs__advisor_1__DeepSeek-V4-Flash.json`）
- JSON 内部注入 `_meta` 字段：`{ task_id, iter, role, model, saved_at }`
- 7 个调用点全部更新：planner / recon/{label} / recon_aggregator / refs/{label} / aggregator / actor / recon_request
- 默认 `keepLegacy: false`（破坏性变更，旧命名不再生成）

### Added — IV-4 meta.json 自描述 + timeline 阶段耗时

**问题**：`.moa_cache/` 目录缺乏 pipeline 架构自描述 —— 几个月后翻看也看不出这是什么 pipeline、loop 怎么收敛、文件布局如何。timeline.md 也不显示每个阶段的运行时间。

**修复**：

- 新增 `src/moaCore/pipelineArchitecture.ts`：
  - `PIPELINE_ROLES`（6 个角色定义）+ `LOOP_TERMINATION`（max_iter/completeness_threshold/convergence_window/gate_order）+ `FILE_LAYOUT`
  - `buildPipelineArchitecture(settingsSnapshot)` —— 构造完整 pipeline_architecture 对象
- `OrchestrationMeta` 接口新增 `pipeline_architecture` 和 `iteration_timings` 字段
- `renderMetaJson` 注入 pipeline_architecture（含 9 项 settings 快照）+ iteration_timings（每轮每阶段 wall-clock 耗时）
- 新增 `readSettingsSnapshot()` + `buildIterationTimings()` 辅助函数

### Changed — README 瘦身 + 新流程图 + 模型选用指南

**问题**：README.md 膨胀到 460+ 行，新用户难以快速理解；流程图节点标签内的 `[]` 字符被 mermaid 渲染器误解析为节点形状语法，导致图被压缩成一行纯文本。

**修复**：

- README.md 从 460+ 行瘦身到 180 行，README.en.md 同步瘦身到 180 行
- 新增简练中文/英文 mermaid 流程图（角色用英文名，数据流用 📦 显著标注）
- 三根 Recon Aggregator → Refs 连线统一标注 `📦 universal_aggregated_evidence`（用 `==>` 粗线强调同一份统一证据流）
- 新增"模型选用指南"章节：7 种角色（Planner/Recon/Recon Aggregator/Refs/Aggregator/Actor/L3）的推荐模型特性 + 示例
- 详细数据流 + Recon Aggregator → Refs → Aggregator 完整 JSON 结构迁入 `docs/ARCHITECTURE.md`
- 完整配置项参考迁入 `docs/CONFIGURATION.md`
- README 引用两份独立文档，避免主 README 过载

### Fixed — Mermaid 渲染兼容性

- 移除节点标签内的所有 `[]` 字符（`sub_questions[]` → `sub_questions (list)` 等），避免被 mermaid 误解析为节点形状
- 更新过时的渲染说明（VSCode 1.58+ 已内置 mermaid 支持）

## [0.20.4] - 2026-07-21

### Changed — README.md 全面中文化（中文为主，英文为辅）

**问题**：v0.20.3 的 README.md 仅顶部和部分章节中文化，大量核心章节（Install / Usage / Architecture / Configuration reference / Debugging / Build / File layout）仍是英文为主，与"中文版"定位不符。

**修复**：所有章节标题改为"中文 / English"双语格式；所有正文段落翻译为中文（保留代码示例、配置 key、命令名等英文术语不变）：

- `## Install` → `## 安装 / Install`（方式 A/B/C 标题中文化）
- `## First-run configuration` → `## 首次配置 / First-run configuration`（8 步表格全部翻译）
- `## Usage` → `## 用法 / Usage`（含 chat 参与者 + LM 工具两小节）
- `## Architecture` → `## 架构 / Architecture`（5 角色表格 + Recon 防护 + 本地缓存 + Tokenizer 全部翻译）
- `## Configuration reference` → `## 配置参考 / Configuration reference`（Models / Pipeline behavior / Recon tuning 三大表格全部翻译）
- `## Debugging` → `## 调试 / Debugging`
- `## Build & release` → `## 构建与发布 / Build & release`
- `## License` → `## 许可证 / License`
- `## File layout` → `## 文件结构 / File layout`（树形注释全部翻译，新增 safeExecutor.ts / runActor.ts 两项）
- Single-model mode / Why parallel Recon / Closed-loop design 三段翻译为中文
- Actor execution control：去掉重复的英文版（之前是英文 + 中文双份），保留中文版
- Cache & lifecycle 段落：完整翻译为中文（含 cacheTtlDays=0 语义 + 4 种常见模式）

**英文版用户**：请查看 [README.en.md](./README.en.md)。

## [0.20.3] - 2026-07-21

### Fixed — README mermaid 渲染错误 + 双语拆分

- **Mermaid syntax error**: GitHub parser reported `Expecting 'AMP', 'COLON', ... got 'LINK_ID'` on the `CACHE[(.moa_cache/...)]` cylindrical node because `/` in unquoted text was parsed as a link separator. Fix: wrap all node labels containing special chars in double quotes (`["..."]` / `[("...")]`).
- **Mermaid 信息密度增强**: rewrote the 5-role pipeline diagram with explicit per-role I/O annotations (model / input / process / output) and edge labels showing data flow between roles (e.g. `unified_evidence`, `ref JSON`, `action artifacts`). Each role now clearly shows what it produces and who consumes it.
- **VSCode mermaid rendering**: added explicit note at the diagram pointing users to the [Markdown Preview Mermaid Support](https://marketplace.visualstudio.com/items?itemName=bierner.markdown-mermaid) extension, since VSCode's built-in markdown preview does not render mermaid.
- **双语 README 拆分**: split `README.md` (Chinese-primary with English annotations) and new `README.en.md` (English-primary). Cross-linked at the top of each file.

## [0.20.2] - 2026-07-21

### Changed — 全量双语化 + 灵活上限 + cacheTtlDays=0

**i18n** — All 20+ `moa.*` config items now have bilingual (Chinese + English) descriptions in `package.json`:
- Every `description` field: Chinese paragraph followed by `---` separator and English paragraph.
- Every `enumDescriptions` (executionPreset / approvalMode / refDisplayMode): bilingual per option.
- Sub-field descriptions (role / model / systemHint / temperature): bilingual.
- `package.nls.zh-cn.json`: added English sections to 4 previously CN-only keys (enableActorInLoop / safeExecutionMode / cacheTtlDays / cacheRootDir).
- `package.nls.json`: updated cacheTtlDays description to mention v0.20.2 zero-disables semantics.

**Warnings added**:
- `moa.refDisplayMode`: thinking marked as STRONGLY RECOMMENDED; verbose has `⚠️ WARNING — context pollution risk` (refs accumulate in Copilot context window, may confuse aggregator which should read in-memory JSON).
- `moa.forceDirect`: `⚠️ WARNING — bypasses multi-model safety net`, lists 3 capabilities lost (cross-model verification + recon evidence + aggregator synthesis).
- `moa.autoExecuteAfterFinalize` + `moa.approvalMode`: explicit `⚠️ Only effective when executionPreset='custom'` warning.

**Flexible upper limits** (defaults unchanged, only allow larger user overrides):

| Config | v0.20.1 max | v0.20.2 max |
|---|---|---|
| `moa.maxReconRounds` | 10 | **20** |
| `moa.maxReconIterations` | 200 | **500** |
| `moa.reconEarlyStopStagnant` | 10 | **50** |
| `moa.reconEarlyStopSaturated` | 5000 | **50000** |
| `moa.reconL3Threshold` | min 50000 | **min 10000** |
| `moa.reconL3MaxCalls` | 20 | **100** |
| `moa.reconL3TargetChars` | (no max) | **max 500000** |

**New: cacheTtlDays=0 disables cleanup**:
- `minimum: 1 → 0` — `0` means never auto-delete (tasks persist until manually removed).
- `maximum: 365 → 36500` (~100 years, effectively unlimited for archival).
- `src/cacheManager.ts`: added early-return when `ttlDays <= 0` (scans but does not delete).

**README**: new `### Cache & lifecycle` section with cacheTtlDays semantics + common patterns (default 30 days / 0=never / 365=1 year / custom cacheRootDir).

## [0.20.1] - 2026-07-21

### Fixed — activationEvents + Recon 上限 + 中文 i18n

- **`activationEvents` missing `onLanguageModelTool:moa_execute`**: prevented manual `#moa_execute` from activating the extension when it wasn't already active. Fix: added the missing entry to `package.json`.
- **i18n gap**: `package.nls.zh-cn.json` was missing all 3 v0.20.0 keys (executionPreset / autoExecuteAfterFinalize / approvalMode). Fix: added complete Chinese translations with detailed tables + scenario guidance.
- **i18n enrichment**: rewrote English markdown descriptions in `package.nls.json` with detailed tables (preset matrix + Gate-A/Gate-B explanation + recommended workflows). VSCode settings UI now shows rich bilingual content.
- **Recon upper limits raised**:
  - `moa.maxReconRounds` max: 5 → 10 (complex research tasks).
  - `moa.maxReconIterations` max: 100 → 200 (large monorepos / deep research).
- **README**: new `### Actor execution control (v0.20.0+)` section with preset matrix, execution flow diagram, Gate-A/Gate-B explanation, audit/recovery, and bilingual scenario table.

## [0.20.0] - 2026-07-21

### Added — Actor Autopilot + Batch Approval Gate

Major release: Actor role can now auto-execute finalized `action_items` with multi-layer approval gates. Replaces v0.19.x's "finalize returns markdown; main-session manually executes" pattern.

**New: `moa.executionPreset`** (top-level shortcut) — 4+1 modes:

| Preset | Auto-execute after finalize? | Approval gate | SafeExecutor backup |
|---|---|---|---|
| `manual` (default) | ❌ | `batch` (Gate-A QuickPick) | ✅ |
| `supervised` | ✅ | `batch` (Gate-A QuickPick per round) | ✅ |
| `autopilot` | ✅ | `none` | ✅ (only safety net) |
| `yolo` | ✅ | `none` | ❌ (irreversible) |
| `custom` | controlled by fine-grained configs | controlled by `approvalMode` | controlled by `safeExecutionMode` |

**New: `moa.autoExecuteAfterFinalize`** (boolean, default false) — when true, `finalizeTask()` automatically invokes Actor. Only effective when `executionPreset='custom'`.

**New: `moa.approvalMode`** (enum, default `batch`) — controls approval popups for destructive tool calls:
- `none`: no popups (autopilot safety net = backup only)
- `batch`: Gate-A QuickPick multi-select at Actor entry (user can deselect unwanted items)
- `per_call`: Gate-B Yes/No/YesToAll/RejectAll before each destructive tool call
- `batch_plus_per_call`: both gates (most conservative)

**New: `#moa_execute` LM tool** — manual trigger for executing finalized `action_items`. Subject to approval gates. Automatically skipped when `executionPreset='autopilot'` (already runs after finalize).

**New: autopilot.log** — human-readable execution log at `<taskDir>/autopilot.log` with `started_at` / `elapsed_sec` / `tool_calls` / per-action status. Useful for CI logs.

**SafeExecutor enhancements**:
- Added `ApprovalRejectedError` class (source: `gate_a` | `gate_b` | `reject_all`).
- Added `resolveExecutionConfig()` as single source of truth (preset → 3 fine-grained configs).
- Added Gate-A `requestBatchApproval()` (QuickPick multi-select) and Gate-B `requestCallApproval()` (Yes/No/YesToAll/RejectAll).
- `wrapToolCall`: Gate-B intercept between backup & invoke when approvalMode requires it.
- `yesToAllActivated` / `rejectAllActivated` per-task state fields.
- Constructor extended to 4th param `{ approvalMode?, callApprovalImpl?, batchApprovalImpl? }` for test mock injection.
- vscode module lazy `require('vscode')` via `getVscode()` helper to support test environment (avoids top-level resolution).

**Actor entry (runActor.ts)**:
- Gate-A `requestBatchApproval()` filters action_items before execution.
- Gate-A 全拒绝短路 return.
- `rejectedResults: ActorActionResult[]` hoisted above try-block for catch-block lexical visibility.
- Normal return merges `rejectedResults` prepended to executed_actions.

**Roles (roles.ts)**:
- Status type extended: `'success' | 'failed' | 'skipped' | 'partial' | 'rejected_by_user'`.
- ActorActionResult.status extends to `'rejected_by_user'`.

**MoaOrchestrator**:
- New export `executeFinalActions(taskId, actionItems, taskText, token, options?)` — filters executable types (write_file/execute/create_roadmap, skip research_more/inform_user), writes autopilot.log.
- `finalizeTask` 末尾追加 autopilot trigger: when `execConfigFinal.autoExecute && output.action_items.length > 0`, calls `executeFinalActions()`.

**Tests**: new `test/safeExecutor-approval.test.ts` (13 tests covering Gate-A 4 scenarios / Gate-B 4 scenarios / ApprovalRejectedError 2 / wrapToolCall integration 3). Strategy: Module._resolveFilename + Module._load hooks to inject vscode stub before importing safeExecutor.

## [0.19.2] - 2026-07-21

### Fixed — Actor JSON 兜底链路 + per-role 耗时记录

This version hardens the Actor role's recovery path when the LLM doesn't produce structured JSON output, and adds per-role timing breakdown to `meta.json`.

**§1.3 — task_complete 后强制总结** ([src/actingAgent.ts](src/actingAgent.ts)):
- Symptom: Actor LLM frequently calls `task_complete` (or similar) to signal completion, but at that point `finalOutput` may still be empty (LLM put the summary in tool input instead of chat text). Hitting iteration cap then calls `extractActorJson('')` which returns null → `executed_actions=[]`, inconsistent with actual work done.
- Fix: after executing a `task_complete`-class tool call, immediately inject a User message requiring LLM to output structured JSON summary. Next iteration LLM enters the `toolCalls.length === 0` natural-exit branch, `finalOutput` gets populated.
- Pattern match: `/task[_-]?complete|task[_-]?done|^(complete|done|finish)$/i`.

**§1.4 — manifest.json 反构兜底** ([src/moaCore/runActor.ts](src/moaCore/runActor.ts)):
- Symptom: even with §1.3, LLM may still not comply (keeps calling tools or outputs non-JSON). §1.4 is the downstream defense.
- Fix: when `executedActions.length === 0 && params.taskDir`, read SafeExecutor `manifest.json`, filter records matching current iteration, reconstruct `executed_actions` via `manifestRecordToAction()`.
- `self_assessment.reason` annotated as `Recovered from manifest.json (N tool call(s), v0.19.2 §1.4 fallback)` for auditability.

**§5.1 — per-role 耗时记录** ([src/moaOrchestrator.ts](src/moaOrchestrator.ts)):
- Added `OrchestrationMeta.per_role_breakdown`:
  ```json
  {
    "planner": { "rounds": 1, "total_elapsed_sec": 3 },
    "recon": { "rounds": 7, "total_elapsed_sec": 87, "total_tool_calls": 412 },
    "refs": { "rounds": 10, "total_elapsed_sec": 156 },
    "aggregator": { "rounds": 10, "total_elapsed_sec": 45 },
    "actor": { "rounds": 3, "total_elapsed_sec": 67, "actions_executed": 5, "tool_calls": 12 }
  }
  ```
- Added `OrchestrationMeta.model_invocations[]`: per-call `{ iter, role, model, elapsed_sec, tool_calls }`.
- Added `OrchestrationMeta.total_elapsed_sec`.
- `IterationRecord` extended with `*_elapsed_sec` fields (real wall-clock per role).

## [0.19.1] - 2026-07-20

### Added — SafeExecutor 保守执行模式 + 缓存生命周期

Major safety release: introduces SafeExecutor to wrap all Actor side-effecting operations with backup + audit trail.

**New: `moa.safeExecutionMode`** (boolean, default true) — when enabled, Actor's tool calls are wrapped by SafeExecutor:
- `write_file` / `apply_patch` / `insert_edit` / `replace_string`: original file backed up to `<target>.bak.<timestamp>` before execution.
- `delete` / `remove`: file moved to `.moa_cache/<task_id>/_trash/` instead of actually deleting.
- All side-effecting actions logged to `.moa_cache/<task_id>/manifest.json` with `iter` / `seq` / `type` / `target` / `tool_name` / `input_summary` / `status` / `backup_path` / `output_chars` / `timestamp`.
- Iter end: `safeExecutor.flushManifest()` writes accumulated records to disk atomically.

**New: `moa.cacheTtlDays`** (number, default 30) — tasks older than this TTL (in days) will be cleaned up when running the `MoA: Cleanup Old Tasks` command.

**New: `moa.cacheRootDir`** (string, default empty) — override cache root directory. Default empty uses `<workspaceFolder>/.moa_cache/`. Set to absolute path to centralize caches across workspaces.

**New module**: [src/safeExecutor.ts](src/safeExecutor.ts):
- `class SafeExecutor` encapsulates all side-effecting operations.
- Built-in tool whitelist + path safety checks.
- Atomic writes (write to `.tmp`, then rename).
- manifest.json standardization for future audit / rollback features.

**New: [src/cacheManager.ts](src/cacheManager.ts)**:
- TTL cleanup (`cleanupExpiredTasks()`).
- Workspace fingerprinting (task_id prefix = sha1 of workspace path, first 6 chars).
- `MoA: Cleanup Old Tasks` command registered.

## [0.19.0] - 2026-07-20

### Fixed — Actor Layer 2 bug + capturedToolCalls 兜底

**§1.1 — iteration cap 强制 JSON 总结** ([src/actingAgent.ts](src/actingAgent.ts)):
- When hitting iteration cap, inject a User message in the last iteration forcing LLM to output structured JSON summary.
- Without this, hitting cap with empty `finalOutput` produces `executed_actions=[]`.

**§1.2 — capturedToolCalls 兜底** ([src/moaCore/runActor.ts](src/moaCore/runActor.ts)):
- Symptom: Layer 2 bug — when `actingAgent` main loop hits cap, `finalOutput` is empty string, the `result.output` branch is not entered, `executed_actions` remains `[]`.
- Fix: when `result.hitIterationCap && executedActions.length === 0 && result.capturedToolCalls.length > 0`, construct minimal `executed_actions` from `capturedToolCalls` to preserve partial progress.
- `captureToolResults: true` now passed to `runActingAgent` (was false pre-v0.19.0).
- Cost: memory usage increases (all tool result text retained). Benefit: auditable evidence when LLM doesn't output JSON.

**§2 — partial status preservation**: partial executed_actions get `status: 'partial'` with `error_message` indicating iteration cap hit.

---

## [0.18.4] - 2026-07-20

### Fixed — Actor 空跑 + 版本号漂移修复

本次修订基于第一轮 MoA 自审（task `moa_mrswvdj3_14d628`）发现的 4 个核心问题，
以及用户提出的"汇总信息不足、版本号漂移"等反馈。完整修订路线图见
[`docs/roadmap/v0.18.4-actor-fix-and-roadmap.md`](docs/roadmap/v0.18.4-actor-fix-and-roadmap.md)。

#### Fixed P0 — Actor gate 顺序 bug（导致 Actor 永不执行）

- **症状**：MoA loop 跑 10 轮，timeline 表 Actor 列始终为 `0/0`，
  最终由 `shouldStop()` 强制 finalize，Aggregator 的 `actor_needed` 建议
  从未被执行。
- **根因**：[`src/moaOrchestrator.ts`](src/moaOrchestrator.ts) 阶段 5
  Gate 决策的原顺序为 `max_iter → finalize → shouldStop → actor_needed`，
  当 Aggregator 连续 3 轮要求 `actor_needed` 但 completeness 不变时，
  `shouldStop()` 先返回 true，在 Actor 真正执行前就强制收敛。
- **修复**：调整 gate 顺序为
  `max_iter → finalize → actor_needed → shouldStop → recon_needed`，
  确保 Aggregator 要求执行 Actor 时一定先跑完 Actor。
- **影响范围**：[`src/moaOrchestrator.ts`](src/moaOrchestrator.ts) ~10 行注释 + 1 处 gate 位置调整。

#### Fixed P1 — 版本号硬编码（5 处漂移点）

- **症状**：README 显示 v0.18.3，但 chat 进度提示显示 v0.17，
  `Usage` markdown 显示 v0.18.3，`Single-shot` footer 显示 v0.17 — 多处不一致。
- **修复**：在 [`src/extension.ts`](src/extension.ts) 新增
  `EXTENSION_VERSION` 常量，通过
  `vscode.extensions.getExtension('dudali095.moa-bridge')?.packageJSON?.version`
  动态读取 `package.json` 的 version 字段，作为单一真相源。
- **替换点**：`moaHandler.ts` (3 处) + `moaTool.ts` (1 处) + `moaOrchestrator.ts` (1 处)。
- **好处**：以后只需改 `package.json` 一处，所有显示自动同步；CI/CD 友好；
  避免 commit 噪音；分支合并不冲突。

#### Added P2 — 主会话末尾汇总增强（模型清单 + 轮次统计）

- **背景**：原 chat 末尾只显示 task_id + iterations + confidence + 落盘路径，
  缺乏"用了哪些模型、Recon 跑了几次、Actor 触发了几次"等聚合信息。
- **新增**：从 `.moa_cache/<task_id>/meta.json` 读取并展示：
  - 🤖 Refs 模型列表 / Aggregator 模型名
  - 🔁 Recon rounds / Actor rounds 占比
- **失败静默**：meta.json 缺失或损坏不影响主流程。

#### Changed P3 — 用户可见术语统一

- `src/moaOrchestrateTools.ts`: 用户可见的 confirmation message 中
  `workers + aggregator` → `refs + aggregator`（术语与 5 角色架构对齐）。

#### Added P4 — 文字与提示双语化（来自 v0.18.4 第一轮 MoA 自审）

- `package.json`: `displayName` / `description` 启用 `%` NLS 占位符。
- `package.nls.json`: 重写为精简英文，对齐 5 角色架构（"5-role pipeline"）。
- `package.nls.zh-cn.json`: 重写为简明中文
  （"5 角色流水线：规划 → 侦察 → 参考 → 聚合 → 执行"）。
- `README.md`: 开头改为中英双语；徽章改用动态 `github/v/release`。
- 配套脚本：`scripts/clean_pkg.py`（幂等的批量清洗脚本，保留以备后续发版复用）。

### Known Limitations

- **Settings UI 仍是英文**：17 个 `moa.*` 配置项的 `description` 未启用 NLS 占位符
  （需改为 `markdownDescription: "%key%"` 才能本地化）。留待 v0.19.x。
- **源码注释中的历史版本号保留**：如 `// v0.15.0: 改名 Workers→Refs`
  是开发文档价值，正常用户看不到，保留以备维护追溯。
- **CHANGELOG 仍需手工编写**：未实现自动生成（留待长期路线图）。

---

## [0.18.3] - 2026-07-20

### Fixed — 文字与提示一致性修复（基于 MoA 代码审查报告 `moa_mrsslp09_f00a9c`）

本次修订**只改文字与提示，不改运行时行为**。完整修订路线图见 [`docs/roadmap/v0.18.3-consistency-fix.md`](docs/roadmap/v0.18.3-consistency-fix.md)。

#### P0 — Configure Models 步数多重矛盾

v0.18.2 把流程从 5 步扩到 8 步，但只改了 QuickPick header 的 `title:` 字符串，漏改了 package.json 命令描述和 README 散文描述：

| 位置 | 修订前 | 修订后 |
|---|---|---|
| `package.json` `moa.configureModels.description` | `v0.14.14: Five-step flow — (0/4)...(4/4)` | `v0.18.2: Eight-step flow — (0/7)...(7/7)` |
| `package.json` `moa.switchPreset.description` | `refs count + aggregator + recon + L3` | `+ reconAgg + planner + actor` |
| `README.md` "Configuration reference" 段 | `the 5-step guided flow` | `the 8-step guided flow` |
| `README.md` 文件布局注释 | `Configure Models 5-step flow` | `8-step flow` |
| `src/moaConfig.ts` L292 注释 | `v0.14.14 Step 0/4` | `v0.18.2 Step 0/7` |
| `src/moaConfig.ts` L379 注释 | `Step 2/4: aggregator` | `Step 2/7: aggregator` |

#### P1 — 配置项默认值与功能语义系统性偏差

README 表格的默认值从 v0.14.4/v0.14.5 起就过时了（实际代码早已调大，README 没同步）：

| 配置项 | README 标注（修订前） | 实际值（package.json + 代码） | 修订后 README |
|---|---|---|---|
| `moa.reconL3Threshold` | `30000` | `200000` (6.7×) | `200000` |
| `moa.reconContextChars` | `30000` (Character budget) | `500000` (DEPRECATED) | `500000` + 标注 DEPRECATED + 解释原因 |
| L3 输出目标字符数（散文） | `~5k chars` | `DEFAULT_TARGET_CHARS = 50000` (10×) | `~50k chars` |
| L3 Summarizer 表格行 | `>30K chars to ~5K chars` | `>200K to ~50K` | 修正 |

同时新增 `moa.reconL3TargetChars` 表格行（之前完全漏写）。

#### P2 — 路线图文档状态滞后

`docs/roadmap/v0.15.0-closed-loop-moa.md` 头部仍标注 "状态：设计草案，尚未开始实施"，但 §15 已记录 v0.15.0 完整实施 + hotfix 1/2。修订：

- 头部状态改为 `✅ 已实施（v0.15.0 + hotfix 1/2，详见 §15）`
- §1.1/§1.2/§2 的"关键缺陷"段落下追加 `✅ 已修复` 注释（保留原设计脉络）
- §10 文档更新清单全部 `[ ]` → `[x]`

#### P3 — 帮助提示版本号滞后

`src/moaHandler.ts` `buildHelpMarkdown()` 硬编码 `Usage (v0.17.0)` → 修订为 `Usage (v0.18.3)`。

#### P4 — NLS 本地化文件严重过时

`package.nls.json` / `package.nls.zh-cn.json` 含早期草稿遗留的完全不对应字段（`configuration.defaultPreset` / `configuration.presetsDir` / `configuration.timeoutSec` 等都不存在于实际 package.json）。修订：清空为最小骨架（仅保留 `extension.displayName` / `extension.description`），消除"未来按 NLS 添加 % 引用会显示错误字段"的陷阱。

**影响**：package.json 当前未用 `%key%` 语法引用 NLS，所以清空不影响实际 UI。

### Added — 新增修订路线图文档

新增 [`docs/roadmap/v0.18.3-consistency-fix.md`](docs/roadmap/v0.18.3-consistency-fix.md)，记录本次修订的完整问题清单（5 类）、修复计划（5 phase）、不做什么（out-of-scope）、验收标准。

## [0.18.2] - 2026-07-20

### Fixed — Configure Models 数据丢失 bug（严重）

**问题**：v0.15.0/v0.18.0 在 `MoaPreset` 类型上加了 4 个新字段（`planner` / `actor` / `reconModels` / `reconAggregator`），但 `configureModels()` 的 `presetToSave` 只写其中 6 个字段（`refModels` / `aggregator` / `reconModel` / `l3Summarizer` / `description` / `createdAt`）。

**真实影响**：用户按 README 示例在 `settings.json` 手动配置了这 4 个字段后，如果通过 Configure Models 编辑该 preset（哪怕只是改一个 ref），保存后这 4 个字段被静默清空。

**修复**：`presetToSave` 现在保留全部 8 个字段。`reconModel`（单数）仍写入以兼容老读取代码（取 `reconModels[0]`）。

### Added — Configure Models 扩展到 8 步流程，全部角色暴露 UI

v0.14.0 引入的 5 步流程只覆盖 4 个字段。v0.15.0/v0.18.0 又新增了 4 个角色但没暴露 UI，用户必须手编 `settings.json`。v0.18.2 把流程扩展到 8 步，全部 7 个角色 + L3 都有 UI 入口：

| Step | 角色 | UI | 新增/原 |
|---|---|---|---|
| 0/7 | Preset group | single-select | 原 |
| 1/7 | Refs | multi-select | 原 |
| 2/7 | Aggregator | single-select | 原 |
| 3/7 | **Recon Agents**（多选，支持并行） | **multi-select** | **改：原单选 → 多选** |
| 4/7 | **Recon Aggregator** | single-select | **新增** |
| 5/7 | **Planner** | single-select | **新增** |
| 6/7 | **Actor** | single-select | **新增** |
| 7/7 | L3 Summarizer | single-select | 原（Step 4/4 → 7/7） |

**Step 3/7 Recon 改多选的语义**：

- 勾选 "Use aggregator" sentinel（不勾具体模型）= 单模型 fallback 到 aggregator（v0.13.x 行为）
- 勾 1 个具体模型 = 单模型模式（Recon Aggregator 仍跑，做标准化）
- 勾 2+ 个具体模型 = 并行模式（受 `moa.parallelRecon` 控制）
- sentinel + 具体模型不能共存（互斥校验，违反时弹 warning 并中止保存）

**Step 4/5/6/7 新角色的 sentinel 设计**：每个新角色顶部都有 "Use aggregator" / "Disable" sentinel 项，作为新 preset 的推荐默认。用户首次配置时不会看到具体模型被预勾选——只有 "Use aggregator" 被预勾选（与 v0.18.1 的"首次配置不应预选具体模型"原则一致）。

**数据源兼容**：Step 3 的预勾选逻辑同时读 `seed.reconModels`（数组，v0.18.0）和 `seed.reconModel`（单数，v0.14.x），向后兼容。

### Changed — 完成消息扩展到 8 字段

Configure Models 保存成功后的 InformationMessage 现在显示全部角色：

```
MoA configured: preset=default (active), 4 ref(s), aggregator=GLM-5.2, recon=2 models (DeepSeek-V4-Pro + MiniMax-M3), reconAgg=(= aggregator), planner=(= aggregator), actor=(= aggregator), L3=(disabled). Saved to User + Workspace.
```

### Changed — README "5 roles" 表格补 UI step 列

README 的角色表格新增 "UI step" 列，明确标出每个角色的配置入口。同时加入 L3 Summarizer 行（之前漏写）。

## [0.18.1] - 2026-07-20

### Fixed — Configure Models 不再在首次配置时预勾选具体模型

**问题**：v0.14.0 引入的 5 步 Configure Models 流程中，有两处在用户新建 preset 或未配置某层时**主动预勾选具体模型**，违反"首次选用不应默认选上"原则：

| 步骤 | 原行为（≤ v0.18.0） | 修正后（v0.18.1） |
|---|---|---|
| **Step 2/4 Aggregator** | 未配置时 `aggDefaultIdx = 0` → 预勾选列表第一个模型；或预勾选第一个 selected ref | 仅按现有配置预勾选；未配置时全部 `picked: false`（强制用户主动选） |
| **Step 4/4 L3 Summarizer** | 未配置时 `/MiniMax\.*M3/i` 主动查找 MiniMax-M3 并预勾选 | 未配置时默认勾 "Disable L3"（安全默认；不主动推任何具体模型） |

**动机**：用户在首次配置时不应该发现"某个模型已经被选上了"。这会让人困惑（这个模型是哪里来的？为什么被选？），也可能被误以为是官方推荐而直接接受。修正后，**只有用户显式选择的模型才会被保存**。

**兼容性**：已配置的 preset 不受影响——按现有配置预勾选的行为完全保留。仅"未配置"路径变化。

**交互兜底**：`singlePickWithCheckbox` 在无预勾选时会显示"请选择一个"提示并禁用确认按钮（用户点击任一项即激活），不会被卡住。

### Changed — L3 "Disable" 选项的描述更清晰

- 原 detail：`Choose this if you have no MiniMax-M3 or want simpler behavior`
- 新 detail：`Default for new presets — pick a model below if you want L3 condensation`

新描述明确告知"这是新 preset 的默认"，避免用户以为是某种 fallback。

## [0.18.0] - 2026-07-20

### Added — Parallel multi-model Recon + Recon Aggregator (Plan B: always aggregate)

v0.17 redesigned the Recon role around a single acting-style agent. v0.18 extends it to **fan out N Recon agents in parallel**, each driven by a different LLM, then **always integrates** them through a new Recon Aggregator role.

#### Pipeline (v0.18.0)

```
Planner (iter 1 only)
   │  sub_questions + recon_hints
   ▼
Recon agent(s) ── 1 or N parallel ──┐
                                    │
                                    ▼
                       Recon Aggregator (always runs)
                                    │ merged summary (single source of truth)
                                    ▼
                       N Refs (parallel) → Aggregator → Actor
```

#### Why parallel Recon

Different LLMs exhibit **different tool preferences** and **different search strategies** when given the same Recon task. Running them in parallel and merging captures broader coverage:

- One model might prefer `fetch_webpage` for API docs, another might prefer `grep_search` for code symbols
- One might follow Planner's `recon_hints` literally, another might deviate productively
- Failures (rate limit, 1213 errors) from one model no longer tank the whole Recon phase — siblings compensate

#### New config

- **`moa.parallelRecon`** (boolean, default `true`) — When `preset.reconModels` has ≥2 entries, all fire concurrently. Wall-clock = slowest. When `false` (or only 1 model), runs sequentially.
- **`preset.reconModels: ReconConfig[]`** — Array of Recon models for parallel fan-out. Falls back to `[reconModel]` for backward compat.
- **`preset.reconAggregator: ReconConfig`** — The integration model. Falls back to the main aggregator when unset.

Example `settings.json`:

```jsonc
"moa.presets": {
  "default": {
    "refModels":     [{ "model": "..." }, { "model": "..." }],
    "aggregator":    { "model": "gcmp.zhipu:::GLM-5.2-CodingPlan" },
    "reconModels": [
      { "model": "gcmp.deepseek:::DeepSeek-V4-Pro" },
      { "model": "gcmp.minimax:::MiniMax-M3-Token-Plan" }
    ],
    "reconAggregator": { "model": "gcmp.zhipu:::GLM-5.2-CodingPlan" }
  }
}
```

#### Plan B — Aggregator always runs (architectural decision)

The Recon Aggregator runs **even in single-model mode**. This is deliberate:

| Mode | What Aggregator does |
|---|---|
| `parallel` (≥2 models) | Dedupe + integrate + label sources (`[from recon_1]`) + flag conflicts |
| `single` (1 model) | Normalize raw output, strip noise, enforce consistent format |

Downstream Refs see the **same shape** regardless of upstream model count. There is no `if single/parallel` branch in `moaOrchestrator.ts` — one code path.

#### Recon Aggregator is an agent, not a pure LLM call

It uses `runActingAgent` with **full tools but constrained use**:

- ✅ Reading files / URLs that Recon already cited (for verification of conflicting claims)
- ✅ Writing merged summary to `.moa_cache/<task_id>/iteration_NNN/recon_merged.md` for audit
- ❌ New web search, exploratory grep, fetch uncited URLs (that's Recon's job)
- ❌ Modifying user source files (read-only on user sources)
- ❌ Filling gaps (gap-filling is next iteration's Recon's job)

The constraint is enforced via prompt, not capability restriction — Aggregator can call any tool but the prompt instructs it to use them only for verification, not exploration.

#### File layout changes

`.moa_cache/<task_id>/iteration_NNN/` now contains:

- `recon_result.json` — **always written**, contains Aggregator-merged summary + `recon_mode` + `aggregator_model` + `parallel_sources[]` metadata
- `recon/recon_N.json` — only in parallel mode, one file per parallel Recon agent (raw summary + tool_calls + error)

Old single `recon_result.json` shape (pre-v0.18) is forward-compatible: readers see an enriched object with new optional fields.

### Changed — Recon prompt redesign (carried from v0.17.0)

`buildReconPrompt` was rewritten in v0.17 to make Recon **aggressive** about:

1. **Planner priority**: Planner's `sub_questions` are now marked `⭐ 必须回答的子问题` (was `仅供参考`) — Recon must answer them or report a gap
2. **Tool diversity**: Prompt suggests `fetch_webpage` / `grep_search` / `list_dir` / `view_image` based on question type, not just `read_file`
3. **Web search strategy**: Explicit instructions for when to invoke web search (API docs, recent changes, external context)
4. **Difficulty-based tool budget**: Research/complex questions → 8-15 tool calls; narrow code questions → 1-3 calls

v0.18 inherits this and applies it uniformly across all parallel Recon agents.

### Files

- **NEW** `src/moaCore/runRecon.ts` (~600 LOC): `callRecon` Plan B pipeline, `resolveAllReconModels`, `resolveReconAggregatorModel`, `buildReconAggregatorPrompt`, `callReconAggregator` (uses `runActingAgent`), `runSingleRecon` (extracted helper). Exports `CallReconResult` interface.
- `src/types.ts`: `MoaPreset.reconModels?: ReconConfig[]` + `MoaPreset.reconAggregator?: ReconConfig` added.
- `src/presetConfig.ts`: `resolveReconModels()` returns array; `ResolvedPresetConfig` extended with `reconModels` + `reconAggregator` fields; all 3 cases (explicit / fallback / legacy) populate new fields.
- `src/moaCore/roles.ts`: `buildReconPrompt` redesigned (Planner priority, tool diversity, web search strategy).
- `src/actingAgent.ts`: `runReconAgent()` gained 7th parameter `customSystemPrompt?: string` — when provided, overrides `buildReconSystemPrompt`. Fixes a v0.17 regression where `callReconAggregator`'s merged system+user prompt was overwritten by the default system prompt.
- `src/moaOrchestrator.ts`: call site for `callRecon` simplified (no single/parallel branch for result vs merged — both go through `callResult.merged`); writes `recon_result.json` with enriched metadata; writes `recon/<label>.json` only in parallel mode.
- `src/cacheReadme.ts`: bumped template version 1 → 2; directory tree updated with `iteration_NNN/recon/` + `recon_result.json` + `planner.json` + `actor_result.json`; added "Diagnosing #moa_orchestrate iterations" section; added `moa.parallelRecon` row in config table.
- `package.json`: version 0.18.0; added `moa.parallelRecon` setting (default `true`, order 20).
- `src/moaTool.ts`: `moa_collectFiles` → `moa_recon` references (2 places); version string 0.17 → 0.18 in user-facing strings.
- `src/moaHandler.ts`: footer mentions 5 OutputChannels.

## [0.17.0] - 2026-07-20

### BREAKING — worker → ref terminology normalization

The v0.14.x codebase called parallel multi-model advisors "workers"; v0.15.0 renamed them to "refs" but kept `worker_outputs` / `worker_models` / `worker_errors` as aliases for backward compat. v0.17.0 removes all alias fields:

- `IterationRecord.worker_outputs` field: **removed** (use `ref_outputs`)
- `OrchestrationMeta.worker_models` field: **removed** (use `ref_models`)
- `completeness_timeline[].worker_errors` field: **removed** (use `ref_errors`)
- `resolveRefModels()` return value: no longer includes `workers` alias
- meta.json: read-time migration (old `worker_models` → `ref_models` automatically on first read; next overwrite normalizes)

Old `.moa_cache/<task_id>/meta.json` files from v0.16.x will be auto-migrated on read; no manual action needed.

### Added — 5 independent OutputChannels for pipeline visibility

The full 5-role pipeline (Planner / Recon / Refs / Aggregator / Actor) now writes intermediate output to **5 separate VSCode OutputChannels**, visible in `View → Output` dropdown (same level as `MoA Bridge Diag`):

| Channel | Contents |
|---|---|
| `MoA Planner` | Planner JSON output (iter 1 only) |
| `MoA Recon` | Recon summary + tool_calls count + elapsed + early_stop reason |
| `MoA Refs` | Each ref's raw LLM output (failed refs also logged) |
| `MoA Aggregator` | Aggregator raw + parsed JSON + finalizer output + iteration summary (completeness / next_action / convergence) |
| `MoA Actor` | Each action_item's status + artifacts + self_assessment |

Each channel includes iteration boundary headers (═══════) so users can scroll through multi-iteration runs without losing track.

### Removed — dead code (3 unused prompt builder functions)

Deleted three legacy prompt builders that had **zero call sites** since v0.15.0 (replaced by params-object-signature versions):

- `buildWorkerPrompt(task, state, label)` — replaced by `buildRefPrompt({task, iteration, ...})`
- `buildAggregatorPrompt(task, state, workerOutputs)` — replaced by `buildAggregatorPromptV2({task, iteration, refOutputs, ...})`
- `buildFinalPrompt(task, state)` — replaced by `moaCore.buildFinalPrompt({task, synthesis, evidence, ...})`

These dead functions were the last source of deprecated terms (`worker`, `need_more_analysis`) in the codebase. Removing them cleans up search results and reduces maintenance surface.

### Fixed — `moa_collectFiles` reference pointed to non-existent tool

`moaTool.ts` had two `Tip:` blocks suggesting users call `moa_collectFiles` — a tool that doesn't exist. Fixed to point to the real `moa_recon` tool instead.

### Changed — chat output now mentions Output channels

`@moa` / `@moaloop` / `@moasingle` chat responses and `#moa_analyze` tool results now include a footer pointing users to the 5 Output channels for intermediate pipeline visibility.

## [0.15.1] - 2026-07-20

### Fixed — hotfix 1: Actor evidence extraction crash on missing `action.content`

**Symptom**: `moa_continue` failed with `Iteration failed: Cannot read properties of undefined (reading 'length')` after Actor completed. Result: `iteration_002/` files (Recon/Refs/Aggregator/Actor) were correctly written, but `state.history.push(record)` was never reached → `state.json` stayed at iteration 1 → `timeline.md` only showed iteration 1.

**Root cause**: Actor LLM frequently omits the `action.content` field in its JSON response (only returns `type`/`target`/`rationale`). The original evidence extraction loop accessed `ar.action.content.length` directly, throwing a TypeError.

**Fix**: Extract evidence logic into pure function [`buildActorEvidence`](src/moaCore/actorEvidence.ts) with defensive access (`ar.action?.content` + `typeof` check). When `content` is missing, fallback to constructing the snippet from `artifacts` + `output_chars` + `rationale`.

**Test coverage**: `test/hotfix.test.ts` (8 cases including the real-world crashing data shape from 2026-07-19). Run with `npm test`.

### Fixed — hotfix 2: `final.md`/`final.json` missing on auto-finalize

**Symptom**: When `runIteration` auto-finalized (Aggregator says `finalize` / `MAX_ITER` / `shouldStop`), it set `state.status = 'finalized'` but did NOT call `finalizeTask`. The user would see `finalized` status but `final.md` was missing — they had to manually call `#moa_finalize` to produce it.

**Fix**: At the end of `runIteration`, if `state.status === 'finalized'`, automatically invoke `finalizeTask(taskId, token)` to produce `final.md` + `final.json` + re-render meta/timeline. Failure is non-fatal (logged via `progress?.`, does not block the return).

### Changed — test infrastructure

- Added `tsx` devDependency and `npm test` script
- New `test/` directory for regression tests (excluded from webpack bundle)

## [0.15.0] - 2026-07-20

### Added — 5-role closed-loop MoA orchestration

`moa_orchestrate` now runs a full Planner → Recon → Refs → Aggregator → Actor closed loop across iterations. The five roles are explicit:

| Role | When | Purpose |
|---|---|---|
| **Planner** | iter 1 only | Clarifies task, generates `sub_questions` + `recon_hints` for Recon |
| **Recon** | every iter | Read-only acting agent, gathers evidence with tool calls |
| **Refs** | every iter | N LLM advisors in parallel (multi-perspective analysis) |
| **Aggregator** | every iter | Single gate — decides `finalize` / `actor_needed` / `recon_needed` |
| **Actor** | on `actor_needed` | Full-tool acting agent, executes `action_items` and produces artifacts |

Actor outputs feed back into `state.evidence` (high confidence) and are evaluated by the next iteration's Refs naturally. The loop terminates on Aggregator's `finalize` decision or MAX_ITER (12).

**Timeline 9-column view** (`timeline.md`): `| Iter | Time | Compl. | Δ | Gaps | Recon Tools | Refs OK | Actor | Next |` — at-a-glance view of the full iteration history.

## [0.14.14] - 2026-07-19

### Added — Preset groups + true parallel ref fan-out

Two long-requested features in one release. Both are fully backward-compatible: existing v0.14.13 configs continue to work and are auto-migrated on first use.

#### 1. Preset groups (`moa.presets` + `moa.activePreset`)

You can now save **multiple full-pipeline configurations** as named presets and switch between them with one click. Each preset bundles refs + aggregator + recon + L3 — switching a preset swaps the entire pipeline.

**New settings**:
- `moa.presets` (object): Map of `{ name → { refModels, aggregator, reconModel, l3Summarizer, description? } }`.
- `moa.activePreset` (string): Key into `moa.presets` identifying the currently active group.

**New commands**:
- `MoA: Switch Preset` — QuickPick showing all saved presets with a one-line preview (`4 refs · agg=GLM-5.2 · recon=DeepSeek · L3=MiniMax-M3`). One-click switch, no re-configuration needed.
- `MoA: Configure Models` (updated) — Now opens with a new **Step 0/4** to pick / create / delete a preset group before editing. Steps 1-4 then edit the selected preset's refs/aggregator/recon/L3.

**Backward compatibility**:
- Legacy flat config (`moa.refModels` + `moa.aggregator` + `moa.reconModel` + `moa.l3Summarizer`) is **auto-migrated** to `presets.default` on extension activation (idempotent — only runs if `moa.presets` is empty AND legacy config has refs).
- Migration shows a one-time info notification: *"Your existing model configuration was migrated to the 'default' preset group."*
- Legacy fields are NOT deleted — they serve as read-only fallback if `moa.presets` ever gets corrupted.
- Runtime reads go through a new single-source-of-truth function `getActivePresetConfig()` (in `presetConfig.ts`), used by both `moaRunner.ts` and `moaOrchestrator.ts` to keep them in sync.

**Typical usage**:
- `"code"` preset: 4 refs + GLM aggregator + DeepSeek recon + MiniMax L3
- `"research"` preset: 6 refs + MiniMax aggregator + GLM recon + L3 disabled
- `"quick"` preset: 2 refs + GLM aggregator (no recon, no L3)

Switch between them via `MoA: Switch Preset` based on the task at hand.

#### 2. Real parallel ref fan-out (`moa.parallelRefs`)

**Bug**: The `moa.parallelRefs` setting has existed since early v0.7.x and was documented as *"Fan out reference advisors in parallel"*, but **the code never read it** — refs always ran sequentially (`for (const ref of probePool) { await ref.model.sendRequest(...) }`). Setting `parallelRefs: true` had no effect.

**Fix**: Extracted the ref execution into a new helper `runSingleRef()` (atomic unit, never throws — errors captured into `{ ok: false, error }`), and the ref prompt body into `buildRefPromptBody()` (built once, shared by all refs since they're equal-mode). The Phase 1 loop now has two branches:

- **`parallelRefs: true` (new default)** — `Promise.allSettled(tasks.map(runSingleRef))`. All ref requests fire simultaneously; wall-clock time = slowest ref. N refs → theoretical N× speedup. Individual ref failures don't affect siblings.
- **`parallelRefs: false`** — sequential `for-await` (legacy behavior). Use this if your provider rate-limits concurrent requests.

**Default change**: `moa.parallelRefs` default flipped from `false` → `true`. If you experience cascading 429/5xx errors from your provider, set it back to `false`.

### Changed
- `moaRunner.ts` — Ref configuration now reads from `getActivePresetConfig()` instead of direct `config.get('refModels')`. Aggregator, recon, and L3 config reads similarly migrated.
- `moaOrchestrator.ts` — Worker/aggregator resolution goes through `getActivePresetConfig()` (same single-source-of-truth as `moaRunner.ts`).
- `l3Summarizer.ts` — L3 model ID resolution goes through `getActivePresetConfig()` when `opts.modelId` is not provided.
- `extension.ts` — Registers new `moa.switchPreset` command; calls `migrateLegacyToPreset()` on activation (fire-and-forget).

### Files
- **NEW** `src/presetConfig.ts` (~400 LOC): `MoaPreset` lifecycle — `getActivePresetConfig()`, `migrateLegacyToPreset()`, `savePreset()`, `deletePreset()`, `setActivePreset()`, `listPresets()`.
- **NEW** `src/types.ts`: `MoaPreset` interface added.
- `src/moaRunner.ts`: `runSingleRef()` + `buildRefPromptBody()` helpers; parallel/serial Phase 1 branches; preset reads.
- `src/moaConfig.ts`: `pickOrCreatePreset()` Step 0 UI; `switchPreset()` command; `askMakeActive()` helper; `shortModelName()` helper.
- `src/moaOrchestrator.ts`: `resolveModels()` uses `getActivePresetConfig()`.
- `src/l3Summarizer.ts`: `l3Summarize()` uses `getActivePresetConfig()` for default model ID.
- `src/extension.ts`: registers `moa.switchPreset`; auto-migration on activate.
- `package.json`: version bump; new `moa.presets` / `moa.activePreset` settings; new `moa.switchPreset` command; `moa.parallelRefs` default `false → true`.

---

## [0.14.13] - 2026-07-19

### Changed — README rewrite: clear loop shapes + roadmap

User feedback: the original `What it does` flow diagram suggested a one-shot linear pipeline, hiding the existing loop mechanisms and giving no signal about the planned closed-loop direction. Rewrote to make the actual behavior explicit.

- **`@moa` chat participant path** — now clearly shows the `sufficiencyLoop` spans Phase 0 ↔ Phase 1 ↔ Phase 1.5 (the original diagram put the loop arrow inside Phase 1, which was misleading). Explicitly notes that **no feedback paths exist after Phase 3** in the current implementation.
- **`#moa_orchestrate` tool path** — documented as a separate entry point with a full Hermes iteration loop (`MAX_ITER=12`, `completeness ≥ 0.8` convergence, `next_action: recon_needed | need_more_analysis | finalize`).
- **New Roadmap section** — sketches the v0.15.0+ design goal of fully LLM-driven closed-loop control: acting agent can request more recon via dual-channel signaling (`moa_request_more_recon` LM tool + `<MOA_STATUS>` structured output), default mode is LLM-judged (simple questions converge in 1 loop, complex ones run 3-5), with hard budget/iteration guarantees to prevent runaway.

### Added
- Marketplace badge in README header.
- Install section now lists Marketplace as Option A (recommended); GitHub Release moved to Option B; source build is Option C.
- Release badge updated to v0.14.12.

---

## [0.14.12] - 2026-07-19

### Fixed — Relative path resolution in recon/acting agent tool calls

**Symptom**: recon agent calling `copilot_readFile` with a relative path like `GSEAlens/man/build_gsea_pathways.Rd` failed uniformly with ENOENT, the error revealing that the path was being resolved against `D:\Users\Administrator\AppData\Local\Programs\Microsoft VS Code\` (the VSCode executable directory) instead of the workspace root.

**Root cause**: VSCode's `copilot_*` built-in tools resolve relative paths via `process.cwd()`, which for an extension host process is the VSCode executable directory — NOT the workspace root. The LLM has no way to know this and routinely emits relative paths like `src/foo.ts` or `GSEAlens/man/foo.Rd`.

**Fix** — two layers of defense:

1. **Tool-input normalization layer** (`actingAgent.ts`, new `normalizeToolInput()` + `resolveRelativeToWorkspace()` + `isAbsolutePath()` helpers, ~100 LOC):
   - Intercepts every `invokeTool` call BEFORE dispatch
   - For tools with path-like input fields (`filePath`, `path`, `file`, `includePattern`, `folder`, `query`, `pattern`, etc. — 10 fields covered):
     - Absolute paths: pass through unchanged
     - Relative paths: resolve against a smartly-chosen workspace folder
   - **Multi-workspace smart matching**:
     - If the path's first segment matches a workspace folder name (case-insensitive), resolve against THAT folder. E.g. `GSEAlens/man/foo.Rd` with a workspace folder named `GSEAlens` → `<workspaceRoot>/GSEAlens/man/foo.Rd`
     - Otherwise, fall back to the first workspace folder
   - Skips glob patterns (`*`, `?`, `[`, `]`) — only pure paths get rewritten
   - Emits a progress log entry whenever a path is rewritten: `[MoA] recon path normalization: filePath: "X" → "Y"`
   - The normalized input is also written back to `call.input` so `capturedToolCalls` records the resolved path (better audit trail)

2. **Recon system prompt update**: added a "Path handling (v0.14.12+)" section encouraging the LLM to prefer absolute paths and explaining the multi-workspace matching behavior. Defense in depth — even if normalization somehow misses a case, the LLM is now aware.

**Why this matters**: without this fix, recon against any multi-folder workspace (very common for users who open several related projects) is effectively broken — the LLM has no signal that paths are wrong until ENOENT errors pile up, and even then it can't easily discover the correct absolute prefix.

### Changed
- `normalizeToolInput` is applied uniformly to both recon (read-only) and acting (full tool) modes — relative-path bugs bite both.

---

## [0.14.11] - 2026-07-19

### Changed — Marketplace publish
- **Publisher changed `moa-bridge` → `dudali095`** (official VSCode Marketplace publisher ID). First version published to the public Marketplace; all prior versions (v0.10.0 - v0.14.10) were GitHub Release only.
- Functional code identical to v0.14.10 — no behavior changes. The bump is required because Marketplace requires unique `<publisher>.<name>` identifiers, and the previous placeholder publisher could not be used.

### How users install
- **From Marketplace (recommended)**: search "MoA Bridge" in VSCode Extensions panel, or `code --install-extension dudali095.moa-bridge`
- **From GitHub Release**: download `moa-bridge-0.14.11.vsix` from https://github.com/DDL095/vscode-moa/releases, then `code --install-extension moa-bridge-0.14.11.vsix`

---

## [0.14.10] - 2026-07-19

### Added — `.moa_cache/` discoverability & open-source friendliness

As a plugin that writes into the user's workspace, MoA now makes those writes **self-documenting** at the point of impact. Users no longer have to read the project README to figure out what `.moa_cache/` is, whether it's safe to delete, or how to diagnose problems from the artifacts.

- **`src/cacheReadme.ts`** (new module, ~200 LOC): exports `ensureCacheReadme(cacheRoot)` and `buildCacheReadmeContent()`. Idempotent — writes only on first cache creation; never overwrites a user-modified README. Atomic write (tmp + rename) so concurrent reads never see a half-written file. Failures degrade silently to `console.warn` (never blocks the MoA pipeline).
- **Three-point integration**: every code path that creates `.moa_cache/` now calls `ensureCacheReadme()`:
  - `l3Summarizer.ts::getCacheDir()` — first L3 cache miss
  - `moaOrchestrator.ts::getCacheRoot()` — first `#moa_orchestrate` invocation
  - `moaRunner.ts::getReconDumpDir()` — first `@moa` recon dump
- **Auto-generated README content** (`Cache README v1`) covers:
  - *What this is* — intermediate artifacts, safe to delete, will regenerate
  - *Directory layout* — tree with one-line purpose per subdir (recon/ l3_summaries/ `<task_id>/`)
  - *Diagnostics* — how to find why an `@moa` output came out the way it did; how to identify 1213 errors from `Part Diagnostics` tables
  - *Cleanup* — whole-directory delete, per-subdir delete table, how to extract useful content (e.g. copy a ref's analysis out) before deleting
  - *.gitignore suggestion* — recommended entry + force-add escape hatch for tutorial authors
  - *Configuration* — table of every `moa.*` setting that influences cache write behavior
  - *Privacy* — local-only writes; what flows to LLM providers
  - Bilingual (Chinese-primary, English key terms) — matches the project's existing comment style and reaches a wider audience

### Changed
- **Main `README.md`**: added "Local cache & workspace artifacts (v0.14.10+)" section with directory layout, `.gitignore` recommendation, and pointer to the auto-generated cache README. Updated Debugging section to reference it. File-layout diagram now lists `cacheReadme.ts`.

### Motivation
Open-source plugins that silently write into the user's workspace without leaving an in-place explanation force users to: (a) notice the directory exists, (b) search upstream docs, (c) guess whether it's safe to delete. This change closes that loop at the point of impact — the README lives *inside* `.moa_cache/` and is rewritten only when absent.

---

## [0.14.9] - 2026-07-19

### Changed — Revert maxOutputTokens in favor of agent-judgment prompt
- **Reverted v0.14.8's explicit `maxOutputTokens` setting** on ref/aggregator `sendRequest` calls. The explicit setting risked provider-compatibility issues (some providers reject unknown options, some silently cap, behavior varies). Reverted to `sendRequest(prompts, {}, token)` (empty options).
- **Ref prompt** (`moaRunner.ts`): replaced hardcoded "ANALYSIS DEPTH REQUIREMENT" (2500-5000 words) with a new `=== OUTPUT DEPTH (agent judgment) ===` block. Teaches the LLM to self-calibrate based on question type:
  - RESEARCH/LITERATURE questions → COMPREHENSIVE analysis (proportional to recon data richness)
  - NARROW CODE questions → CONCISE and surgical
  - Explicit anti-patterns (one-paragraph summaries when recon has 5+ aspects; hand-waving instead of naming specific genes/numbers; etc.)
- **Aggregator prompt**: matching `=== OUTPUT DEPTH (agent judgment) ===` block — preserve refs' richness, don't over-summarize, address disagreements explicitly.
- This approach is **provider-agnostic** (works the same across GLM/DeepSeek/MiniMax/Claude) and lets the LLM judge depth per-question rather than applying a one-size-fits-all token limit.

---

## [0.14.8] - 2026-07-19 [YANKED]

### Changed — Explicit maxOutputTokens (reverted in v0.14.9)
- Set explicit `maxOutputTokens` on ref/aggregator `sendRequest` to match each model's declared max (e.g. GLM-5.2 = 128000). Goal: fix observed asymmetry where refs consumed 90K+ input chars but produced only 1.7K-5.3K output chars.
- **Reverted by user direction** in v0.14.9: "maxOutputTokens 显式设置我觉得不好，还是在 prompt 里 agent 化，让 LLM 更好的输出会更好，也能避免太冗余的内容，不要让这个内容与硬性设置影响到其他模型的输出，影响我做的插件的兼容性." Replaced with prompt-based agent-judgment depth control.

---

## [0.14.1] - 2026-07-18

### Fixed — Configure Models UX
- **Single-select now actually shows checkmarks** (`moaConfig.ts`): VSCode `showQuickPick({ canPickMany: false })` silently ignores the `picked` field — checkmarks only render when `canPickMany: true`. Added `singlePickWithCheckbox<T>()` helper built on `createQuickPick + canSelectMany: true` with real-time `onDidChangeSelection` validation: 0 selected → `circle-slash` icon, 1 selected → `check` icon (confirm enabled), ≥2 selected → `warning` icon (confirm disabled with inline message "只能选一个模型…"). Three submit paths wired: Enter key, ✓ button click, `onDidAccept`.
- **Configuration now persists to both User + Workspace tiers by default** — `saveConfiguration()` signature changed from `Promise<ConfigurationTarget | null>` to `Promise<boolean>`; iterates `[Global, Workspace]` targets writing refs/aggregator/reconModel/l3Summarizer to both. Eliminates the previous awkward "which tier?" prompt and the silent precedence issue where User tier cannot override Workspace tier.

### Changed
- All three Step 2/3/4 calls in the Configure Models flow migrated from `showQuickPick` to `singlePickWithCheckbox`.

---

## [0.14.0] - 2026-07-18

### Added — Recon & L3 model independence
- **`moa.reconModel`** config (`{ provider, model }` or empty): when non-empty, the recon phase uses this model instead of the aggregator. Empty value (default) falls back to aggregator — preserves v0.13.x behavior. Resolves the portability problem where `moaConfig.ts` hardcoded specific `modelId` strings.
- **`moa.l3Summarizer`** config (`{ provider, model }` or empty): when non-empty, the L3 grandchild agent uses this model. **Empty value disables L3 entirely** (the recon phase runs without the L3 truncation layer) — previously the L3 model was hardcoded to `gcmp.minimax:::MiniMax-M3-Token-Plan`.
- **Configure Models expanded to 4 steps**: Step 1 refs (multi-select) → Step 2 aggregator (single-select, pre-picks current) → Step 3 reconModel (single-select, includes a synthetic "= aggregator fallback" option) → Step 4 l3Summarizer (single-select, includes a synthetic "= disabled" option).
- `FALLBACK_L3_MODEL_ID` constant retained in `l3Summarizer.ts` only as a defensive兜底; in practice empty config = disabled.

### Changed
- `resolveL3Model()` reads from `moa.l3Summarizer.model`; returns `null` when empty (caller skips L3).
- Recon agent model resolution moved to Phase 0 entry; previously resolved inside the recon loop.

---

## [0.13.0] - 2026-07-18

### Added — Recon capability upgrade
- **Tool-name filter rewrite** (`moaReconTool.ts`): removed the `copilot_` prefix whitelist (too narrow — missed vendor-prefixed tools like `gcmp_*` and built-in `read_file`). Replaced with:
  - **Hard blacklist** (24 patterns): write/edit/delete/run/exec/terminal/insert/replace/rename/paste/apply_patch/diff/create/save/move/install/uninstall/git/push/commit/stash etc. — matched via regex on tool name.
  - **Soft blacklist** (3 patterns, configurable via `moa.reconBlockedTools`): terminal-related tools that are technically read-only but pollute recon context (`run_in_terminal`, `get_terminal_output`, `exec`).
- **Early-stop heuristics** in the recon loop:
  - *Stagnant*: 3 consecutive iterations with no new files added → stop.
  - *Saturation*: recon summary exceeds `moa.reconContextChars` budget → stop.
- **Max iterations lifted 8 → 50** (`moa.maxReconIterations`, default 50, hard cap 50). Old default of 8 was too aggressive for medium codebases.
- **3-layer truncation** for oversized recon results:
  - *L1 (small)*: summary < 30k chars → inject as-is.
  - *L2 (semantic boundary)*: 30k–100k chars → truncate at the last complete tool-result block, preserving block boundaries.
  - *L3 (grandchild agent)*: > 100k chars → spawn an L3 Summarizer agent (default MiniMax-M3) to produce a 5k-char digest, cached at `<workspace>/.moa_cache/l3_summaries/<sha1>.txt` (key = filePath + fileSize + userPrompt).
- **`l3Summarizer.ts`** (new, ~300 LOC): L3 grandchild agent module — cache layer, prompt builder, model resolver, invoke wrapper.
- **`Moa: Probe Recon Tools`** debug command: lists tools visible to the recon agent after filtering (for tuning the blacklist).

### Changed
- Recon agent system prompt rewritten to not hardcode tool names — references capabilities ("use the file-reading tool", "use the search tool") so the prompt survives VSCode/Copilot tool-name changes.

---

## [0.12.0] - 2026-07-18

### Added — Iterative MoA orchestration (Hermes-style)
- **3 new LM tools**: `moa_orchestrate`, `moa_continue`, `moa_finalize`. Exposes the MoA loop as composable VSCode LM tools so other agents (or the user via chat) can drive an iterative refinement loop.
  - `#moa_orchestrate` — starts a new loop, returns `task_id`.
  - `#moa_continue` — feeds subagent recon results back, runs one iteration; supports `deferredResultId` for resume semantics.
  - `#moa_finalize` — force-stops the loop, extracts action items, writes `final.json`.
- **State persistence to disk**: every iteration's recon input + ref outputs + aggregator verdict written to `<workspace>/.moa_cache/<task_id>/iteration_NNN/`. Survives main-session compaction.
- **Convergence rules**: aggregator emits `completeness` score (0.0–1.0); loop auto-stops at `completeness ≥ 0.8` (COMPLETENESS_THRESHOLD) or 3 stalled iterations (CONVERGENCE_WINDOW).
- **`moaOrchestrator.ts`** + **`moaOrchestrateTools.ts`** (new modules): orchestration state machine + the 3 tool implementations.

### Fixed
- LM tool registration: `modelDescription` + `toolReferenceName` fields now correctly populated (was causing tools to not appear in the Copilot Chat tool picker).
- `callerReconContext` config-key bug: when the parent agent passed pre-collected context, the recon phase was ignoring it due to a typo'd config key.
- Recon failure path: `reconBroken` flag now propagated correctly so refs fall back to workspace-context-only mode instead of crashing.

---

## [0.11.0] - 2026-07-18

### Added — Standalone recon & analyze tools
- **`moa_recon`** LM tool: standalone read-only recon — accepts a prompt + optional file list, returns a structured summary. Usable outside the `@moa` chat participant (e.g. from other agents, slash commands, or chat tool-use).
- **`moa_analyze`** LM tool: single-shot multi-perspective analysis — runs N refs + 1 aggregator in one tool call, returns the fused analysis. For callers that want MoA reasoning without driving the loop themselves.
- **`moaReconTool.ts`** + **`moaTool.ts`** (new modules): tool implementations + read-only tool filtering.
- **`probeTools.ts`**: debugging helper that enumerates all registered `vscode.lm.tools` (replaces the inline probe code from v0.8.0).

---

## [0.10.0] - 2026-07-18

### Changed — Subagent split
- **Refs layer is now pure reasoning** — refs no longer receive `wsContextText` (the workspace snapshot). Only the recon phase reads workspace files; refs see only the recon summary. Eliminates the duplicate-context bug where refs were token-billed for both workspace snapshot and recon summary.
- **Ref/acting separation** clarified: refs produce JSON `{sufficient, missing, analysis}` (pure reasoning, no tools); the acting agent (Layer 3) owns all tool calls and produces the final user-facing Markdown.
- Recon agent system prompt rewritten — no longer hardcodes tool names; references tool capabilities ("file-reading tool", "search tool") so the prompt is robust to VSCode/Copilot tool-name churn.

### Removed
- `wsContextText` parameter from ref prompt template (was a no-op since v0.9.0 hotfix1 but still being computed and token-billed).

---

## [0.9.0] - 2026-07-18

### Added — Recon phase (Phase 0) + Sufficiency gate (Phase 1.5)
- **4-layer pipeline**: recon → ref fan-out → aggregator → acting agent. Recon collects files relevant to the user's question BEFORE refs run, so refs see grounded context instead of guessing.
- **`moa.enableRecon`** (default: true): toggle the recon phase. When false, falls back to v0.8.0 behavior (refs see only workspace context).
- **`moa.maxReconRounds`** (default: 3, max 5): cap for the multi-round recon loop. Each round = 1 recon pass + N ref fan-out + sufficiency check.
- **`moa.reconContextChars`** (default: 30000): character budget for the recon summary injected into ref prompts.
- **Sufficiency gate**: refs output JSON `{sufficient, missing, analysis}`. If a majority of refs say `sufficient=false`, the recon agent loops back with their `missing` hints as priority targets. Converges when majority says `sufficient=true` or `maxReconRounds` is hit.
- **Read-only tool whitelist** (`actingAgent.ts`): recon only gets read-only tools (read_file, find_files, grep, get_errors, search_codebase, list_dir, list_code_usages, etc.). Write tools (apply_patch, insert_edit, replace_string, run_in_terminal, rename, write, create, delete, etc.) are blacklisted via regex.
- **`runReconAgent()`** function in `actingAgent.ts`: thin wrapper around `runActingAgent` with `readOnly=true`, lower iteration cap (8 vs 12), recon-specific system prompt, and `captureToolResults=true` so the recon summary can be extracted.
- **`extractReconSummary()`** + **`parseRefOutput()`** helpers in `moaRunner.ts`: build the recon summary text from captured tool calls, and parse ref JSON outputs (with graceful fallback when models don't emit valid JSON).

### Changed
- **Aggregator model resolution moved earlier** — now resolved before Phase 0 because recon reuses the aggregator model.
- **Ref prompt extended** — refs now receive recon summary as additional context, and are required to output JSON-wrapped `{sufficient, missing, analysis}`. When recon is disabled, refs still output JSON (parsed for uniformity), but `sufficient` is ignored.
- **Aggregator input parsing** — ref outputs are unwrapped from JSON before being joined for the aggregator; aggregator sees clean prose, not JSON scaffolding.
- **Ref fan-out loop wrapped in `sufficiencyLoop`** — supports multi-round convergence instead of single-shot.

### Fixed
- Removed duplicate `const hasTools` declaration (renamed early check to `hasToolsEarly` in moaRunner.ts).

### [0.9.0 hotfix1] - 2026-07-18

### Changed — Project tree depth & recon precision
- **Project tree depth lifted** (workspaceContext.ts): `depth=2/maxEntries=50/slice=15` → `depth=6/maxEntries=2000/slice=50`. Refs can now see `src/services/auth/login.ts` level nesting, not just `src/`. File entries show their size in KB so refs can prioritize.
- **Oversized files (>1MB) excluded from tree listing** — refs don't need to see binary/asset paths as candidates.
- **`recon` system prompt revised** — explicitly directs recon agent to use `read_file` with `startLine`/`endLine` parameters for large files (instead of reading whole files). When missing hints are present, gives a 3-shape interpretation guide (path:line-line / path / identifier → search query).

### Added — Hint-based prefetch
- **`parseMissingHint()`** — parses ref "missing" hints into `{filePath?, lineRange?, query?}` structures. Supports three shapes: `src/foo.ts:120-150` (line range), `src/foo.ts` (full file), `funcName` (search query).
- **`prefetchFromHints()`** — for hints with explicit filePath, moaRunner calls `vscode.lm.invokeTool('copilot_readFile', ...)` directly. Bypasses the recon agent for high-priority, well-specified targets.
- **Two-pass Phase 0**: prefetched hints are merged into the recon summary with `[prefetched hint N]` provenance marker; recon agent only handles query-only hints + new discoveries.
- **`extractReconSummary()` signature extended** — now takes `prefetched: Map<number, string>` + `prefetchedHints: string[]`. Block ordering changed: prefetched first (highest priority), then captured recon calls.

---

## [0.8.0] - 2026-07-18 (unreleased in CHANGELOG, documented retroactively)

### Added — 3-layer Hermes architecture
- **Acting agent** (Layer 3): tool-calling loop that takes aggregator guidance + user prompt, calls copilot_* tools (read_file, apply_patch, run_in_terminal, etc.), and produces the FINAL user-facing Markdown answer.
- **`moa.enableActingAgent`** (default: true): toggle Layer 3. When false, aggregator output IS the final answer (v0.7.x 2-layer behavior).
- **`workspaceContext.ts`**: builds workspace snapshot (active editor + selection + open docs + project tree) injected into ref prompts.
- **`Moa: Probe Available Tools`** debug command: lists all registered `vscode.lm.tools`.

---

## [0.7.3] - 2026-07-18

### Added
- **`moa.refDisplayMode`** config (default: `thinking`): controls how ref outputs appear in chat UI. `thinking` (Hermes-style) shows only progress indicators; `verbose` (legacy) streams refs inline as markdown.

---

## [0.7.2] - 2026-07-18

### Changed
- Model display now includes vendor suffix in all chat output: `DeepSeek-V4-Flash [gcmp.deepseek]`. Critical for disambiguating same-name models registered under multiple vendors (e.g. `GLM-5.2 (CodingPlan)` exists under both `gcmp.zhipu` and `gcmp.volcengine`).

### Removed
- **Preset feature** (was dead code since v0.1.0): `presets/` directory, `/preset` slash command, `ChatFollowup` suggestions, `parsePrompt` preset extraction, `moa.defaultPreset` config.
- **Path detection** (`detectPath`, `runMoaWrapper`, `pathExists`): the P2a/P2b paths were unimplemented (P2a) or unused (P2b required Hermes which was replaced by native vscode.lm in v0.3.0).
- `moaHandler.ts` simplified: only P1 native path remains, ~50% smaller.
- `types.ts` simplified: removed `PathDetection`, `ParsedPrompt`, `MoaRunResult.preset`. `MoaPath` reduced to `'P1' | 'P1-partial' | 'P1-degraded' | 'error'`.

## [0.7.1] - 2026-07-18

### Changed
- Trimmed to a single command: `Moa: Configure Models`. Removed `Moa: List Available Models`, `Moa: Probe Models (Smart)`, `Moa: Probe ALL Models` — precise selection via Configure Models makes them redundant.

## [0.7.0] - 2026-07-18

### Fixed
- **Critical bug**: 4 configured refs became 11 picked items when same model name exists under multiple vendors (e.g. `GLM-5.2 (CodingPlan)` under both `gcmp.zhipu` and `gcmp.volcengine`).
- Root cause: pre-pick used substring matching on `m.name` which collides across vendors. Runtime `find()` returned the first match, but pre-pick marked ALL same-name items.
- Fix: store `m.id` (unique vendor-scoped identifier like `gcmp.zhipu:::glm-5.2`) instead of `m.name`. Pre-pick uses exact `m.id` match.

### Changed
- Configure Models: QuickPick label now shows `Name [vendor]` for human readability.
- Runtime lookup: `m.id` exact match first, `m.name` substring fallback for backward compat with v0.6.x configs.

## [0.6.0] - 2026-07-18

### Removed
- Dead config options: `moa.defaultPreset`, `moa.preferredModels`, `moa.timeoutSec`, `moa.minRefs`, `moa.maxRefs`. None were wired to runtime behavior (grep confirmed 0 usages).
- `moaRunner.ts` auto-fill logic: removed `minRefs`/`maxRefs` pool filling that silently re-added deselected models.

### Fixed
- Empty selection in Configure Models now triggers a confirm dialog before clearing `moa.refModels`.

## [0.5.0] - 2026-07-18

### Added
- Separate commands: `Moa: Configure Refs` (multi-select only) and `Moa: Configure Aggregator` (single-select only).

### Removed
- Removed in v0.7.1 (re-merged into single Configure Models command).

## [0.4.0] - 2026-07-18

### Added
- Smart Probe mode: only ping configured models (fast).
- Full Probe mode: ping all registered models.
- Error categorization: `OK / AUTH (401/403) / CONFIG (400/404) / NETWORK (timeout) / UNKNOWN`.
- Auto-sort: OK first, AUTH last.
- One-click "Configure with working models" after probe.

### Removed
- Removed in v0.7.1 (precise selection makes probing redundant).

## [0.3.0] - 2026-07-18

### Changed
- **Ported Hermes `_REFERENCE_SYSTEM_PROMPT` from [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent/blob/main/agent/moa_loop.py)**.
- Ref advisors now produce private advisory analysis (not user-facing answers), preventing refusal ("I can't access tools") and tool-call attempts.
- Aggregator prompt refactored to Hermes `synth_prompt` style: focus on actionable response, next steps, disagreements, risks.
- Reference output format: `Reference {idx} — {label} ({model}):\n{text}` (matches Hermes exactly).
- Language-following: refs and aggregator match the user's question language automatically.

### Researched
- Confirmed Hermes is a 3-layer architecture (`ref → aggregator → acting agent`), not 2-layer as initially assumed.
- VSCode `@moa` is a 2-layer terminal (no acting agent layer needed), so the Hermes prompts were adapted: aggregator output IS the user-facing response.

## [0.2.0] - 2026-07-18

### Changed
- **Switched from role-based MoA to equal-mode MoA** (Together AI 2024 / Hermes classic style).
- Removed per-ref `systemHint` role specialization (`Technical` / `Logical` / `Creative`).
- All refs now share the same neutral system prompt; diversity comes from underlying model differences (GLM vs DeepSeek vs MiniMax), not role assignment.
- Configure Models flow simplified: 4 steps → 2 steps (refs checkbox + aggregator single-select).
- `moa.refModels` schema: `role` field demoted to display label only, no longer injected into prompt.
- `moa.sharedRefPrompt` config added for advanced users to override the built-in prompt.

## [0.1.0] - 2026-07-17

### Added
- Initial public release.
- `@moa` chat participant registration with `isSticky`, slash commands (`preset`, `help`), and disambiguation examples.
- Auto path detection (P1 / P2a / P2b) by scanning for `scripts/MoaWrapper.ps1`, `scripts/MoaSim.ps1`, `scripts/MoaAcp.ps1`.
- P2b runner — spawns `pwsh -File MoaWrapper.ps1 -Prompt ... -Preset ...`, streams stdout into the chat response stream.
- P1 native fan-out via `vscode.lm.selectChatModels` (used when Hermes wrapper not detected).
- Multi-perspective analysis with 3 reference advisors + 1 aggregator.
- Graceful degradation when models fail.
- Interactive configuration: `Moa: Configure Models`, `Moa: List Available Models`, `Moa: Probe Models (Ping Test)`.

### Known Limitations
- P2a (ACP) path not implemented.
- Role-based MoA (later replaced by equal-mode in v0.2.0).
- Preset feature never functional (removed in v0.7.2).