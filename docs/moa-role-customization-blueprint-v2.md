# MoA 角色自定义系统设计蓝图 v2(v0.22.0)

> 日期:2026-07-21(v2)
> 用途:**v0.22.0 是"风味与个性化强力设定"版本 —— 让 MoA 成为 VSCode 中长出的个人化檞寄生**
> **版本演进**:
> - **v1**(保留):[moa-role-customization-blueprint.md](moa-role-customization-blueprint.md) — 初版蓝图
> - **v2**(本文档):基于用户第三轮反馈,主要变化:
>   1. RoleSetupPreset schema 调整:删除 refs/aggregator 字段(对齐 v2 架构红线)
>   2. tone 限定为 7 选 1(对齐 [planner-system-prompt-v2.md](planner-system-prompt-v2.md))
>   3. Plan Mode 加入"实时报告 + 用户编辑 + Preset 切换"完整流程
>   4. Recon Aggregator 自迭代扩展为 1-10 次 + 评分(对齐 [moa-role-design-philosophy-v2.md](moa-role-design-philosophy-v2.md) §4)
>   5. final.md 主会话分级展示(用户额外要求)
>   6. 新增 §6 用户自定义 few-shot 示例机制
>   7. 新增 §10 端口/工具验证脚本设计
>   8. 工作量估算更新(12-14 天 → 15-18 天,因 Plan Mode + final.md 展示)
> 关联文档:
> - [moa-role-injection-design.md](moa-role-injection-design.md) — 注入矩阵主总览
> - [moa-role-design-philosophy-v2.md](moa-role-design-philosophy-v2.md) — 设计哲学 v2
> - [planner-system-prompt-v2.md](planner-system-prompt-v2.md) — Planner 提示词 v2
> - [roadmap/v0.22.0-role-injection-overhaul.md](roadmap/v0.22.0-role-injection-overhaul.md) — 路线图
> 状态:**设计阶段 v2**

---

## §0. 核心理念(v2 不变,用户原话归纳)

> "这一大版本就是一个风味与个性化的强力设定,就是在 vscode 当中长出来的一个个人 MOA 檞寄生。"

**3 大支柱**(v1 提出,v2 强化):

1. **用户主权(User Sovereignty)**:用户拥有每个角色的最终设定权,包括 tone(限定枚举)/ perspective / tool_priority / 语言 / 整个 prompt
2. **AI 辅助(AI Assistance)**:Planner 可自动生成 role_setup,但**采纳与否由开关决定**
3. **组合传承(Preset Inheritance)**:类似 moa 模型选择,角色设定可作为"风味预设"保存/加载/分享

---

## §1. 用户角色设定的层次结构(v2 schema 调整)

### 1.1 v2 RoleSetupPreset schema(对齐架构红线)

**v1 → v2 关键变化**:

- 删除 `roles.refs` 和 `roles.aggregator`(架构红线:这两个角色完全不可定制)
- `tone` 字段类型从自由文本改为限定枚举
- 新增 `planner.fewShots`(用户自定义 few-shot 示例)
- 新增 `processLanguageOverride`(用户强制覆盖 Planner 的 process_language 决策)

```typescript
interface RoleSetupPreset {
  /** 预设名(用户可命名) */
  name: string;
  /** 组合说明(任意语言,展示给用户看) */
  description: string;
  /** 创建/修改时间 */
  createdAt: string;
  updatedAt: string;
  /** 流程默认语言(可被 Planner process_language 覆盖;若 override=true 则强制) */
  defaultLanguage: 'zh-CN' | 'en' | 'mixed' | 'ja' | 'ko' | 'fr' | 'de' | ...;
  processLanguageOverride: boolean;  // v2 新增
  /** v2: 3 角色设定(删除 refs 和 aggregator) */
  roles: {
    planner?: PlannerOverride;        // v2 新增:用户可自定义 Planner
    recon: RoleOverride;
    reconAggregator: RoleOverride;
    actor: RoleOverride;
    // v2 删除: refs, aggregator
  };
  /** AI 自生成的开关 */
  aiGenerated: {
    enabled: boolean;
    autoAccept: boolean;
    confirmationUI: 'quick-pick' | 'diff-view' | 'plan-mode';
    planModeReportScope: PlanModeReportScope;
  };
}

interface PlannerOverride {
  /** v2 新增:用户自定义 few-shot 示例(详见 §6) */
  fewShots?: PlannerFewShot[];
  /** v2 新增:用户强制 Planner 用的 process_language */
  forcedProcessLanguage?: string;
  /** v2 新增:用户自定义 Planner 的额外指令 */
  extraInstructions?: string;
}

interface RoleOverride {
  /** v2: tone 限定枚举 */
  tone?: TonePreset;
  /** 自由文本:分析视角/职责边界 */
  perspective?: string;
  /** 推荐工具(v2: 排序后的完整列表,不拆分) */
  toolPriority?: string[];
  /** 注意事项 */
  cautions?: string[];
  /** 整合重点(仅 recon_aggregator) */
  focus?: string[];
  /** 完整 prompt 覆盖(高级模式) */
  customSystemPrompt?: string;
}

type TonePreset =
  | 'strict-evidence'      // 严谨证据(Recon 默认)
  | 'faithful-integrator'  // 忠实整合(Recon Aggregator 默认)
  | 'neutral-judge'        // 中立裁判(Aggregator 固定,不可选)
  | 'strict-executor'      // 严格执行(Actor 默认)
  | 'creative-explorer'    // 创造探索
  | 'conservative'         // 保守模式
  | 'aggressive'           // 激进模式
  | 'custom';              // 自定义(配合 customSystemPrompt)
```

