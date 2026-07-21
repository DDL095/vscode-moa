# MoA 角色设计哲学 — 6 角色流水线的理论根基

> 日期:2026-07-21
> 适用版本:MoA v0.22.0(6 角色架构)
> 关联:[moa-role-injection-design.md](moa-role-injection-design.md) §4 — 注入矩阵
> 关联:[planner-system-prompt.md](planner-system-prompt.md) — Planner 完整提示词
> 状态:**设计文档**(不是用户手册,是给开发者和设计思考者看的"为什么这么设计")

---

## §0. TL;DR — 6 角色一句话定位

| 角色                    | 一句话定位                                                                                  | 类比                    |
| ----------------------- | ------------------------------------------------------------------------------------------- | ----------------------- |
| **Planner**             | 智能路由 + 角色设计师:消化工作环境,为下游 5 角色定制身份                                    | 作战参谋长              |
| **Recon**               | 多实例并行证据收集者:按 Planner 设计的身份独立调工具                                        | 侦察兵(多个,独立行动) |
| **Recon Aggregator**    | 证据清洁工:始终运行,标准化多 Recon 的原始产出,统一证据质量                                | 侦查大队长              |
| **Refs**                | 多模型并行分析者:**完全相同** 的固定设定,看同一份证据,输出独立判断                          | 参谋联席会              |
| **Aggregator**          | 中立裁判:综合 N 个 Refs,决策 next_action(finalize / actor_needed / recon_needed)          | 司令                    |
| **Actor**               | 执行者:全工具权限,严格按 action_items 顺序执行                                             | 工兵                    |

---

## §1. 为什么是 6 角色(不是 5 / 7 / N)

### 1.1 演化历史

| 版本        | 角色数 | 角色                                                                               | 触发本次变化的原因                                            |
| ----------- | ------ | ---------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| v0.14.x     | 4      | Recon + Workers + Aggregator + Actor                                               | 初版,无 Planner,任务理解在 Recon 内部完成                   |
| v0.15.0     | 5      | **+ Planner** + Recon + Refs(原 Workers)+ Aggregator + Actor                    | 任务复杂度上升,需要专门的角色做去模糊化和拆解                |
| v0.18.0     | 5 + RA | + Planner + Recon + **Recon Aggregator(并行模式时)** + Refs + Aggregator + Actor | 引入并行多模型 Recon,需要纯 LLM 角色整合多份原始证据         |
| **v0.22.0** | 6      | + Planner + Recon + **Recon Aggregator(始终运行)** + Refs + Aggregator + Actor | Recon 即使单个也常粗糙,需要标准化;多 Recon 时整合是刚需     |

### 1.2 为什么不再加角色

考虑过但**拒绝**的角色:

| 候选角色                  | 拒绝理由                                                                                                                                          |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Critic(独立批判者)     | Refs 已承担批判职责(识别 Aggregator synthesis 的遗漏 / 错误);再加独立 Critic 会导致"批判的批判的批判"无限递归                                  |
| Verifier(最终验证者)   | Actor 的 self_assessment + 用户反馈 loop 已承担验证;再加独立 Verifier 会增加串行延迟                                                              |
| Memory Manager(记忆管家) | v0.22 不引入持久记忆(留待 v0.23+);即使引入,也是后台服务而非对话角色                                                                              |
| Translator(翻译官)      | Planner 的 `process_language` 决策 + 每个角色的 "匹配任务语言" 提示已承担;再加 Translator 会引入"翻译失真"                                        |
| Orchestrator(总指挥)    | Aggregator 的 next_action 决策权已承担;再加 Orchestrator 会出现"两个决策者"冲突                                                                  |

**核心原则**:**每个角色必须有不可替代的职责**。如果一个角色的职责可以被现有角色通过 prompt 调整承担,就不该加。

### 1.3 为什么不再减角色

考虑过但**保留**的角色:

| 角色                    | 保留理由(去掉会怎样)                                                                                                  |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Planner                 | 去掉 → 任务理解在 Recon 内部完成,但 Recon 是"便宜 + 快"模型,推理能力不足,任务复杂时崩                              |
| Recon Aggregator        | 去掉 → 多个 Recon 的原始产出直接进 evidence,Refs 看到 3 份重复 / 冲突的证据,分析质量下降                            |
| Refs(多模型并行)     | 去掉 → 单模型分析,失去 MoA 的核心价值(多视角)                                                                      |
| Aggregator              | 去掉 → 没有收敛决策者,流水线无法终止                                                                                  |
| Actor                   | 去掉 → 只能输出 Markdown 报告,不能真正修改代码 / 跑命令                                                              |

---

## §2. 角色间信息流(完整数据流图)

```
                    ┌─────────────────────────────────────────────┐
                    │  外部输入(动态注入,每次任务构建一次)      │
                    │  ENV_CONTEXT + TOOL_EFFICIENCY              │
                    │  + CUSTOM_INSTRUCTIONS + RUNTIME_INSTRUCTIONS│
                    └────────────────────┬────────────────────────┘
                                         │
                                         ▼
        ┌────────────────────────────────────────────────────────────┐
        │  [Planner] mini-loop (默认 5 次,最大 20 次)              │
        │    iter 1: 基于外部输入 + user prompt 出 plan v1          │
        │    iter 2+: 可调 read-only 工具修正认知,出 plan v2..vN    │
        │    收敛判据: plan_coverage >= 0.9 或 ask_user=true        │
        └────────────────────┬───────────────────────────────────────┘
                             │
        ┌────────────────────┴──────────────────────────────────────┐
        │  PlannerOutput                                              │
        │  - clarified_task + sub_questions + recon_hints             │
        │  - role_setup × 5 (recon/recon_agg/refs/agg/actor)          │
        │  - process_language (决定全流程语言)                        │
        │  - difficulty + task_type + needs_iteration                 │
        └────────────────────┬───────────────────────────────────────┘
                             │
              ┌──────────────┴───────────────┐
              │                              │
              ▼                              ▼
   ┌─────────────────────┐      ┌─────────────────────┐
   │  ENV_CONTEXT +      │      │  role_setup.recon   │
   │  TOOL_EFFICIENCY +  │      │  (tone/             │
   │  CUSTOM_INSTRUCTIONS│      │   perspective/      │
   │  + RUNTIME_INSTR    │      │   tool_priority/    │
   │  (与 Planner 同源)  │      │   cautions)         │
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
        │  职责:去重 / 排序 / 消歧 / 冲突标记 / 缺口识别  │
        │  自迭代:可多轮整合直到自己满意(默认 1-3 次)   │
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
        │              gaps + role_setup.refs.hint          │
        │  **故意无 ENV_CONTEXT 等注入**                    │
        │  **故意用固定设定**(保证多模型可比性)          │
        └────────────────────┬─────────────────────────────┘
                             │
                             ▼
        ┌──────────────────────────────────────────────────┐
        │  [Aggregator](1 个,固定设定,中立裁判)         │
        │  输入:N 个 Refs 输出 + evidence + role_setup.agg │
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
        最终 finalize → Final markdown report
```

---

## §3. 三大设计原则(架构红线)

### 3.1 原则 1:基础设施层 vs 角色身份层 vs 迭代状态层(三层分离)

MoA 的每个角色看的 prompt 由三层构成,**层与层之间解耦**:

| 层              | 内容                                                            | 生成时机                  | 哪些角色看                             |
| --------------- | --------------------------------------------------------------- | ------------------------- | -------------------------------------- |
| **基础设施层**  | ENV_CONTEXT + TOOL_EFFICIENCY + CUSTOM_INSTRUCTIONS + RUNTIME   | 任务启动时构建一次,缓存 | Planner / Recon / Actor(调工具的三角色)|
| **角色身份层**  | role_setup.recon / role_setup.recon_agg / ...                   | Planner mini-loop 收敛后 | 每个角色看自己定制的那一份             |
| **迭代状态层**  | iteration / evidence 摘要 / Aggregator gaps / Actor log         | 每轮动态构建              | 所有角色(内容不同)                   |

**为什么这么分层**:

- 基础设施层是"客观事实"(工作环境有什么、用户指令是什么),不应该被角色身份污染
- 角色身份层是"主观设计"(Planner 决定 Recon 该用什么 tone),不应该被迭代状态干扰
- 迭代状态层是"过程信息"(现在跑到第几轮、缺什么),不应该影响角色身份

