# MoA 角色设计哲学 v2 — 6 角色流水线 + 用户主权

> 日期:2026-07-21(v2)
> 适用版本:MoA v0.22.0(6 角色架构 + 用户主权)
> **版本演进**:
> - **v1**(保留):[moa-role-design-philosophy.md](moa-role-design-philosophy.md) — 初版哲学
> - **v2**(本文档):基于用户第三轮反馈,主要变化:
>   1. 强化"用户主权"为顶层哲学(vscode 中长出的个人化檞寄生)
>   2. Refs/Aggregator 从"轻提示 hint" → "完全不可定制"(架构红线强化)
>   3. tone 限定为 7 个枚举(不再自由文本)
>   4. Recon Aggregator 自迭代扩展为 1-10 次 + 聚合度/忠诚度评分
>   5. "消歧" → "识别与保留冲突"(冲突是 Refs 分析的重要来源)
>   6. 新增"用户主权 vs AI 辅助"轴心(详见 §3.4)
>   7. 长期 memory 重新定义为"Role Setup Preset"(用户自定义角色设定)
> 关联:
> - [moa-role-injection-design.md](moa-role-injection-design.md) §4 — 注入矩阵
> - [planner-system-prompt-v2.md](planner-system-prompt-v2.md) — Planner 提示词 v2
> - [moa-role-customization-blueprint.md](moa-role-customization-blueprint.md) — 用户自定义蓝图
> 状态:**设计文档 v2**

---

## §0. TL;DR — 6 角色一句话定位(v2)

| 角色                    | 一句话定位                                                                                  | 类比                    | 可定制?                 |
| ----------------------- | ------------------------------------------------------------------------------------------- | ----------------------- | ----------------------- |
| **Planner**             | 智能路由 + 角色设计师:消化工作环境,为下游 3 角色定制身份(Refs/Aggregator 不可定制)       | 作战参谋长              | tone/prompt 用户可自定义 |
| **Recon**               | 多实例并行证据收集者:按 Planner 设计的身份独立调工具                                        | 侦察兵(多个,独立行动) | ✅ Planner 定制 + 用户预设 |
| **Recon Aggregator**    | 证据清洁工:始终运行,标准化多 Recon 的原始产出,**识别与保留冲突**(不强行消歧)           | 侦查大队长              | ✅ Planner 定制 + 用户预设 |
| **Refs**                | 多模型并行分析者:**完全相同** 的固定设定,看同一份证据,输出独立判断                          | 参谋联席会              | ❌ 完全固定(架构红线) |
| **Aggregator**          | 中立裁判:综合 N 个 Refs,决策 next_action(finalize / actor_needed / recon_needed)          | 司令                    | ❌ 完全固定(架构红线) |
| **Actor**               | 执行者:全工具权限,严格按 action_items 顺序执行                                             | 工兵                    | ✅ Planner 定制 + 用户预设 |

---

## §1. v2 顶层哲学:**VSCode 中长出的个人化檞寄生**

> 用户原话:"这一大版本就是一个风味与个性化的强力设定,就是在 vscode 当中长出来的一个个人 MOA 檞寄生。"

### 1.1 檞寄生哲学(Mistletoe Philosophy)

**檞寄生**是一种附生植物,长在宿主树上,但不取代宿主,而是与之共生。MoA v0.22 的设计目标:

| 宿主(VSCode)提供              | 檞寄生(MoA)提供                                                |
| ------------------------------ | ----------------------------------------------------------------- |
| 编辑器、终端、Chat UI           | 多角色智能体流水线                                                |
| 文件系统、workspace 概念        | ENV_CONTEXT 注入                                                  |
| 模型市场(GCMP/Copilot)       | 模型预设(Planner/Recon/Refs/Aggregator/Actor 各自选模)         |
| Skills/MCP/Agent 生态           | skill 扫描与推荐                                                  |
| Settings/Configuration 系统     | Role Setup Preset(用户自定义角色风味)                          |

**关键**:MoA **不重造轮子**,而是充分利用 VSCode 已有的能力(模型市场、工具生态、配置系统),在其之上长出一个"个性化多角色智能体"。

### 1.2 用户主权(User Sovereignty)

v2 强化的核心原则:**用户对每个角色的最终设定权**。

| 层级 | 控制方                              | 控制内容                                                       |
| ---- | ----------------------------------- | -------------------------------------------------------------- |
| 1    | **用户**(最高优先级)             | Role Setup Preset(tone/perspective/tool_priority/customPrompt)|
| 2    | **Planner**(AI 辅助)              | role_setup 字段(用户允许时才采纳)                           |
| 3    | **MoA 默认**(兜底)               | 内置 1 个 `default` 预设(空 fields,全 fallback)+ 静态 prompt fallback |