### 1.2 与模型预设的关系(v1 不变)

详见 v1 [moa-role-customization-blueprint.md](moa-role-customization-blueprint.md) §1.2。

---

## §2. AI 自生成开关机制(v1 提出,v2 强化)

### 2.1 三层开关(v1 设计)

详见 v1 [moa-role-customization-blueprint.md](moa-role-customization-blueprint.md) §2.1。

### 2.2 决策矩阵(v1 不变)

详见 v1 [moa-role-customization-blueprint.md](moa-role-customization-blueprint.md) §2.2。

### 2.3 v2 新增:Plan Mode 是默认推荐 UI

**v2 默认**:`confirmationUI = 'plan-mode'`(借鉴 Copilot Plan agent,但 MoA 为主干)

**用户原话**:

> "可以有一个开关,就是通过 ask_question 的形式,实时给用户报告所形成的 plan 计划,recon 提示词,给 recon 的角色设定,recon_aggregator 以及 actor 的角色设定,以及操作消耗和内容。我认为这个是最为关键的入口,有些类似于 plan 模式 agent 的工作。"

详见 §4 完整设计。

---

## §3. Tone 限定系统(v2 核心交付)

> 用户原话:"tone 应该要限定,与当前工作流适配。"

### 3.1 7 个限定 Tone(v1 提出,v2 强化"用户预设可覆盖")

| Tone ID             | 中文标签     | 默认角色                                 | 核心特征                                                          |
| ------------------- | ------------ | ---------------------------------------- | ----------------------------------------------------------------- |
| `strict-evidence`   | 严谨证据     | **Recon**(默认)                       | 保留所有数字/引用/关键句,不归因不解读不补全                       |
| `faithful-integrator` | 忠实整合   | **Recon Aggregator**(默认)            | 保留原证据,不补充不解读,做去重/排序/识别与保留冲突             |
| `neutral-judge`     | 中立裁判     | **Aggregator**(固定,用户不可改)     | 只看 refs 输出综合,不被 role_setup 带偏                          |
| `strict-executor`   | 严格执行     | **Actor**(默认)                       | 严格按 action_items 顺序执行,失败如实记录                         |
| `creative-explorer` | 创造探索     | Refs(可选)/ Recon(可选)              | 鼓励非常规视角,容忍合理推测(明确标注 confidence)              |
| `conservative`      | 保守模式     | Actor(可选)                            | 破坏性操作前必问用户,优先用 .bak 备份                           |
| `aggressive`        | 激进模式     | Actor(可选,危险)                      | 自动执行不问,git commit 自动化(仅 CI/CD 场景)                |

### 3.2 v2 限定规则

- **Recon** 可选:`strict-evidence` / `creative-explorer` / `conservative`
- **Recon Aggregator** 可选:`faithful-integrator` / `strict-evidence`
- **Actor** 可选:`strict-executor` / `conservative` / `aggressive`
- **Refs** 和 **Aggregator**:**完全不可定制**(v2 强化架构红线)

### 3.3 为什么限定(v1 理由 + v2 强化)

详见 v1 [moa-role-customization-blueprint.md](moa-role-customization-blueprint.md) §3.3。

**v2 强化**:tone 限定是为了**跨预设可比性**。如果用户 A 的"严谨"和用户 B 的"严谨"含义不同,预设分享就会失真。

---

## §4. Plan Mode 实时报告(v2 完整设计)

> 用户原话:"我认为这个是最为关键的入口,有些类似于 plan 模式 agent 的工作。你查看一下 [Plan.agent.md] 然后结合 moa 的形式,更新与迭代一下你写的 planner 角色,必须要以我们的 MOA 流程为主干,这个 copilot 只是启发性质的。"

### 4.1 借鉴 Copilot Plan Agent(但 MoA 为主干)

**Copilot Plan.agent.md 核心思想**(启发源):

1. **Discovery → Alignment → Design → Refinement** 四阶段
2. `searchSubagent` 并行收集
3. `vscode/askQuestions` 澄清需求
4. **必须显示 plan 给用户**(plan.md 是持久化,显示是必须的)
5. `handoffs` 让用户选"开始实施"/"打开编辑器"
6. 持久化到 `/memories/session/plan.md`

**MoA 主干(v2 设计)**:

- MoA 有 6 角色流水线,不是 Copilot 的单 agent
- MoA 的 Planner **本身就是设计阶段**,无需 Copilot 的 4 阶段区分(Planner mini-loop 已涵盖)
- MoA 的"显示"用 **vscode_askQuestions**(用户原话)而非 Copilot 的 markdown 渲染
- MoA 的"持久化"用 `.moa_cache/<task_id>/planner/`(已有,不是 memories)

### 4.2 MoA Plan Mode 工作流(v2 完整 4 阶段)

```
用户提问 "<用户的具体任务>"
         ↓
┌────────────────────────────────────────────────────────────┐
│ 阶段 A:Planner mini-loop(自动,后台)                    │
│   iter 1+: 可调 read-only 工具 + web_search(概念澄清)     │
│   iter N: plan_coverage >= 0.9 收敛 或 ask_user=true       │
└────────────────────────────────────────────────────────────┘
         ↓
┌────────────────────────────────────────────────────────────┐
│ 阶段 B:Plan Mode 报告(vscode_askQuestions 显示)         │
│                                                            │
│ ┌─ 标题: MoA Plan 已生成 (N 次迭代, plan_coverage=X.XX) ─┐│
│ │                                                          ││
│ │ 📋 Clarified Task:                                       ││
│ │    <Planner 生成的 clarified_task 摘要>                  ││
│ │                                                          ││
│ │ 🎯 Sub Questions (≤5):                                  ││
│ │    1. <sub_question_1>                                   ││
│ │    2. <sub_question_2>                                   ││
│ │    ...                                                   ││
│ │                                                          ││
│ │ 🎭 Role Setup(v3: 3 角色,无 refs/aggregator):         ││
│ │    Recon: <tone>                                         ││
│ │      - tool_priority: <排序后的工具列表>                 ││
│ │    Recon Aggregator: <tone>                              ││
│ │    Actor: <tone>                                         ││
│ │                                                          ││
│ │ 📊 Planner 当前状态(v3 修订:仅状态,无 token 估算):    ││
│ │    - 已迭代次数: N                                       ││
│ │    - plan_coverage 收敛曲线: 0.65 → 0.88 → 0.92 ✓       ││
│ │    - needs_replan: false                                 ││
│ │    - ask_user 触发: 否                                   ││
│ │    (❌ v3 删除:操作消耗预估 / token 数 / 价格估算)      ││
│ └──────────────────────────────────────────────────────────┘│
│                                                            │
│ 选择下一步(vscode_askQuestions):                         │
│ ◉ 采纳并开始执行 MoA 流水线(推荐)                      │
│ ○ 编辑 Role Setup 后再执行                                │
│ ○ 切换到不同 Role Setup Preset 后再执行                   │
│ ○ 让 Planner 再迭代一轮                                   │
│ ○ 取消任务                                                │
└────────────────────────────────────────────────────────────┘
         ↓ 用户选 "采纳并开始执行"
┌────────────────────────────────────────────────────────────┐
│ 阶段 C:MoA 流水线执行(与 v0.21.x 一致)                 │
│   Recon ×N → Recon Aggregator → Refs ×N → Aggregator       │
│   → Actor → finalize                                       │
└────────────────────────────────────────────────────────────┘
         ↓
┌────────────────────────────────────────────────────────────┐
│ 阶段 D:v2 新增:Final.md 主会话内分级展示(详见 §5)     │
└────────────────────────────────────────────────────────────┘
```

### 4.3 v2 vscode_askQuestions 接口(v3 修订:删除 estimatedCost)

```typescript
interface MoAPlanReport {
  /** 标题 */
  title: string;
  /** Planner 迭代信息 */
  iterations: number;
  planCoverage: number;
  /** Clarified task */
  clarifiedTask: string;
  /** Sub questions */
  subQuestions: string[];
  /** v3: 3 角色(删除 refs/aggregator) */
  roleSetupSummary: {
    recon: { tone: TonePreset; toolPriority: string[] };
    reconAggregator: { tone: TonePreset; focus: string[] };
    actor: { tone: TonePreset; toolPriority: string[] };
  };
  /** 完整 plan 文本(便于用户复制) */
  fullPlanText: string;
  /** v3 修订:Planner 当前状态(替代 estimatedCost) */
  plannerStatus: {
    iterationsRun: number;
    planCoverageHistory: number[];   // [0.65, 0.88, 0.92]
    needsReplan: boolean;
    askUserTriggered: boolean;
    converged: boolean;
  };
  // ❌ v3 删除:estimatedCost(用户不需要 token 消耗预估)
  /** 用户选择项 */
  choices: Array<{
    label: string;
    description: string;
    action: 'accept' | 'edit-role-setup' | 'switch-preset' | 'iterate-planner' | 'cancel';
  }>;
}
```

### 4.4 v2 "编辑 Role Setup" 流程(用户原话 #1.3)

> 用户原话:"对话框内加入,便于复制粘贴然后在外部修改与替换"

用户选"编辑 Role Setup 后再执行"时:

1. VSCode 弹出**新 untitled 文档**:`untitled:moa-role-setup-${timestamp}.json`
2. 文档内容是当前 Planner 生成的 role_setup 的 JSON
3. 用户在外部编辑器修改(任意语言注释、调整 tone、改 tool_priority)
4. 用户保存(或关闭文档)→ MoA 检测变更 → 弹 QuickPick 询问"应用修改?"
5. 应用后,Role Setup Preset 自动保存为新的(可选,用户选择"保存为新预设"或"仅本次使用")

**v2 强化**(用户原话:"每个组合还可以加入组合说明与设定,这里应该是可以输入任何语言"):

- 弹出的 JSON 文档**顶部**有 `description` 字段(任意语言)
- 用户修改 description 时,任意语言都接受(中文/英文/日文/混合)
- 保存时校验 JSON 有效性,但 description 字段不做语言校验

**v2 强化**(用户原话:"在创建与修改的时候,可以加入是否对这个进行修改的选项"):

- 创建新 Preset 时:可选"基于当前 AI 生成"/"基于现有 Preset 复制"/"从空白开始"
- 修改现有 Preset 时:可选"原地修改"/"另存为新 Preset"(保留原版)

---

## §5. Recon Aggregator 自迭代与评分(v2 扩展)

> 用户原话:"Recon Aggregator 默认自迭代 1 次,因为只是一个迭代工具,但是开放权限到 10 次,并且总的让 Recon Aggregator 给出一个聚合度与忠诚度的评分。"

### 5.1 v2 自迭代配置

```json
{
  "moa.reconAggregatorMaxIterations": {
    "type": "number",
    "default": 1,
    "minimum": 1,
    "maximum": 10,
    "description": "Recon Aggregator 自迭代最大次数。v1 最大 3 次,v2 扩展为 10 次。"
  },
  "moa.reconAggregatorConvergenceMode": {
    "type": "string",
    "enum": ["score-threshold", "fixed-iterations"],
    "default": "score-threshold"
  },
  "moa.reconAggregatorScoreThreshold": {
    "type": "number",
    "default": 0.85,
    "minimum": 0.5,
    "maximum": 1.0,
    "description": "Score-threshold 模式下,聚合度+忠诚度均超过此值时收敛。"
  }
}
```

### 5.2 v2 Recon Aggregator 输出扩展

```typescript
interface ReconAggregatorOutput {
  summary: string;
  crossReconGaps: string[];

  // v2 新增
  aggregationScore: number;      // 聚合度 0-1
  fidelityScore: number;         // 忠诚度 0-1
  needsReiteration: boolean;
  iterationsCompleted: number;
}
```

详见 [moa-role-design-philosophy-v2.md](moa-role-design-philosophy-v2.md) §4.3。

---

## §6. v2 新增:用户自定义 Few-Shot 示例

> 用户原话(对 planner-system-prompt-v2.md §1 第七部分):"这个有存在必要么?还是说就保留,然后暴露在外部,让用户最终可以自定义?"

### 6.1 v2 设计:few-shot 不再硬编码

**v1**:Planner 系统提示词中硬编码 3 个 few-shot 示例(研究类/代码类/ask_user 触发)
**v2**:few-shot 从 Role Setup Preset 加载;用户没自定义时 fallback 到 v1 内置示例

### 6.2 PlannerFewShot schema

```typescript
interface PlannerFewShot {
  /** 示例名(用户可命名) */
  name: string;
  /** 用户输入示例 */
  userInput: string;
  /** 期望的 PlannerOutput JSON */
  expectedOutput: PlannerOutput;
  /** 注释(任意语言,展示给用户看) */
  comment?: string;
}
```

### 6.3 用户自定义流程

1. 用户在 Role Setup Preset 的 `planner.fewShots` 字段写自己的示例
2. MoA 加载 Preset 时,把 fewShots 渲染成 prompt 片段
3. 通过 `${USER_FEW_SHOT_EXAMPLES}` 占位符注入 Planner 系统提示词第七部分
4. Planner 看到的是用户自定义的示例,不是内置的

### 6.4 默认 fallback(v3 修订:不提供任何示例)

**v3 决策**(用户原话:"具体示例要删掉,我看不过来了,你处理一下,要脱敏"):

如果用户没自定义 fewShots:

- v1/v2 默认从 [planner-system-prompt.md](planner-system-prompt.md) v1 §1 第七部分加载 3 个示例(研究类/代码类/ask_user 触发)
- **v3:删除所有具体示例**,`${USER_FEW_SHOT_EXAMPLES}` 注入**空字符串**
- Planner 看到的是"无 few-shot",仅依赖 system prompt 的规则描述工作

**理由**:具体示例会让用户产生"MoA 偏向某类任务"的错觉,且示例本身可能脱敏不彻底。删除后,Planner 更加通用,用户根据需要自行添加自己的示例。

### 6.5 推荐场景(v3 修订:通用化措辞)

用户可根据自身需要自定义 few-shot:

- **领域 specialization**:用户的专业领域(学术/工程/设计/写作等)
- **特定输出格式**:如强制要求 clarified_task 含特定结构
- **特定 role_setup 模式**:用户希望的 Recon/Actor tone 组合

---

## §7. Final.md 在主会话内展示(v2 新增,用户额外要求)

> 用户原话:"在最终的主会话的输出中,感觉还是很草率,我觉得直接将 final.md 直接在会话内展现出来,或者如果太长,将其缩略提炼后展示出来也是可以的,关键信息也能在上下文暴露,让下一轮对话能够直接获取相应的信息而不必调取工具去多轮次查询与验证。"

### 7.1 v2 改进策略:分级展示

| final.md 长度 | 展示策略                                                               |
| ------------- | ---------------------------------------------------------------------- |
| < 2000 字符   | **完整内嵌**到主会话 Markdown 响应                                     |
| 2000-8000 字符 | **摘要 + 关键信息内嵌** + 完整内容链接到 final.md                      |
| > 8000 字符   | **结构化摘要**(TL;DR + 关键发现 top 5 + action_items)+ 链接到 final.md |

### 7.2 v2 内嵌模板

```markdown
## 🎯 MoA 任务完成

**任务**: <原 user prompt 摘要>
**耗时**: <X 分 Y 秒> | **迭代**: <N 轮> | **模型预设**: <name>

### 📋 TL;DR

<final.md 的 summary 段落,1-2 段>

### 🔑 关键发现(Top 5)

1. **<发现 1 标题>**: <1 句话内容>(来源: <Ref/Recon>)
2. **<发现 2 标题>**: ...
3. ...

### ⚙️ Action Items(已执行 / 待执行)

| # | 类型 | 目标 | 状态 |
|---|------|------|------|
| 1 | write_file | src/foo.ts | ✅ success |
| 2 | execute | npm test | ✅ success |
| 3 | inform_user | ... | ⏸ pending |

### 📊 Aggregator 评估

- **Evidence Coverage**: 0.92
- **Refs 一致性**: 高(3/3 一致)
- **未解决问题**: <如果有>

### 📁 完整报告

- **final.md**: [.moa_cache/<task_id>/final.md](.moa_cache/<task_id>/final.md)
- **Planner 迭代日志**: [.moa_cache/<task_id>/planner/](.moa_cache/<task_id>/planner/)
- **Recon 原始数据**: [.moa_cache/<task_id>/iteration_*/recon/](.moa_cache/<task_id>/iteration_1/recon/)

---
*💡 下一轮对话可直接引用以上信息,无需重新调取工具。*
```

### 7.3 v2 实现位置

修改 [src/moaHandler.ts](../src/moaHandler.ts) 的 ChatRequestHandler 退出逻辑:

```typescript
// v0.21.x: task complete → progress report → "见 .moa_cache/..."
// v0.22.0 v2: task complete → 读 final.md → 按长度分级展示 → 内嵌 Markdown → 工作区链接
```

### 7.4 v2 配置开关

```json
{
  "moa.finalMdInlineDisplay": {
    "type": "string",
    "enum": ["full", "summary", "structured-summary", "off"],
    "default": "structured-summary",
    "description": "v2 新增:final.md 在主会话内分级展示策略。'full' = 完整内嵌;'summary' = 摘要;'structured-summary' = 结构化摘要(默认);'off' = 仅链接。"
  },
  "moa.finalMdInlineThresholds": {
    "type": "object",
    "default": { "full": 2000, "summary": 8000 },
    "description": "v2 新增:final.md 长度阈值。低于 full 阈值完整内嵌;低于 summary 阈值摘要内嵌;高于 summary 阈值结构化摘要。"
  }
}
```

---

## §8. v2 用户自定义的技术实现

### 8.1 v2 配置存储(对齐 v1 方案 A)

**方案 A(沿用 v1)**:独立文件 `~/.moa/role-setup-presets.json`

**v2 schema 调整**(删除 refs/aggregator,新增 planner):

**v3 修订**:**只保留 1 个 `default` 内置预设**(不再提供 strict-researcher 等领域示例,用户基于 default 自行修改)。下方示例是 `default` 预设的最小骨架(用户拷贝后修改):

```json
{
  "version": "2.0",
  "activePreset": "default",
  "presets": [
    {
      "name": "default",
      "description": "<用户可填任意语言:这个预设适合什么场景、什么风格>(默认空,用户自行填写)",
      "defaultLanguage": "zh-CN",
      "processLanguageOverride": false,
      "aiGenerated": {
        "enabled": true,
        "autoAccept": false,
        "confirmationUI": "plan-mode"
      },
      "planner": {
        "fewShots": [
          {
            "name": "<示例名,用户命名>",
            "userInput": "<用户自定义的典型任务输入>",
            "expectedOutput": { "...": "用户自定义的期望 PlannerOutput" },
            "comment": "<任意语言注释>"
          }
        ]
      },
      "roles": {
        "recon": {
          "tone": "strict-evidence",
          "perspective": "<用户自行填写:Recon 的分析视角>",
          "toolPriority": ["<排序后的工具/skill 列表>"],
          "cautions": ["<用户自行填写:注意事项>"]
        },
        "reconAggregator": {
          "tone": "faithful-integrator",
          "focus": ["去重", "识别与保留冲突", "证据质量分级"]
        },
        "actor": {
          "tone": "strict-executor",
          "cautions": ["<用户自行填写:如 '不自动 git commit'>"]
        }
      },
      "createdAt": "2026-07-21T10:00:00",
      "updatedAt": "2026-07-21T10:00:00"
    }
  ]
}
```