如果混在一起(像 Copilot 那样全塞 system message),会导致:
- Planner 的角色设计被当前 iteration 干扰(本该中立设计,却带着 gap 急躁感)
- Recon 看太多迭代状态,过早停止(因为看到"上轮已经查过 X")
- Refs 看到基础设施层,失去多模型可比性(因为不同 Ref 看到不同 env_context)

### 3.2 原则 2:定向不限定(打猎哲学)

Planner 给 Recon 的 `tool_priority` 是**推荐**,不是**限定**。

**为什么**:

- 工具数量庞大(200+),Planner 不可能预见所有情况
- 现场情况变化(Recon 调工具后发现新线索),需要灵活调整
- 强限定会让 Recon 变成"执行机器",失去 agent 价值

**反例**(禁止):

- ❌ "Recon 必须先调 PubMed 搜索,然后调 fetch_webpage,不能调其他"
- ❌ "Recon 不能用 grep_search"(除非有明确安全理由)

**正例**(鼓励):

- ✅ "Recon 推荐先用 list_dir 确认数据文件,然后 PubMed 搜索 X 主题,如果有 DOI 就用 fetch_webpage 抓全文。其他学术数据库 MCP 可按需探索。"
- ✅ "Recon 注意:web_search 容易返回 SEO 垃圾,优先用学术搜索"

### 3.3 原则 3:固定设定 vs 可定制(架构红线)

**Refs 和 Aggregator 是固定设定**,Planner 不能通过 role_setup 修改它们的核心职责。

**为什么**:

- Refs 的价值在**多模型可比性**:所有 Ref 看同一份 evidence + 同一份固定 prompt → 输出差异完全来自模型本身
- 如果给每个 Ref 注入不同的 role_setup,就分不清"这是模型差异还是 prompt 差异"
- Aggregator 的价值在**中立裁判**:不能被任何 role_setup 带偏,必须只看 refs 输出做综合

**Planner 的"hint"是软提示**:

- `role_setup.refs.hint`:一句话,如"重点关注 X 视角"。Refs 看到后会调整关注点,但 JSON schema 不变。
- `role_setup.aggregator.hint`:一句话,如"决策时优先考虑 Y 因子"。Aggregator 看到后会加权,但 next_action 决策权不变。

**反例**(禁止):

- ❌ Planner 给 Ref_1 设计"乐观分析者"身份,给 Ref_2 设计"悲观分析者"身份
- ❌ Planner 让 Aggregator 跳过 evidence_coverage 计算

---

## §4. Recon Aggregator 的特殊地位

### 4.1 为什么 Recon Aggregator 必须始终运行

**用户原话**(2026-07-21):

> "recon_aggregator 应该一直存在,因为 recon 有时候实在是太粗糙了,统一证据清洁度。但是原始的 recon capture 也应该落盘,因此到底什么情况,也可以复盘查询。"

**设计依据**:

1. **Recon 模型通常便宜 + 快**(如 DeepSeek-V4-Flash / MiniMax-M3),工具调用密集但单次输出质量参差
2. **即使单个 Recon**,其 summary 也常有:重复信息 / 未消歧的术语 / 不一致的引用格式 / 混乱的排序
3. **Recon Aggregator 用强模型**(如 GLM-5.2 CodingPlan)做"清洁 + 标准化",成本可控(每轮 1 次调用)
4. **下游 Refs 看到的是标准化后的 evidence**,不会被 Recon 的格式噪音干扰

**实现**:

- `src/moaCore/runRecon.ts` 的 `callRecon` **始终** 通过 Recon Aggregator(单 Recon 时也跑)
- 返回结构 `CallReconResult.merged` 是整合后的(无论单 / 多 Recon)
- 原始 Recon 产出落盘到 `.moa_cache/<task_id>/iteration_N/recon/recon_<label>.json`(便于复盘)
- 整合后的产出落盘到 `.moa_cache/<task_id>/iteration_N/recon_result.json`

### 4.2 Recon Aggregator 的角色设定来源(双轨制)

**用户原话**:

> "对于 recon_aggregator 的角色设定,我认为可以先默认有一个提示词,然后关闭这个选项,让其让 planner 给提供角色。"

**双轨制设计**:

| 模式                                | role_setup.recon_aggregator 来源                              | 配置项                                  |
| ----------------------------------- | ------------------------------------------------------------- | --------------------------------------- |
| **默认模式**(开箱即用)           | 内置静态 prompt(`buildReconAggregatorPrompt` 硬编码)       | `moa.reconAggregatorMode = "default"`   |
| **Planner 驱动模式**(v0.22 新增) | Planner 在 mini-loop 中产出 role_setup.recon_aggregator       | `moa.reconAggregatorMode = "planner"`   |

**默认静态 prompt 核心**:

```
你是 Recon Aggregator,你的职责是把 N 份 Recon 的原始产出整合为一份标准化的 summary。

整合原则:
1. **完整无偏差**:去重但不删减,保留所有数字 / 引用 / 关键句
2. **冲突标记**:多 Recon 间说法不一致时,显式标注 "[冲突] 原因 A vs 原因 B"
3. **缺口识别**:多个 Recon 都没覆盖的主题,显式列出 "[缺口] X 主题未查"
4. **质量分级**:每条证据标注 [high / medium / low] confidence(基于来源权威性)
5. **分类归并**:按"数据 / 文献 / 技术 / 其他"分类,不要混在一起

禁止:
- 不要补充 Recon 没查到的内容(那是下轮 Recon 的活)
- 不要解读 / 归因(那是 Refs 的活)
- 不要调任何工具(你是纯 LLM)
```

**Planner 驱动模式**:

- Planner 根据任务属性,在 role_setup.recon_aggregator 中定制 tone / perspective / focus
- 例如:研究任务 → focus 含 "文献引用格式标准化";代码任务 → focus 含 "代码片段完整保留"
- 如果 Planner 没产出 role_setup.recon_aggregator,fallback 到默认静态 prompt

### 4.3 Recon Aggregator 的自迭代

**用户原话**:

> "recon_aggregator 本身就是单独 LLM,只是要根据任务进行一个总览式的角色风味指导,甚至说其要自迭代,让其忠实整合相关证据,清理无用内容,避免给 ref 分析带来噪音。"

**设计**:

- Recon Aggregator 默认 1 次调用,但可配置自迭代(最多 3 次)
- 自迭代触发条件:`aggregator_coverage < 0.85`(整合完整度自评)
- 自迭代期间**不能调工具**(纯 LLM 重新整合已有内容)
- 自迭代结果落盘:`.moa_cache/<task_id>/iteration_N/recon_aggregator_iter_M.json`

---

## §5. Planner 的智能路由角色(本版本的核心创新)

### 5.1 传统 Planner vs MoA v0.22 Planner

| 维度              | 传统 Planner(如 Plan-and-Execute) | MoA v0.22 Planner                            |
| ----------------- | ------------------------------------ | -------------------------------------------- |
| 调用次数          | 1 次                                 | 1-20 次(mini-loop)                       |
| 工具权限          | 通常无                               | iter 2+ 可调 read-only 工具                 |
| 输出              | plan(steps list)                     | plan + role_setup × 5 + process_language     |
| 与下游关系        | 一次性指令                           | 持续塑造下游身份                             |
| 自评机制          | 无                                   | plan_coverage + needs_replan + ask_user      |
| 工作环境感知      | 通常无                               | 完整 ENV_CONTEXT + CUSTOM + RUNTIME          |

### 5.2 Planner 的"角色设计师"职责是 MoA 独创

调研过的多智能体框架(截止 2026-07):

| 框架                          | 有无"Planner 设计下游角色身份"能力 | 原因                                          |
| ----------------------------- | ---------------------------------- | --------------------------------------------- |
| AutoGen                       | ❌ 角色身份硬编码在代码            | 用户配置 assistant list,不能动态生成         |
| CrewAI                        | ❌ 角色身份在 YAML 配置            | 静态定义,不随任务变化                        |
| LangGraph                     | ❌ 节点身份硬编码                  | 拓扑结构固定                                  |
| Hermes(LISP 时代)          | ❌                                | 单 agent + 工具调用                           |
| Microsoft AutoGen v0.4        | 🟡 有 Selector 概念                | 但 Selector 选 next agent,不设计身份         |
| OpenAI Swarm                  | ❌                                | handoff 机制,无角色设计                      |
| **MoA v0.22**                 | ✅ **Planner 动态设计 5 角色身份** | 通过 role_setup 字段,每次任务生成不同身份集 |