**决策流程**:

```
用户启动 MoA 任务
  ↓
检查用户 Role Setup Preset 是否覆盖该角色
  ├─ 是 → 使用用户预设(完全跳过 Planner 的 role_setup)
  └─ 否 → 检查 AI 生成开关
      ├─ enabled=false → 用 MoA 默认 prompt
      └─ enabled=true → Planner 生成 role_setup
          ├─ autoAccept=true → 直接使用 Planner 生成
          └─ autoAccept=false → Plan Mode 报告,用户确认
```

---

## §2. 角色间信息流(v2 完整数据流图)

```
                    ┌─────────────────────────────────────────────┐
                    │  外部输入(动态注入,每次任务构建一次)      │
                    │  ENV_CONTEXT + TOOL_EFFICIENCY              │
                    │  + CUSTOM_INSTRUCTIONS + RUNTIME_INSTRUCTIONS│
                    │  + MOA_ENTRY_TYPE(新增)                  │
                    └────────────────────┬────────────────────────┘
                                         │
                                         ▼
        ┌────────────────────────────────────────────────────────────┐
        │  [Planner] mini-loop (默认 5 次,最大 20 次)              │
        │    iter 1+: 可调 read-only 工具 + web_search(概念澄清)    │
        │    收敛判据: plan_coverage >= 0.9 / ask_user / 强制       │
        └────────────────────┬───────────────────────────────────────┘
                             │
                             ▼ (若 aiGeneration.enabled + !autoAccept)
        ┌────────────────────────────────────────────────────────────┐
        │  Plan Mode 报告(vscode_askQuestions,用户确认)           │
        │    显示: clarified_task + sub_questions + role_setup 摘要  │
        │    显示: plan_coverage 收敛曲线 + Planner 当前状态        │
        │    (v3 修订:删除"操作消耗预估",用户不需要 token 估算)  │
        │    用户选择: 采纳 / 编辑 Role Setup / 切换 Preset / 再迭代│
        └────────────────────┬───────────────────────────────────────┘
                             │
        ┌────────────────────┴──────────────────────────────────────┐
        │  PlannerOutput (v2 schema: 3 子对象,删除 refs/aggregator) │
        │  - clarified_task + sub_questions + recon_hints             │
        │  - role_setup × 3 (recon/recon_agg/actor)                   │
        │  - process_language (决定全流程语言)                        │
        │  - difficulty + task_type + needs_iteration(受入口影响)   │
        └────────────────────┬───────────────────────────────────────┘
                             │
              ┌──────────────┴───────────────┐
              │                              │
              ▼                              ▼
   ┌─────────────────────┐      ┌─────────────────────┐
   │  ENV_CONTEXT +      │      │  role_setup.recon   │
   │  TOOL_EFFICIENCY +  │      │  (tone 限定枚举/    │
   │  CUSTOM_INSTRUCTIONS│      │   perspective/      │
   │  + RUNTIME_INSTR    │      │   tool_priority 排序│
   │  (与 Planner 同源)  │      │   /cautions)        │
   └──────────┬──────────┘      └──────────┬──────────┘
              │                            │
              └────────────┬───────────────┘
                           │
                           ▼
        ┌──────────────────────────────────────────────────┐
        │  Recon fan-out(N 个并行,不同模型)            │
        │  每个 Recon 看:Planner 的 sub_questions +        │
        │                Aggregator 的 gaps(后续轮)+      │
        │                role_setup.recon +                 │
        │                ENV_CONTEXT 等 4 段注入            │
        │  每个 Recon 跑独立的 agent loop(工具调用)      │
        └────────────────────┬─────────────────────────────┘
                             │
                             ▼
        ┌──────────────────────────────────────────────────┐
        │  N 份原始 ReconResult(label + summary + log)    │
        │  落盘到 .moa_cache/<task_id>/iteration_N/recon/   │
        │  (即使只有 1 个 Recon 也落盘,便于复盘)         │
        └────────────────────┬─────────────────────────────┘
                             │
                             ▼
        ┌──────────────────────────────────────────────────┐
        │  [Recon Aggregator](始终运行,纯 LLM,无工具)   │
        │  输入:N 份原始 ReconResult + role_setup.recon_agg│
        │  输出:统一的 merged.summary(标准化整合)        │
        │  职责:去重 / 排序 / 识别与保留冲突 / 缺口识别  │
        │  自迭代:1-10 次(v2 扩展)                     │
        │  评分:聚合度 + 忠诚度(v2 新增)              │
        └────────────────────┬─────────────────────────────┘
                             │
                             ▼
        ┌──────────────────────────────────────────────────┐
        │  merged ReconResult 推入 evidence 池              │
        │  (Refs 看到的是标准化后的,不是原始的)          │
        └────────────────────┬─────────────────────────────┘
                             │
                             ▼
        ┌──────────────────────────────────────────────────┐
        │  Refs fan-out(N 个并行,不同模型)              │
        │  每个 Ref 看:完全相同的 evidence + synthesis +   │
        │              gaps(v2: 无 role_setup.refs)       │
        │  **故意无 ENV_CONTEXT 等注入**                    │
        │  **故意用固定设定**(保证多模型可比性)          │
        │  **v2 强化:完全无 role_setup**(连 hint 都没有) │
        └────────────────────┬─────────────────────────────┘
                             │
                             ▼
        ┌──────────────────────────────────────────────────┐
        │  [Aggregator](1 个,完全固定,中立裁判)        │
        │  输入:N 个 Refs 输出 + evidence(v2: 无 hint)   │
        │  输出:synthesis + evidence_coverage + next_action│
        │  决策:finalize / actor_needed / recon_needed    │
        └─────────┬───────────────────────┬────────────────┘
                  │                       │
                  ▼                       ▼
   next_action=actor_needed    next_action=recon_needed
                  │                       │
                  ▼                       ▼
        ┌────────────────────┐   回到 Recon(下一轮 iteration)
        │  [Actor](1 个)    │   (Aggregator 的 gaps 注入新 Recon)
        │  全工具权限        │
        │  看:action_items  │
        │  + role_setup.actor│
        │  + ENV_CONTEXT 等  │
        │  (与 Planner 同源)│
        └─────────┬──────────┘
                  │
                  ▼
        ┌────────────────────┐
        │  ActorResult       │
        │  推回 evidence 池  │
        │  (下一轮 Recon /   │
        │   Refs 能看到)     │
        └────────────────────┘
                  │
                  ▼
        最终 finalize → final.md
                  │
                  ▼
        ┌──────────────────────────────────────────────────┐
        │  v2 新增:Final.md 主会话内分级展示              │
        │  - < 2000 字符:完整内嵌                         │
        │  - 2000-8000:摘要 + 关键信息内嵌                │
        │  - > 8000:结构化摘要 + 链接到 final.md          │
        │  目的:关键信息进上下文,下一轮对话直接可引用   │
        └──────────────────────────────────────────────────┘
```