### 8.2 v2 配置 UI(8 个命令,沿用 v1)

详见 v1 [moa-role-customization-blueprint.md](moa-role-customization-blueprint.md) §6.2。

v2 新增命令:

| 命令 ID                          | 功能                                                             |
| -------------------------------- | ---------------------------------------------------------------- |
| `moa.diagnoseEnvironment`        | **v2 新增**:端口/工具验证(详见 §10)                          |
| `moa.toggleFinalMdInlineDisplay` | **v2 新增**:快速开关 final.md 主会话展示                        |

### 8.3 v2 与模型预设的协同(沿用 v1)

详见 v1 [moa-role-customization-blueprint.md](moa-role-customization-blueprint.md) §6.3。

---

## §9. v2 设计美学指南(沿用 v1,详见 v1 §9)

详见 v1 [moa-role-customization-blueprint.md](moa-role-customization-blueprint.md) §9。

v2 强化:

- Recon Aggregator 美学新增"**识别与保留冲突**"(v1 是"消歧")
- Tone 不再是自由文本,而是 7 选 1(详见 [moa-role-design-philosophy-v2.md](moa-role-design-philosophy-v2.md) §6)

---

## §10. 端口与工具获取能力验证(v2 完整设计)

> 用户原话:"综合的设计蓝图要做一个,然后给我一个指南与方式。同时也要测试相应的端口与工具特别是信息能否获取到。"

### 10.1 v2 验证目标

| 信息源                | API                                                                      | 验证方法                                   |
| --------------------- | ------------------------------------------------------------------------ | ------------------------------------------ |
| Active editor         | `vscode.window.activeTextEditor`                                         | moaDev.test.ts 写测试                      |
| Open documents        | `vscode.workspace.textDocuments`                                         | 同上                                       |
| Workspace folders     | `vscode.workspace.workspaceFolders`                                      | 同上                                       |
| Project tree          | `fs.readdir`(递归)                                                     | 同上                                       |
| Git root              | `child_process.execSync('git rev-parse --show-toplevel')`                | 同上                                       |
| Instruction files     | `fs.readFile(7 路径)`                                                   | 同上                                       |
| Skill folders         | `fs.readdir(4 文件夹)` + 读 SKILL.md frontmatter                       | 同上                                       |
| Available LM tools    | `vscode.lm.tools`                                                        | 同上                                       |
| Available LM models   | `vscode.lm.selectChatModels({})`                                         | 同上                                       |
| Active model preset   | `getActivePresetConfig()`                                                | 同上                                       |
| **v2 新增**:Active role setup preset | `getActiveRoleSetupPreset()`                                 | 同上                                       |
| **v2 新增**:MoA 入口类型 | moaHandler.ts detection                                                  | 同上                                       |

### 10.2 v2 诊断命令实现

新增命令 `moa.diagnoseEnvironment`:

```typescript
// src/diagnostics.ts
export async function diagnoseEnvironment(): Promise<DiagnosticReport> {
  const checks: DiagnosticCheck[] = [];

  // 1. Active editor
  try {
    const editor = vscode.window.activeTextEditor;
    checks.push({
      name: 'Active editor',
      status: editor ? '✅' : '⚠️',
      detail: editor
        ? `${editor.document.uri.fsPath} (${editor.document.languageId})`
        : '(no active editor)'
    });
  } catch (e) {
    checks.push({ name: 'Active editor', status: '❌', detail: String(e) });
  }

  // 2. Open documents
  try {
    const docs = vscode.workspace.textDocuments.filter(d => d.uri.scheme === 'file');
    checks.push({
      name: 'Open documents',
      status: '✅',
      detail: `${docs.length} documents open`
    });
  } catch (e) {
    checks.push({ name: 'Open documents', status: '❌', detail: String(e) });
  }

  // ... 其余 8 项检查 ...

  return { ranAt: new Date(), checks };
}
```

### 10.3 v2 诊断报告输出

弹出 Markdown 报告 + OutputChannel:

```markdown
# MoA Environment Diagnostics

**运行时间**: 2026-07-21 14:30:15
**VSCode**: 1.95.0
**MoA**: v0.22.0

## 信息源验证

| # | 信息源             | 状态 | 详情                                         |
|---|--------------------|------|----------------------------------------------|
| 1 | Active editor      | ✅   | <active-file-path> (<languageId>, <N> lines) |
| 2 | Open documents     | ✅   | <N> documents open                           |
| 3 | Workspace folders  | ✅   | <N> folder(s): <workspace-root-paths>        |
| 4 | Project tree       | ✅   | <N> entries (depth=6, maxEntries=2000)       |
| 5 | Git root           | ✅   | <git-root-path>                              |
| 6 | Instruction files  | ⚠️   | Found: <file-list>                           |
| 7 | Skill folders      | ✅   | <folder-path>: <N> skills                    |
| 8 | LM tools           | ✅   | <N> tools available                          |
| 9 | LM models          | ✅   | <N> models (<N> vendors)                     |
| 10| Active preset      | ✅   | <current-model-preset-name>                  |
| 11| Active role preset | ✅   | <current-role-setup-preset-name>             |
| 12| MoA entry type     | ✅   | N/A (no active task)                         |

## 警告

- ⚠️ 仅发现 1 个指令文件(workspace CLAUDE.md)。考虑添加 ~/.claude/CLAUDE.md 用于全局指令。
```

### 10.4 v2 端口连通性测试

若 v0.22.0 引入了本地服务(如 webview panel 的 dev server),需测试端口连通性。当前 v2 设计无本地服务(Plan Mode 用 vscode_askQuestions,不用 webview),此节 N/A。

---

## §11. v2 实施优先级与依赖(v3 修订)

| 任务                                    | 优先级 | 依赖                       | 工作量    |
| --------------------------------------- | ------ | -------------------------- | --------- |
| §1 RoleSetupPreset v2 schema            | P0     | 无                         | 0.5 天    |
| §3 Tone 限定系统(7 个 tone)          | P0     | §1                         | 1 天      |
| §8.1 配置存储 + 加载(独立文件,全局持久) | P0     | §1                         | 1 天      |
| §8.2 配置 UI(10 个命令)              | P0     | §8.1                       | 2 天      |
| §2 AI 生成开关(3 层)                  | P0     | §1                         | 0.5 天    |
| §10 端口/工具验证                       | P0     | 无                         | 1 天      |
| §4 Plan Mode 实时报告(v3:仅状态,无 token 估算) | P0     | §2 + planner-system-prompt-v2 | 2-3 天(↓1 天,删除 token 估算) |
| §5 Recon Aggregator 自迭代 + 评分(v3:仅 >1 次时启用阈值) | P0     | 无                         | 1 天(↓0.5 天) |
| §6 用户自定义 few-shot                  | P1     | §1                         | 0.5 天    |
| §7 final.md 主会话展示                  | P1     | 无                         | 1 天      |
| ~~§9.2 内置 5 个预设~~(**v3 删除**)  | —      | —                          | —         |
| §9.2 内置 1 个 `default` 预设(**v3 替代**) | P1     | §1 + §3                    | 0.2 天    |
| **社区分享(v3 提前到 v0.22)**         | P0     | §8.1 + §8.2                | 1 天      |
| §9.1 设计美学指南(本文档)             | P2(文档) | 无                       | 已完成    |
| **v3 总计**                             |        |                            | **12-14 天**(v3 比 v2 减 2-3 天:删除 5 预设/删除 token 估算/简化评分) |

**v1 → v2 → v3 工作量变化**:

- v1 总计:12-14 天
- v2 总计:15-18 天
- **v3 总计:12-14 天**(删 5 预设、删 token 估算、简化 RA 评分,与 v1 持平)

**与原 v0.22.0 路线图的关系**:

本文档任务合并到 [roadmap/v0.22.0-role-injection-overhaul.md](roadmap/v0.22.0-role-injection-overhaul.md),形成 v0.22.0 完整 scope(原 6-10 天 + v3 blueprint 12-14 天 = **18-24 天,约 4 周**)。

---

## §12. v1 → v2 → v3 变更对照表