**这是 MoA v0.22 相对所有已知框架的核心创新点**。

### 5.3 为什么 Planner 能做好这件事

1. **Planner 用强推理模型**(默认 fallback 到 aggregator 模型,通常是 GLM-5.2 / Claude Sonnet 级别)
2. **Planner 不调工具**(除了 iter 2+ 的认知修正),有完整 token 预算用于角色设计
3. **Planner 看到完整基础设施层**(ENV_CONTEXT + ...),理解任务上下文
4. **Planner 通过 plan_coverage 自评**,避免草率输出
5. **Planner 受 MoA 流程约束**(不能改 Refs/Aggregator 核心 schema),不会越界

### 5.4 风险与缓解

| 风险                                          | 缓解措施                                                                                                |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Planner 输出格式错误(role_setup 缺字段)    | JSON schema 校验 + 字段默认值(缺则用 v0.21.x 静态 prompt fallback)                                  |
| Planner mini-loop 不收敛(plan_coverage < 0.9)| 默认 5 次硬上限 + 20 次绝对上限 + ask_user 触发                                                          |
| Planner 调工具超时(iter 2+)                  | 每轮最多 3 次工具调用,工具调用失败不阻塞(用上次认知继续)                                            |
| Planner 角色设计偏离用户意图                  | role_setup 是软建议,下游角色保留判断权;Aggregator 可通过 next_action 反馈                              |
| Planner 成本过高(5 次 mini-loop)           | 默认 5 次,简单任务通常 1-2 次收敛;用户可配置 `moa.plannerMaxIterations` 降低上限                       |
| Planner 误判 process_language                | 启发式 fallback(若 LLM 不输出 process_language,从 user prompt 字符统计推断)                          |

---

## §6. 与 Copilot 系统消息的对照

详见 [copilot-system-message-sections.md](copilot-system-message-sections.md)。本节聚焦"哲学差异":

| 维度             | Copilot                                                       | MoA v0.22                                                                                |
| ---------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| **身份来源**     | Cloud 渲染的固定 preamble("你是 GitHub Copilot")            | Planner 动态产出(每个角色独立 role_setup)                                              |
| **tone 控制**    | VSCode 扩展 prompt-tsx 按模型族硬编码                        | Planner 按任务属性定制                                                                   |
| **工具能力**     | Cloud 拼装 tool_instructions                                 | 靠 `vscode.lm.tools[].description` 让 LLM 自读                                          |
| **用户指令**     | 静态读取 CLAUDE.md/AGENTS.md                                 | Planner 消化后通过 role_setup 传递(避免 token 爆炸)                                    |
| **skill 发现**   | 运行时拼装 skill 清单                                         | Planner 按任务相关性筛选推荐                                                             |
| **安全策略**     | Microsoft 条款 + 版权保护                                    | 不拼(由 Recon read-only + Actor Approval Gate 保证)                                    |
| **迭代控制**     | last_instructions 里"parallel tool calling"                  | MoA 自己的 saturated/stagnant/capped + plan_coverage                                    |
| **决策链**       | 单 agent 自己决策                                            | Planner→Recon→RA→Refs→Aggregator→Actor 六角色分工                                       |

**一句话**:Copilot 是"单 agent + cloud 巨型 system message",MoA 是"Planner 智能路由 + 多角色分工 + 每个角色只看该看的"。MoA 的 role_setup 是 Copilot 没有的全新维度。

---

## §7. 与其他多智能体框架的对照