---

## §3. 四大设计原则(v2 从 3 → 4)

### 3.1 原则 1:基础设施层 vs 角色身份层 vs 迭代状态层(三层分离)

详见 v1 [moa-role-design-philosophy.md](moa-role-design-philosophy.md) §3.1,v2 无变化。

### 3.2 原则 2:定向不限定(打猎哲学)

详见 v1 [moa-role-design-philosophy.md](moa-role-design-philosophy.md) §3.2,v2 强化"工具太多时排序而非拆分":

**v2 强化**(用户原话:"工具太多时,我禁止拆分,而是让识别后排序,以便于分别提供给 recon 与 actor"):

- 工具数 100+ 时,**不拆分**(v1 是拆分)
- 识别所有相关工具 → 按相关性排序 → 完整列表给 recon
- 独立识别 → 独立排序 → 完整列表给 actor(两者排序可以不同)
- 让 Recon 和 Actor 自己根据现场决定用哪些

### 3.3 原则 3:固定设定 vs 可定制(v2 强化架构红线)

**v1**:`Refs` 和 `Aggregator` 是固定设定,但 Planner 可以给 `hint`(一句话提示)
**v2**:**完全删除** `hint`,Refs 和 Aggregator **完全不可定制**

**v2 强化理由**(用户原话):

> "由于我之前删掉了对于 refs 与 aggregator 的设定,但在第五部分:输出 schema 当中还有相关的内容,那关于 hint 是否还有必要保留?"

用户的判断:既然 Refs/Aggregator 的可定制字段是"无",那 hint 也不应该存在(否则 schema 自相矛盾)。

**v2 红线**:

- ❌ Planner 输出 `role_setup.refs` 字段 → JSON schema 校验失败
- ❌ Planner 输出 `role_setup.aggregator` 字段 → JSON schema 校验失败
- ✅ Planner 只能定制 `role_setup.recon` / `role_setup.recon_aggregator` / `role_setup.actor`

**为什么这么严格**:

- Refs 的价值在**多模型可比性**:任何 prompt 差异都会污染模型对比
- Aggregator 的价值在**中立裁判**:任何 prompt 差异都会引入偏见
- 即使是"一句话 hint",也可能让某个 Ref 关注 X 而另一个 Ref 不关注 X,破坏可比性
- v1 的 hint 是"软提示",但软提示也是提示,v2 彻底删除

### 3.4 原则 4:用户主权 vs AI 辅助(v2 新增,顶层原则)

**v2 顶层原则**:用户对角色设定的控制权 > Planner 的 AI 生成权 > MoA 默认值。

详见 [moa-role-customization-blueprint.md](moa-role-customization-blueprint.md) §0 / §2。本节摘要:

**三层优先级**:

1. **用户 Role Setup Preset**(最高):用户预先配置,完全覆盖
2. **Planner AI 生成**(中):Planner mini-loop 产出,需用户确认
3. **MoA 默认**(最低):兜底静态 prompt

**AI 生成的开关机制**:

| 开关                          | 默认   | 含义                                             |
| ----------------------------- | ------ | ------------------------------------------------ |
| `aiGeneration.enabled`        | true   | Planner 是否被允许生成 role_setup                |
| `aiGeneration.autoAccept`     | false  | 是否自动采纳(默认 false,需 Plan Mode 确认)   |
| `aiGeneration.confirmationUI` | 'plan-mode' | 确认 UI 类型(plan-mode/diff-view/quick-pick) |

---

## §4. Recon Aggregator 的特殊地位(v2 强化)

### 4.1 为什么 Recon Aggregator 必须始终运行(v1 观点 + v2 强化)

详见 v1 [moa-role-design-philosophy.md](moa-role-design-philosophy.md) §4.1。

### 4.2 Recon Aggregator 的整合原则(v2 关键变化)

**v1**:"去重 / 排序 / **消歧** / 识别冲突"
**v2**:"去重 / 排序 / **识别与保留冲突**"

**v2 变化理由**(用户原话):

> "对于提示词 `统一证据清洁度,去重 / 排序 / 消歧 / 识别冲突` 改为了 `统一证据清洁度,去重 / 排序 /识别与保留冲突`,因为我认为歧义,反而是多个 ref 判断与分析的重要来源。"

**v2 设计哲学**:

- **消歧是错的**:强行消除歧义会丢失信息,而歧义本身可能是真相的多面性体现
- **冲突要保留**:多 Recon 间的冲突是 Refs 分析的重要素材(Refs 可以判断哪个更可信)
- **质量分级更重要**:每条证据标注 confidence(high/medium/low),让 Refs 自己加权

**v2 整合原则**:

```
1. **完整无偏差**:去重但不删减,保留所有数字 / 引用 / 关键句
2. **识别与保留冲突**:多 Recon 间说法不一致时,**保留两边** + 标注 "[冲突] A vs B"
3. **缺口识别**:多个 Recon 都没覆盖的主题,显式列出 "[缺口] X 主题未查"
4. **质量分级**:每条证据标注 [high / medium / low] confidence(基于来源权威性)
5. **分类归并**:按"数据 / 文献 / 技术 / 其他"分类,不要混在一起
```

### 4.3 Recon Aggregator 的自迭代(v2 扩展)

**v1**:默认 1 次,最大 3 次
**v2**:默认 1 次,**最大 10 次**(用户原话:"开放权限到 10 次")

**v2 评分机制**(用户新增要求):

> "并且总的让 Recon Aggregator 给出一个聚合度与忠诚度的评分。"

```typescript
interface ReconAggregatorOutput {
  summary: string;
  crossReconGaps: string[];

  // v2 新增
  aggregationScore: number;     // 聚合度 0-1:信息整合完整度
  fidelityScore: number;        // 忠诚度 0-1:对原始证据的忠实程度
  needsReiteration: boolean;    // 是否需要再迭代
  iterationsCompleted: number;  // 实际迭代次数
}
```

**评分语义**:

- **聚合度(Aggregation)**:0.9+ = 完整覆盖,0.7-0.9 = 大部分覆盖,0.5-0.7 = 明显遗漏,< 0.5 = 严重遗漏
- **忠诚度(Fidelity)**:0.9+ = 完全忠实,0.7-0.9 = 基本忠实,0.5-0.7 = 有歪曲,< 0.5 = 严重歪曲

**收敛逻辑**:

- `convergenceMode = 'score-threshold'`(默认):两个评分均 ≥ 0.85 时收敛
- `convergenceMode = 'fixed-iterations'`:固定跑 maxIterations 次

详见 [moa-role-customization-blueprint.md](moa-role-customization-blueprint.md) §5。

### 4.4 Recon Aggregator 的双轨制角色设定(v1 观点 + v2 路径明确)