| 维度                              | v1                                                                              | v2                                                                                                   | v3(最新)                                                                                  |
| --------------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| RoleSetupPreset schema            | 5 子对象(含 refs/aggregator)                                                 | 3 子对象 + planner                                                                                   | **沿用 v2**(3 子对象 + planner)                                                          |
| Tone 类型                         | 自由文本                                                                        | 限定枚举 7 选 1                                                                                      | **沿用 v2**                                                                                |
| Recon Aggregator 整合原则         | "消歧"                                                                          | "识别与保留冲突"                                                                                     | **沿用 v2**                                                                                |
| Recon Aggregator 自迭代上限       | 3 次                                                                            | 10 次                                                                                                | **沿用 v2(10 次),但默认 1 次;仅 >1 次时启用评分阈值 0.85**                              |
| Recon Aggregator 评分             | 未设计                                                                          | 聚合度 + 忠诚度评分                                                                                  | **沿用 v2(评分),但默认不启用(仅 maxIterations > 1 时启用)**                           |
| Few-shot 示例                     | 硬编码在 prompt                                                                | 用户可外部自定义                                                                                     | **沿用 v2**                                                                                |
| final.md 展示                     | 仅链接到文件                                                                    | 分级展示(完整内嵌/摘要/结构化摘要)                                                                 | **沿用 v2**                                                                                |
| Plan Mode 报告角色清单            | 5 角色                                                                          | 3 角色                                                                                               | **沿用 v2**                                                                                |
| Plan Mode 默认 UI                 | 'plan-mode'(隐含)                                                            | 'plan-mode'(明确默认)                                                                              | **沿用 v2**                                                                                |
| **Plan Mode 报告内容**            | (未设计)                                                                      | 含 estimatedCost(token 估算)                                                                       | **删除 estimatedCost,改为 plannerStatus(仅状态)**                                       |
| 用户编辑流程                      | 简要描述                                                                        | 完整流程                                                                                             | **沿用 v2 + JSON 校验失败时显示具体错误 + 保留编辑不强制保存(类似 IDE 红线报错)**         |
| **内置预设数量**                  | 5 个                                                                            | 5 个                                                                                                 | **1 个 `default`**(用户基于它自行修改)                                                   |
| **社区分享功能**                  | v0.23+                                                                          | v0.23+                                                                                               | **提前到 v0.22**(用户原话:"就在这个 22 版本,因为也不牵扯相关的项目与内容")             |
| **JSON schema 校验失败提示**      | 未设计                                                                          | QuickPick 三选项                                                                                     | **简化为"显示具体错误 + 保留编辑"(不强制保存,用户改对再保存)**                          |
| 工作量估算                        | 12-14 天                                                                        | 15-18 天                                                                                             | **12-14 天**(v3 比 v2 减 2-3 天)                                                        |
| 诊断命令                          | 简要提及                                                                        | 完整设计                                                                                             | **沿用 v2**                                                                                |

---

## §13. 开放问题(v3 全部决策完毕)

经 v3 用户确认,所有开放问题已决策:

| # | 问题 | v3 决策 |
|---|------|---------|
| 1 | Role Setup Preset 存储位置 | ✅ **独立文件 `~/.moa/role-setup-presets.json`(全局持久,跨任务/会话)** |
| 2 | Plan Mode 报告 UI | ✅ **vscode_askQuestions**(默认) |
| 3 | Recon Aggregator 评分阈值 | ✅ **默认不启用(仅 maxIterations > 1 时启用,阈值 0.85)** |
| 4 | final.md 内嵌阈值 | ✅ **2000/8000 字符**(可配置) |
| 5 | 内置预设数量 | ✅ **1 个 `default`**(用户基于它自行修改,不再提供 5 个领域示例) |
| 6 | 社区分享功能 | ✅ **提前到 v0.22**(用户原话:"就在这个 22 版本") |
| 7 | CLAUDE.md 含敏感信息 | ✅ **检测 + 警告,不删减**(用户认可默认) |
| 8 | 多 root workspace | ✅ **第一个 root 做 ENV_CONTEXT 主源,instructionFiles 扫描所有 root** |
| 9 | Plan Mode 操作消耗预估 | ✅ **删除,改为仅报告 Planner 当前状态**(用户原话:"不需要 token 消耗,只是报告一下当前 planner 是什么状态") |
| 10 | JSON schema 校验失败提示 | ✅ **简化为"显示具体错误 + 保留编辑不强制保存"**(用户不熟悉原 QuickPick 方案,采用更直观的 IDE 风格) |

**v3 状态**:**所有开放问题已决策,可进入实施阶段**。

---

## §14. 参考资料

### 14.1 本仓库内文档

- [moa-role-customization-blueprint.md](moa-role-customization-blueprint.md) — **v1**(保留)
- [moa-role-injection-design.md](moa-role-injection-design.md) — 注入矩阵主总览
- [moa-role-design-philosophy-v2.md](moa-role-design-philosophy-v2.md) — 设计哲学 v2(本文档配套)
- [planner-system-prompt-v2.md](planner-system-prompt-v2.md) — Planner 提示词 v2(本文档配套)
- [planner-system-prompt.md](planner-system-prompt.md) — Planner 提示词 v1(few-shot fallback 源)
- [copilot-system-message-sections.md](copilot-system-message-sections.md) — Copilot 12 sections 参考
- [roadmap/v0.22.0-role-injection-overhaul.md](roadmap/v0.22.0-role-injection-overhaul.md) — 路线图(本文档任务合并入此)

### 14.2 源码参考

- [`src/presetConfig.ts`](../src/presetConfig.ts) — 现有模型预设(Role Setup Preset 借鉴其结构)
- [`src/moaHandler.ts`](../src/moaHandler.ts) — Chat 请求入口(final.md 展示改造点)
- [`src/moaCore/runRecon.ts`](../src/moaCore/runRecon.ts) — Recon Aggregator 实现(自迭代 + 评分改造点)

### 14.3 外部参考

- `C:\Users\Administrator\AppData\Roaming\Code\User\globalStorage\github.copilot-chat\plan-agent\Plan.agent.md` — Copilot Plan Agent(启发源,不照搬)