| 框架                | 角色数       | 角色身份来源          | 并行能力             | 收敛机制                | MoA v0.22 相对优势                                      |
| ------------------- | ------------ | --------------------- | -------------------- | ----------------------- | ------------------------------------------------------- |
| **AutoGen v0.4**    | 用户定义     | 代码硬编码            | 部分(assistant list)| 无明确收敛              | MoA 有固定 6 角色 + 明确收敛(evidence_coverage ≥ 0.8)|
| **CrewAI**          | 用户定义     | YAML 静态配置         | 支持(task parallel) | task 完成               | MoA 有 Aggregator 中立裁判 + next_action 决策          |
| **LangGraph**       | 节点(用户定)| 代码硬编码            | 支持(fan-out)       | 图遍历完成              | MoA 有 Planner 角色设计师 + plan_coverage 自评          |
| **OpenAI Swarm**   | agents list  | 代码硬编码            | handoff(串行)      | 无                      | MoA 有 Refs 多模型并行 + Aggregator 综合                |
| **Hermes MoA**      | 5(固定)    | 硬编码                | Refs 并行            | completeness threshold | MoA 增加了 Planner + Recon Aggregator + 智能路由        |
| **MoA v0.22**       | 6(固定)    | **Planner 动态产出** | Recon + Refs 并行    | 多重(plan_coverage / evidence_coverage / MAX_ITER) | —                                                       |

---

## §8. 实施路线(分阶段)

### 阶段 1:v0.22.0 核心改造(2-3 周)

- [ ] 重写 `buildPlannerPrompt` 支持 [planner-system-prompt.md](planner-system-prompt.md) §1 完整模板
- [ ] 实现 `src/systemContext.ts`(4 段动态注入)
- [ ] 实现 `src/instructionScanner.ts`(7 路径 + 4 文件夹扫描,**不截断**)
- [ ] 实现 `src/moaCore/runPlanner.ts` mini-loop(默认 5 次,最大 20 次,plan_coverage 收敛 + ask_user)
- [ ] 让 Recon Aggregator 始终运行(改 `callRecon` 的逻辑)
- [ ] Recon Aggregator 双轨制(默认静态 / Planner 驱动)
- [ ] Recon / Actor 注入完整基础设施层
- [ ] `package.json` 新增 6 个配置项

### 阶段 2:v0.22.1 观测性与调优(1 周)

- [ ] `.moa_cache` 新增 `planner/` 子目录,记录 mini-loop 每轮中间结果
- [ ] VSCode output channel 增加 Planner 迭代日志
- [ ] 配置面板可视化 plan_coverage 收敛曲线
- [ ] 用户反馈收集 → 调优默认 plan_coverage 阈值 / mini-loop 次数

### 阶段 3:v0.23+(未来)

- 持久记忆系统接入(Planner 可读取历史任务)
- 跨任务学习(Planner 记住"上次给这类任务的 role_setup 管用")
- 多模态(ENV_CONTEXT 含图像 / 截图)
- 主动 skill 推荐(基于历史使用频率)

---

## §9. 开放问题(留给社区 / 未来版本)

1. **Planner 产出的 role_setup 应该持久化吗?** 例如,同一类型的任务,下次直接复用上次的 role_setup,跳过 mini-loop
2. **Recon Aggregator 的自迭代成本如何控制?** 默认 1 次,但复杂任务可能需要 3 次
3. **Refs 真的应该完全固定吗?** 如果用户的 CLAUDE.md 明确要求 "所有 Refs 用中文",这是 custom_instructions 但用户意见说 Refs 不应该看 sections —— 矛盾如何解决?(当前答案:Planner 消化后通过 role_setup.refs.hint 传递)
4. **Planner 误判 process_language 的 fallback** 应该多严格? 启发式检测的准确率?
5. **多 root workspace** 的 ENV_CONTEXT 应该取哪个 root? 还是合并?
6. **CLAUDE.md 含敏感信息**(API key 等)怎么办? 是否要做敏感字段检测?

---

## §10. 参考资料

- [moa-role-injection-design.md](moa-role-injection-design.md) — 注入矩阵与技术实现细节
- [planner-system-prompt.md](planner-system-prompt.md) — Planner 完整系统提示词
- [copilot-system-message-sections.md](copilot-system-message-sections.md) — Copilot 12 sections 官方语义
- [ARCHITECTURE.md](ARCHITECTURE.md) — MoA 现有架构文档
- [roadmap/v0.22.0-role-injection-overhaul.md](roadmap/v0.22.0-role-injection-overhaul.md) — v0.22.0 详细路线图
- Hermes MoA 论文与开源实现
- AutoGen v0.4 文档:<https://microsoft.github.io/autogen/>
- CrewAI 文档:<https://docs.crewai.com/>
- LangGraph 文档:<https://langchain-ai.github.io/langgraph/>