**v1**:默认静态 prompt / Planner 驱动(描述了两种模式)
**v2**:明确"默认开,用户可关"的开关路径

| 模式              | role_setup.recon_aggregator 来源                  | 配置项                                  | v2 默认 |
| ----------------- | ------------------------------------------------- | --------------------------------------- | ------- |
| **默认静态**      | 内置 `buildReconAggregatorPrompt`(硬编码)       | `moa.reconAggregatorMode = "default"`   | ✅      |
| **Planner 驱动**  | Planner 在 mini-loop 中产出                       | `moa.reconAggregatorMode = "planner"`   |         |

**用户原话**:

> "对于 recon_aggregator 的角色设定,我认为可以先默认有一个提示词,然后关闭这个选项,让其让 planner 给提供角色。"

**v2 解读**:

- "先默认有一个提示词" → 默认模式(内置静态)
- "关闭这个选项" → 用户可关闭默认模式
- "让其让 planner 给提供角色" → 切换到 Planner 驱动模式

---

## §5. Planner 的智能路由角色(v2 强化)

### 5.1 v1 vs v2 Planner 对比

| 维度              | v1 Planner                          | v2 Planner                                              |
| ----------------- | ----------------------------------- | ------------------------------------------------------- |
| 调用次数          | 1-20 次                             | 1-20 次(不变)                                         |
| 工具权限          | iter 2+ 可调                        | **iter 1+ 可调**(含 web_search 概念澄清)             |
| 可定制角色数      | 5 个(recon/recon_agg/refs/agg/actor) | **3 个**(recon/recon_agg/actor,删除 refs/agg)      |
| 入口类型感知      | 无                                  | **新增** `${MOA_ENTRY_TYPE}` 注入                       |
| Plan Mode 报告    | 未设计                              | **新增**(借鉴 Copilot Plan agent)                     |
| ask_user 默认     | false                               | false(不变,但最小打扰原则强化)                       |
| needs_replan 默认 | false                               | **true**(自迭代是核心能力)                            |
| tone              | 自由文本                            | **限定枚举 7 选 1**                                    |
| few-shot          | 硬编码                              | **用户可外部自定义**                                    |
| 任务适配          | 固定模板                            | **agent 化**(灵活判断)                                |

### 5.2 v2 核心创新:Plan Mode 实时报告

详见 [planner-system-prompt-v2.md](planner-system-prompt-v2.md) §4 + [moa-role-customization-blueprint.md](moa-role-customization-blueprint.md) §4。

**v2 Plan Mode 与 Copilot Plan Agent 的关系**:

| Copilot Plan Agent      | MoA Planner v2 Plan Mode                            |
| ----------------------- | --------------------------------------------------- |
| 4 阶段(Discovery/Alignment/Design/Refinement) | Planner mini-loop 已涵盖(不分阶段)         |
| searchSubagent 并行     | 不需要(Recon 才是并行搜索者)                     |
| askQuestions 澄清       | ✅ 借鉴(ask_user 机制)                            |
| 必须显示 plan 给用户    | ✅ 借鉴(Plan Mode 报告)                           |
| handoffs 按钮           | ✅ 借鉴(vscode_askQuestions 选项)                |
| 持久化到 /memories/session/plan.md | ❌ 不照搬(MoA 用 .moa_cache/<task_id>/planner/) |

**用户原话**:

> "你查看一下 [Plan.agent.md] 然后结合 moa 的形式,更新与迭代一下你写的 planner 角色,**必须要以我们的 MOA 流程为主干,这个 copilot 只是启发性质的**。"

### 5.3 v2 强化:needs_iteration 受入口类型影响

**v1**:仅看任务复杂度
**v2**:**任务复杂度 + MoA 入口类型**综合(用户原话:"那么这个 needs_iteration 决策 是否就要强制根据 moa 的参数与选项而决定?")

| 入口                | needs_iteration 默认                             |
| ------------------- | ------------------------------------------------ |
| `@moa`/`@moaloop`   | **true**(用户选 loop = 想要多轮)               |
| `@moasingle`        | **false**(单次模式)                            |
| `moa_analyze`       | **false**(单次分析)                            |
| `moa_orchestrate`   | **true**(loop 模式)                            |

---

## §6. Tone 限定系统(v2 新增)

> 用户原话:"tone 应该要限定,与当前工作流适配。"

**v1**:tone 是自由文本(例:"严谨的证据收集者")
**v2**:tone 是**限定枚举**(7 选 1)

**为什么限定**:

- **可比较**:用户切换预设时,tone 含义一致
- **可测试**:每个 tone 对应确定性 prompt 片段
- **防越界**:避免"激进到失控"的 tone
- **可国际化**:每个 tone 中英文双语标签

**7 个 tone**(详见 [moa-role-customization-blueprint.md](moa-role-customization-blueprint.md) §3):

| tone ID             | 中文标签     | 默认角色                |
| ------------------- | ------------ | ----------------------- |
| `strict-evidence`   | 严谨证据     | Recon                   |
| `faithful-integrator` | 忠实整合   | Recon Aggregator        |
| `neutral-judge`     | 中立裁判     | Aggregator(固定)     |
| `strict-executor`   | 严格执行     | Actor                   |
| `creative-explorer` | 创造探索     | Refs(可选)/Recon(可选)|
| `conservative`      | 保守模式     | Actor(可选)          |
| `aggressive`        | 激进模式     | Actor(可选,危险)    |

---

## §7. 长期 memory = Role Setup Preset(v2 重新定义)

> 用户原话:"所谓的长期 memory,也就是 moa 角色的设定,我认为也可以有类似于 moa 模型选择的建构方式。"

**v2 重新定义**:MoA 的"长期 memory"不是对话历史,而是 **Role Setup Preset**(用户预先配置的角色设定)。

**实现**:

- 存储位置:`~/.moa/role-setup-presets.json`(跨会话持久)
- 结构:类似 ModelPreset,但每个角色有完整 prompt 设定
- 用户操作:创建/切换/编辑/导出/导入(8 个 VSCode 命令)
- 内置预设:**1 个 `default`**(v3 修订:从 5 个缩为 1 个,空 fields 全 fallback,用户基于它自行修改)

**与对话历史的关系**:

| 项          | 对话历史(short-term)       | Role Setup Preset(long-term memory) |
| ----------- | --------------------------- | ------------------------------------ |
| 范围        | 单次任务                    | 跨任务、跨会话                       |
| 内容        | Recon 摘要 / Refs 输出 / Actor 日志 | 6 角色的 prompt 风味设定             |
| 持久性      | `.moa_cache/<task_id>/`(任务级) | `~/.moa/role-setup-presets.json`(全局) |
| 用户控制    | 自动                       | 手动 + 可分享                        |

详见 [moa-role-customization-blueprint.md](moa-role-customization-blueprint.md) §1 / §6。

---

## §8. 与 Copilot 系统消息的对照(v2 强化)

| 维度             | Copilot                                                       | MoA v0.22 v2                                                                                |
| ---------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| **身份来源**     | Cloud 渲染的固定 preamble("你是 GitHub Copilot")            | Planner 动态产出(每个角色独立 role_setup)或用户预设(主权优先)                          |
| **tone 控制**    | VSCode 扩展 prompt-tsx 按模型族硬编码                        | **限定枚举 7 选 1**(v2)+ 用户预设覆盖                                                     |
| **工具能力**     | Cloud 拼装 tool_instructions                                 | 靠 `vscode.lm.tools[].description` 让 LLM 自读                                             |
| **用户指令**     | 静态读取 CLAUDE.md/AGENTS.md                                 | Planner 消化后通过 role_setup 传递(避免 token 爆炸)                                        |
| **skill 发现**   | 运行时拼装 skill 清单                                         | Planner 按任务相关性筛选推荐(100+ 时排序不拆分)                                          |
| **安全策略**     | Microsoft 条款 + 版权保护                                    | 不拼(由 Recon read-only + Actor Approval Gate 保证)                                        |
| **迭代控制**     | last_instructions 里"parallel tool calling"                  | MoA 自己的 saturated/stagnant/capped + plan_coverage                                         |
| **决策链**       | 单 agent 自己决策                                            | Planner→Recon→RA→Refs→Aggregator→Actor 六角色分工                                           |
| **流程语言**     | VSCode locale 决定                                           | Planner 根据用户提问语言决定                                                                |
| **用户主权**     | 用户只能通过 settings.json 配置                              | **Role Setup Preset**(类似模型预设,完整角色设定可分享)                                  |
| **Plan Mode**    | Copilot Plan agent(独立 chat mode)                        | **Plan Mode 报告**(借鉴 Copilot,但 MoA 主干)                                             |

---

## §9. 与其他多智能体框架的对照(v2)

| 框架              | 角色数       | 角色身份来源                | 用户主权                              | MoA v0.22 v2 相对优势                                      |
| ----------------- | ------------ | --------------------------- | ------------------------------------- | ---------------------------------------------------------- |
| **AutoGen v0.4**  | 用户定义     | 代码硬编码                  | 仅配置层                              | MoA 有 Role Setup Preset + 用户主权顶层原则                |
| **CrewAI**        | 用户定义     | YAML 静态配置               | YAML 配置                             | MoA 有 Plan Mode 报告(动态 AI 生成)                     |
| **LangGraph**     | 节点(用户定)| 代码硬编码                  | 仅代码层                              | MoA 有 tone 限定枚举 + 内置预设                            |
| **OpenAI Swarm**  | agents list  | 代码硬编码                  | 仅配置层                              | MoA 有 Refs/Aggregator 完全固定 + Recon Aggregator 评分    |
| **Hermes MoA**    | 5(固定)    | 硬编码                      | 无                                    | MoA 增加了用户主权 + Plan Mode + Recon Aggregator 评分     |
| **MoA v0.22 v2**  | 6(固定)    | **三层**(用户预设/AI/默认)| **顶层原则**                          | —                                                          |

---

## §10. 实施路线(v2 分阶段)

### 阶段 1:v0.22.0 核心改造(3-4 周,v2 扩展自 v1)

- [ ] 重写 `buildPlannerPrompt` 支持 [planner-system-prompt-v2.md](planner-system-prompt-v2.md) §1 完整模板
- [ ] 实现 `src/systemContext.ts`(4 段动态注入 + 入口类型注入)
- [ ] 实现 `src/instructionScanner.ts`(7 路径 + 4 文件夹扫描,**不截断**)
- [ ] 实现 `src/moaCore/runPlanner.ts` mini-loop(默认 5 次,最大 20 次,plan_coverage 0.9 收敛 + ask_user)
- [ ] 让 Recon Aggregator 始终运行 + 自迭代(1-10 次)+ 评分(聚合度 + 忠诚度)
- [ ] Recon Aggregator 双轨制(默认静态 / Planner 驱动)
- [ ] Recon / Actor 注入完整基础设施层
- [ ] 实现 `src/roleSetupPreset.ts`(Role Setup Preset 加载/保存/切换)
- [ ] 实现 Plan Mode 报告(vscode_askQuestions)
- [ ] 实现 final.md 主会话分级展示(详见 [moa-role-customization-blueprint.md](moa-role-customization-blueprint.md) §7)
- [ ] `package.json` 新增配置项(15+ 项,详见 [roadmap/v0.22.0-role-injection-overhaul.md](roadmap/v0.22.0-role-injection-overhaul.md))
- [ ] 实现 `moa.diagnoseEnvironment` 命令(端口/工具验证)

### 阶段 2:v0.22.1 观测性与调优(1 周)

- [ ] `.moa_cache` 新增 `planner/` 子目录,记录 mini-loop 每轮中间结果
- [ ] VSCode output channel 增加 Planner 迭代日志
- [ ] 配置面板可视化 plan_coverage 收敛曲线 + Recon Aggregator 评分曲线
- [ ] 用户反馈收集 → 调优默认 plan_coverage 阈值 / mini-loop 次数 / 评分阈值

### 阶段 3:v0.23+(未来)

- 持久记忆系统接入(Planner 可读取历史任务)
- 跨任务学习(Planner 记住"上次给这类任务的 role_setup 管用")
- 多模态(ENV_CONTEXT 含图像 / 截图)
- 主动 skill 推荐(基于历史使用频率)
- 社区预设市场(vsx 文件包含 Role Setup Preset)

---

## §11. v1 → v2 变更对照表

| 维度                              | v1                                                                              | v2                                                                                                   |
| --------------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 顶层哲学                          | 三大设计原则(三层分离/打猎哲学/固定vs可定制)                                  | **四大设计原则**(新增"用户主权 vs AI 辅助")                                                         |
| Refs/Aggregator 可定制字段        | `hint`(一句话提示)                                                           | **完全无**(架构红线强化:连 hint 都删除)                                                           |
| tone                              | 自由文本                                                                        | **限定枚举 7 选 1**                                                                                  |
| Recon Aggregator 整合原则         | "消歧 / 识别冲突"                                                               | **"识别与保留冲突"**(歧义是 Refs 分析素材)                                                          |
| Recon Aggregator 自迭代           | 默认 1 次,最大 3 次                                                            | **默认 1 次,最大 10 次 + 聚合度/忠诚度评分**                                                        |
| 长期 memory 定义                  | 持久记忆系统(留待 v0.23+)                                                    | **Role Setup Preset**(用户自定义角色设定,本版本实现)                                               |
| 工具太多时                        | 拆分                                                                            | **识别后排序**(分别给 Recon 和 Actor,各自独立排序)                                                |
| 任务适配                          | 固定模板                                                                        | **agent 化**(灵活判断)                                                                              |
| needs_iteration 决策              | 仅看任务复杂度                                                                  | **任务复杂度 + MoA 入口类型**综合                                                                    |
| few-shot 示例                     | 硬编码                                                                          | **用户可外部自定义**                                                                                 |
| 工具使用权限                      | 仅 iter 2+                                                                      | **iter 1+ 开放**(含 web_search 概念澄清)                                                            |
| 默认值 needs_replan               | false                                                                           | **true**                                                                                             |
| Plan Mode 报告                    | 未设计                                                                          | **新增**(借鉴 Copilot Plan agent)                                                                  |
| final.md 展示                     | 仅链接到文件                                                                    | **分级展示**(完整内嵌/摘要/结构化摘要)                                                              |
| 入口类型感知                      | 未设计                                                                          | **新增** `${MOA_ENTRY_TYPE}`                                                                         |
| 用户主权                          | 隐含                                                                            | **顶层原则**(三层优先级:用户预设 > AI 生成 > 默认)                                                |

---

## §12. 开放问题(v2 更新)

v1 的开放问题已大部分决策,v2 剩余:

1. **Role Setup Preset 存储位置**:`~/.moa/role-setup-presets.json`(独立文件)vs VSCode settings.json?(默认:独立文件)
2. **Plan Mode 报告是 vscode_askQuestions 还是 Webview**?(默认:vscode_askQuestions,更轻量)
3. **Recon Aggregator 评分阈值**(0.85)?(默认:0.85,可配置)
4. **final.md 内嵌阈值**(2000/8000 字符)?(默认:是)
5. **内置预设数量**:v3 修订为**只留 1 个 `default`**(空 fields 全 fallback,用户基于它自行修改;不再提供 strict-researcher / quick-coder / creative-explorer / conservative-mode / auto-pilot 等"领域示例")
6. **是否支持预设分享到社区**(v0.22.0 或 v0.23+)?(默认:v0.23+)
7. **CLAUDE.md 含敏感信息**(API key)怎么办?(默认:检测 + 警告,不删减)
8. **多 root workspace** 的 ENV_CONTEXT 取哪个?(默认:第一个 root,instructionFiles 扫描所有)

---

## §13. 参考资料

### 13.1 本仓库内文档(v0.22.0 设计套件)

- [moa-role-design-philosophy.md](moa-role-design-philosophy.md) — **v1**(保留)
- [planner-system-prompt.md](planner-system-prompt.md) — Planner 提示词 **v1**(保留)
- [planner-system-prompt-v2.md](planner-system-prompt-v2.md) — Planner 提示词 **v2**(本文档配套)
- [moa-role-customization-blueprint.md](moa-role-customization-blueprint.md) — 用户自定义蓝图 **v1**(保留)
- [moa-role-customization-blueprint-v2.md](moa-role-customization-blueprint-v2.md) — 用户自定义蓝图 **v2**(本文档配套)
- [moa-role-injection-design.md](moa-role-injection-design.md) — 注入矩阵主总览
- [copilot-system-message-sections.md](copilot-system-message-sections.md) — Copilot 12 sections 参考
- [ARCHITECTURE.md](ARCHITECTURE.md) — MoA 现有架构文档
- [roadmap/v0.22.0-role-injection-overhaul.md](roadmap/v0.22.0-role-injection-overhaul.md) — v0.22.0 详细路线图
- [roadmap/long-term-roadmap.md](roadmap/long-term-roadmap.md) — 长期路线图

### 13.2 源码参考

- [`src/moaCore/roles.ts`](../src/moaCore/roles.ts) — 当前 5 角色 prompt builder 源码
- [`src/moaCore/runPlanner.ts`](../src/moaCore/runPlanner.ts) — 当前 Planner(单次调用,v0.22 重写)
- [`src/moaCore/runRecon.ts`](../src/moaCore/runRecon.ts) — 当前 Recon + Recon Aggregator(v0.18.0 已实现)
- [`src/workspaceContext.ts`](../src/workspaceContext.ts) — 当前 environment_context 实现(有 dead code bug)
- [`src/presetConfig.ts`](../src/presetConfig.ts) — 当前模型预设(Role Setup Preset 借鉴其结构)

### 13.3 外部参考

- `C:\Users\Administrator\AppData\Roaming\Code\User\globalStorage\github.copilot-chat\plan-agent\Plan.agent.md` — Copilot Plan Agent(启发源)
- VSCode Copilot 扩展 prompt-tsx 源码:`microsoft/vscode/extensions/copilot/src/platform/prompts/`
- Hermes MoA 论文与开源实现
- AutoGen v0.4 / CrewAI / LangGraph / OpenAI Swarm 文档
