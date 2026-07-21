# MoA 角色注入设计 — 用户意见 × 现状 × Copilot 差异 × 改造方案

> 日期:2026-07-21(v1:2026-07-21;v2 修订:2026-07-21 反映用户第二轮意见;v3 修订:2026-07-21 反映用户第三轮意见)
> 关联文档:
> - [copilot-system-message-sections.md](copilot-system-message-sections.md) — Copilot 12 sections 官方语义
> - [moa-role-design-philosophy.md](moa-role-design-philosophy.md) — 6 角色设计哲学 **v1**(保留)
> - [moa-role-design-philosophy-v2.md](moa-role-design-philosophy-v2.md) — 6 角色设计哲学 **v2**(v3 修订配套)
> - [planner-system-prompt.md](planner-system-prompt.md) — Planner 完整提示词 **v1**(保留)
> - [planner-system-prompt-v2.md](planner-system-prompt-v2.md) — Planner 完整提示词 **v2**(v3 修订配套)
> - [moa-role-customization-blueprint.md](moa-role-customization-blueprint.md) — 用户自定义蓝图 **v1**(保留)
> - [moa-role-customization-blueprint-v2.md](moa-role-customization-blueprint-v2.md) — 用户自定义蓝图 **v2**(v3 修订配套)
> - [roadmap/v0.22.0-role-injection-overhaul.md](roadmap/v0.22.0-role-injection-overhaul.md) — v0.22.0 详细路线图
> 适用版本:MoA v0.21.x → **v0.22.0 注入改造 + 用户主权**
> 状态:**设计阶段 v3**,待用户确认后进入实施
>
> **文档版本策略**(用户原话:"按版本命名迭代,保留原来版本编号"):
> - v1 文档保留(含用户的所有手动修改)
> - v2/v3 文档基于 v1 + 用户反馈整合
> - 主总览(本文档)直接迭代,不创建独立版本文件

---

## §0. TL;DR — 用户核心意见(一句话)

> **"Planner 是智能路由,负责把工作环境 + 工具能力 + 用户指令全部读进去,然后为下游每个角色设计专属的角色定位与 tone;Recon/Actor 接收同等的环境信息但由 Planner 决定其身份;Refs/Aggregator 是纯分析角色只需要固定设定;Copilot 的 `code_change_rules`/`guidelines`/`safety`/`last_instructions`/固定 preamble 全部不要,会污染 MoA 风味。"**

> **v2 修订(用户第二轮意见)**:
> - **Recon Aggregator 必须始终运行**(即使单 Recon,统一证据清洁度),原始 Recon 落盘便于复盘
> - **Planner 默认最多 5 次迭代,最大 20 次**(不是 2-3 次),提示词要更发散,完整告知 MoA 循环 + 角色重要性 + 设定尺度
> - **plan_coverage 阈值 0.9**(不是 0.8),或让 LLM 自决,或开 ask_user 询问用户
> - **instruction 文件不截断**
> - **skill 清单全塞给 Planner**,Planner 给 Recon 推荐工具但不限定(打猎哲学);工具太多则拆分
> - **recon_aggregator 是独立 LLM**,可自迭代(默认有 prompt,可选 Planner 驱动)
> - **Planner 根据用户语言决定全流程语言类型**

> **v3 修订(用户第三轮意见,详见配套 v2 文档)**:
> - **Recon Aggregator 整合原则改为"识别与保留冲突"**(v2 是"消歧"),因为歧义是 Refs 分析的重要素材
> - **Refs/Aggregator 完全不可定制**(v2 是"hint 软提示",v3 强化:连 hint 都删除,架构红线)
> - **tone 改为限定枚举**(7 选 1,不再自由文本),详见 [moa-role-customization-blueprint-v2.md](moa-role-customization-blueprint-v2.md) §3
> - **工具太多时不拆分,而是识别后排序**(分别给 Recon 和 Actor)
> - **任务适配部分 agent 化**(不僵化套模板,根据现场灵活判断)
> - **needs_iteration 受 MoA 入口类型影响**(@moa/@moaloop=true, @moasingle/moa_analyze=false)
> - **few-shot 示例改为用户可外部自定义**(via Role Setup Preset)
> - **Planner 工具权限从 iter 1 就开放**(含 web_search 概念澄清,但禁止代替 Recon 调研)
> - **Recon Aggregator 自迭代扩展到 1-10 次 + 聚合度/忠诚度评分**
> - **新增"用户主权"顶层原则**:用户 Role Setup Preset > Planner AI 生成 > MoA 默认
> - **新增 Plan Mode 实时报告**(借鉴 Copilot Plan agent,但 MoA 为主干,vscode_askQuestions 形式)
> - **新增 final.md 主会话分级展示**(避免下一轮对话多轮调取工具)
> - **新增用户自定义蓝图**:[moa-role-customization-blueprint-v2.md](moa-role-customization-blueprint-v2.md)(类似 moa 模型选择的 Role Setup Preset 系统)
> - **长期 memory 重新定义为 Role Setup Preset**(用户自定义角色设定,跨任务/会话持久)

落到执行层面就是三件事:

1. **Planner 升级为可迭代智能路由**(不是单次规划者):注入完整 `environment_context` + `tool_efficiency` + `tool_instructions` + `custom_instructions` + `runtime_instructions`,输出多一张 `role_setup` 字段(给每个下游角色定制 tone/视角/工具优先级),并加 `plan_coverage` 自评指标支持自我迭代
2. **每个角色按"是否调工具 / 是否需要角色定制"分三档注入**(详见 §4 矩阵)
3. **彻底剥离 Copilot 专属 sections**(5 个,见 §2 红线)

---

## §1. 用户意见归纳(逐条 verbatim)

### 1.1 完全不要的 sections(影响 MoA 风味)

| Copilot Section       | 用户原话                                                                                         | 理由                                       |
| --------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------ |
| `preamble`(固定版) | "copilot 固定的 preamble 是完全不需要的"                                                         | Copilot "你是 GitHub Copilot" 这类身份污染 |
| `code_change_rules`   | "code\_change\_rules ... 完全不需要"                                                              | MoA 有自己的 Actor prompt,不需要 Copilot 的 EditFile/ApplyPatch 规范 |
| `guidelines`          | "guidelines ... 完全不需要"                                                                      | Copilot 的"默认执行/不给时间预估"与 MoA 的 Planner-Aggregator-Actor 决策链冲突 |
| `safety`              | "safety ... 完全不需要"                                                                          | Microsoft 条款 + 版权保护措辞与 MoA 中立研究场景冲突 |
| `last_instructions`   | "last\_instructions ... 完全不需要"                                                              | Copilot 的"并行调用/任务完成"由 MoA 自己的迭代终止逻辑控制 |

> ⚠️ 这不是"不复制 Copilot 的文本",而是**连等价物都不做**。这 5 个 section 在 MoA 完全缺席。

### 1.2 Planner 升级为"智能路由 + 角色设计师"

**用户原话摘要**:

> "recon 的角色定位与 tone 的角色身份,**应当由 planner 决定** ... planner 是一个规范化的无过多注入的角色,它能很好的分析与了解整个 moa 的工作流程,然后给全局的模块分配更为详细的角色风味。这个是一个智能路由。"
>
> "它应该可以获取到当前的 environment_context(我认为要与 copilot 比较像),tool_efficiency,tool_instructions,custom_instructions,runtime_instructions ... 然后它本身也可以进行一定程度的迭代 ... 加入一个 plan complete point,或者叫 plan_coverage?总之就是迭代到一定的程度,并且对 recon 的角色设计完成。"

**落地的 3 个改造**:

1. **Planner 从单次规划者 → 可迭代智能路由**:从"iteration 0 跑一次就出 JSON"改为"自己有 mini-loop,用 `plan_coverage` 自评决定何时收敛"
2. **Planner 输出新增 `role_setup` 字段**:为下游 5 个角色(Recon / recon_aggregator / Refs / Aggregator / Actor)各定制一段 tone/perspective/tool_priority
3. **Planner 注入清单完整化**:5 个 sections 全量注入(见 §4)

### 1.3 各下游角色的注入清单

| 角色               | 用户给的定位                                                                              | 注入项                                                                        |
| ------------------ | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| **Recon**          | "证据收集者,获取证据后交由侦查大队长整合多方信息"                                      | 5 个 sections 全量 + **Planner 的 role_setup**                                |
| **recon_aggregator** | "不需要其他工具,只要有合适的角色定位即可,不知道 planner 是否可以给根据任务属性,给一个角色设定?" | **Planner 的 role_setup**(无 sections,无工具)                                |
| **Refs**           | "完全相同的固定设定,通过同一份证据获得不同 LLM 的判断"                                  | **固定角色 prompt + evidence**(无 sections,无 role_setup,完全同质保证多模型可比性) |
| **Aggregator**     | "最终汇总在 aggregator 来下判断"                                                          | **固定角色 prompt + refs 输出**(无 sections,无 role_setup,中立裁判)          |
| **Actor**          | "信息与 recon 应该是一致的,只是由于角色不同,能力与偏向也不同"                            | 5 个 sections 全量 + **Planner 的 role_setup(Actor 变体)**                   |

> 关键洞察:用户把"工作环境 + 工具能力 + 用户指令"视为**基础设施**,所有调工具的角色(Planner/Recon/Actor)都该看到完整基础设施;把"角色身份"视为**Planner 产出**,每个角色看自己定制的那一份。这就是 Planner 作为"智能路由"的真正含义。

---

## §2. Copilot 12 Sections × MoA 决策红线

基于用户意见 + [copilot-system-message-sections.md](copilot-system-message-sections.md) §1 的官方语义,逐 section 给出 MoA 决策:

| #  | Copilot Section          | MoA 决策   | 理由(基于用户原话 + MoA 架构)                                                                                                                  |
| -- | ------------------------ | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| 1  | `preamble`             | 🔴 **不要** | 用户明示"完全不需要"。MoA 每个角色自己有"你是 MoA 流水线的 X"开头,不需要 Copilot 的"你是 GitHub Copilot"                                     |
| 2  | `identity`(group)    | 🟡 **拆分** | 不用 group,分别处理 `preamble`(不要)/`tone`(Planner 产出)/`tool_efficiency`(自组装)                                                    |
| 3  | `tone`                 | 🟢 **Planner 产出** | 用户:"recon 的角色定位与 tone 的角色身份,应当由 planner 决定"。每个角色的 tone 由 Planner 在 `role_setup` 里定制                                          |
| 4  | `tool_efficiency`      | 🟢 **自组装** | 用户明示要。MoA 自己拼一份工具调用纪律(批处理/并行/不过早停止/避免重复查)                                                                   |
| 5  | `environment_context`  | 🟢 **自组装** | 用户明示要"与 Copilot 比较像"。MoA 已有 `workspaceContext.ts`,需要扩展(详见 §5.2)                                                              |
| 6  | `code_change_rules`    | 🔴 **不要** | 用户明示。MoA Actor 有自己的执行规则,且 Recon 是 read-only                                                                                     |
| 7  | `guidelines`           | 🔴 **不要** | 用户明示。Copilot 的"默认执行"与 MoA 的 Planner→Aggregator→Actor 决策链冲突                                                                     |
| 8  | `safety`               | 🔴 **不要** | 用户明示。Microsoft 条款 + 版权保护与 MoA 中立研究场景冲突                                                                                      |
| 9  | `tool_instructions`    | 🟢 **自动** | MoA 已通过 `vscode.lm.tools[].description` 让 LLM 读工具自身文档,**无需重复**                                                                   |
| 10 | `custom_instructions`  | 🟢 **必须** | 用户明示要。CLAUDE.md/AGENTS.md/copilot-instructions.md 7 路径发现 + 读取                                                                       |
| 11 | `runtime_instructions` | 🟢 **必须** | 用户明示要。skill 清单(4 文件夹扫描) + memories(可选)                                                                                          |
| 12 | `last_instructions`    | 🔴 **不要** | 用户明示。MoA 自己控制迭代终止(saturated/stagnant/capped)                                                                                       |

**红线小结**:12 个 Copilot sections 中,MoA **接受 6 个**(`tone`/`tool_efficiency`/`environment_context`/`tool_instructions`/`custom_instructions`/`runtime_instructions`)、**拒绝 5 个**(`preamble`/`code_change_rules`/`guidelines`/`safety`/`last_instructions`)、**拆分 1 个**(`identity` group)。

---

## §3. MoA 现有执行逻辑(代码事实,基于 v0.21.x)

### 3.1 6 个角色的当前 prompt builder 对照

> 源码:[`src/moaCore/roles.ts`](../src/moaCore/roles.ts)。所有"现状"均带行号。
>
> **v2 修正(2026-07-21)**:经源码核查,**Recon Aggregator 已在 v0.18.0 实现**(位于 [`src/moaCore/runRecon.ts`](../src/moaCore/runRecon.ts)),不是新角色。但当前实现是"单 Recon 时跳过 Aggregator",v0.22.0 改为"始终运行"。

| 角色                     | 当前 prompt builder                     | 接收的上下文                                                                    | 缺什么(对照用户意见)                                                         |
| ------------------------ | --------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| **Planner**              | `buildPlannerPrompt(userPrompt)` L44([src/moaCore/runPlanner.ts](../src/moaCore/runPlanner.ts) 单次调用)    | 仅 `userPrompt`                                                                 | ❌ 缺 5 个 sections(env/tools/custom/runtime/tool_efficiency)、❌ 无 `role_setup` 输出、❌ 无迭代机制 |
| **Recon**                | `buildReconPrompt({...})` L130          | `userPrompt` + `planner.sub_questions/recon_hints` + `gaps` + `actorLog` + `evidenceBrief` + tool registry(隐式通过 vscode.lm.tools) | ❌ 缺 4 个 sections(env/custom/runtime/tool_efficiency)、❌ Planner 的 role_setup 未传入 |
| **Recon Aggregator**     | **v0.18.0 已实现**([src/moaCore/runRecon.ts](../src/moaCore/runRecon.ts) `resolveReconAggregatorModel` L168 + 内置静态 prompt) | N 份 ParallelReconResult(并行模式) / 1 份(单模式,**当前跳过 Aggregator**)    | ⚠️ v0.22.0 改为**始终运行**(单 Recon 也跑标准化) + 双轨制(默认/Planner 驱动) + 自迭代(可选) |
| **Refs**                 | `buildRefPrompt({...})` L400+           | `task` + `evidenceBlock` + `synthesis` + `gaps` + `label`                       | ✅ 符合用户意见(固定设定,无 sections)                                        |
| **Aggregator**           | `buildAggregatorPrompt({...})` L540+    | `task` + `evidenceBlock` + `refOutputs` + `hasActorHistory`                     | ✅ 符合用户意见(中立裁判,无 sections)                                        |
| **Actor**                | `buildActorPrompt({...})` L640+         | `task` + `actionItems` + tool registry(通过 vscode.lm.tools)                   | ❌ 缺 5 个 sections + ❌ Planner 的 role_setup 未传入                          |

### 3.2 现有的 environment_context 实现

> 源码:[`src/workspaceContext.ts`](../src/workspaceContext.ts)

`buildWorkspaceContext()` L62 当前产出:

```typescript
{
  activeFile?: { path, relativePath, languageId, visibleRange, selection },
  openDocuments: [{ relativePath, languageId, isActive }],  // max 8
  workspaceFolders: string[],
  projectTree?: string  // depth=6, maxEntries=2000
}
```

**严重 bug(已记录)**:[`src/moaRunner.ts`](../src/moaRunner.ts) L320-325 调用了 `buildWorkspaceContext()` 但**从未传入 runReconAgent**(死代码)。注释还误导性地写着"for the recon agent's own use"。这是当前 workspace context 完全没有生效的根因。

### 3.3 当前 Recon prompt 的工具相关章节

`buildReconPrompt` L130+ 的 system 部分已经有 **类似 `tool_efficiency` 的章节**(约 L195-235):

- "## 工具使用(agent 化,灵活调用)"
- "## 网络搜索策略(重要)"
- "## 饱和即停(但不要过早停)"

但这些章节是**硬编码在 roles.ts**,没有从 `workspaceContext.ts` 或 Copilot-equivalent source 动态注入。

---

## §4. 改造方案 — 6 角色 × 7 注入项完整清单

### 4.1 注入项定义

下表是 MoA v0.22.0 将要实现的 7 个注入项(对应 Copilot 6 个接受 section + 1 个 Planner 产出):

| 注入项 ID                 | 对应 Copilot Section       | 内容来源                                                                                  | 生成时机                     |
| ------------------------- | -------------------------- | ----------------------------------------------------------------------------------------- | ---------------------------- |
| `ENV_CONTEXT`           | `environment_context`    | `workspaceContext.ts` 扩展版(active file + open docs + workspace folders + project tree + **git root** + **instruction files 列表**) | 每次任务启动时构建一次,缓存 |
| `TOOL_EFFICIENCY`       | `tool_efficiency`         | MoA 自拼模板(批处理/并行/避免重复查/不过早停止)                                       | 静态模板,放在 roles.ts       |
| `TOOL_INSTRUCTIONS`     | `tool_instructions`       | **不主动拼**——靠 `vscode.lm.tools[].description` 让 LLM 自己读                          | 自动(已有)                  |
| `CUSTOM_INSTRUCTIONS`   | `custom_instructions`     | 扫描 7 路径:workspace `{./CLAUDE.md, ./CLAUDE.local.md, ./AGENTS.md, ./.claude/CLAUDE.md, ./.github/copilot-instructions.md}` + home `{~/.claude/CLAUDE.md, ~/.copilot/copilot-instructions.md}` | 每次任务启动时扫描一次       |
| `RUNTIME_INSTRUCTIONS`  | `runtime_instructions`    | 扫描 4 文件夹的 SKILL.md frontmatter:`{.github/skills, .claude/skills, ~/.copilot/skills, ~/.claude/skills}` 生成 skill name + description 清单 | 每次任务启动时扫描一次       |
| `ROLE_SETUP`            | (无,Planner 产出)       | Planner LLM 生成,为下游 5 角色各定制一段 tone/perspective/tool_priority                  | Planner 迭代收敛后产出       |
| `ITER_STATE`            | (无,MoA 内部)           | 当前 iteration / 累积 evidence 摘要 / Aggregator gaps / Actor log                          | 每轮动态构建                 |

### 4.2 6 角色 × 7 注入项矩阵(核心交付物)

| 角色                     | `ENV_CONTEXT` | `TOOL_EFFICIENCY` | `TOOL_INSTRUCTIONS` | `CUSTOM_INSTRUCTIONS` | `RUNTIME_INSTRUCTIONS` | `ROLE_SETUP`       | `ITER_STATE`       |
| ------------------------ | :-----------: | :---------------: | :------------------: | :-------------------: | :--------------------: | :----------------: | :----------------: |
| **Planner**              |       ✅       |         ✅         |   ✅(隐式)        |          ✅            |           ✅            | ❌(自己产出)      | 🟡(自迭代用 plan_coverage) |
| **Recon**                |       ✅       |         ✅         |   ✅(隐式)        |          ✅            |           ✅            | ✅(Planner 给)   |         ✅          |
| **recon_aggregator** ⚠️ |       ❌       |         ❌         |         ❌            |          ❌            |           ❌            | ✅(Planner 给)   |         ✅(汇总多 Recon 的 summaries) |
| **Refs**                 |       ❌       |         ❌         |         ❌            |          ❌            |           ❌            | ❌(固定设定)     |         ✅(evidence/synthesis/gaps) |
| **Aggregator**           |       ❌       |         ❌         |         ❌            |          ❌            |           ❌            | ❌(固定设定)     |         ✅(refs outputs/evidence) |
| **Actor**                |       ✅       |         ✅         |   ✅(隐式)        |          ✅            |           ✅            | ✅(Planner 给,Actor 变体) | ✅(actionItems) |

**矩阵解读**:

- **基础设施层(5 个 sections)** 只给"调工具的角色":Planner / Recon / Actor
- **角色身份层(`ROLE_SETUP`)** 给"需要定制的角色":Recon / recon_aggregator / Actor(Refs 和 Aggregator 故意保持固定设定,保证多模型可比性和中立裁判)
- **迭代状态层(`ITER_STATE`)** 给所有角色(每个角色看的 ITER_STATE 内容不同)

### 4.3 Planner 输出 schema 扩展(v0.22.0)

当前 `PlannerOutput`(roles.ts L26-41)扩展为:

```typescript
export interface PlannerOutput {
  // === 现有字段(保留) ===
  clarified_task: string;
  sub_questions: string[];
  recon_hints: string[];
  expected_output_format: 'report' | 'comparison' | 'code' | 'analysis' | 'document' | 'other';
  difficulty: 'simple' | 'moderate' | 'complex' | 'research';
  needs_iteration: boolean;

  // === v0.22.0 新增 ===
  /** Planner 自评规划完整度(0-1),≥0.8 视为收敛 */
  plan_coverage: number;
  /** Planner 是否需要再迭代一次(<0.8 时为 true) */
  needs_replan: boolean;
  /** 为下游 5 角色定制的 role_setup(核心交付) */
  role_setup: {
    recon: {
      tone: string;              // 例:"严谨的证据收集者,保留数字/引用/关键句"
      perspective: string;       // 例:"优先查 X 类资源,警惕 Y 类误导"
      tool_priority: string[];   // 例:["mcp_unified-acade_*", "fetch_webpage", "grep_search"]
    };
    recon_aggregator: {
      tone: string;              // 例:"中立整合者,识别多 Recon 间的重叠与冲突"
      perspective: string;
      focus: string[];           // 例:["去重", "冲突标记", "缺口识别"]
    };
    refs: {
      // 通常为空(Refs 用固定设定),但 Planner 可微调
      hint: string;
    };
    aggregator: {
      // 通常为空(Aggregator 用固定设定)
      hint: string;
    };
    actor: {
      tone: string;              // 例:"严格按 action_items 顺序执行,失败就如实记录"
      perspective: string;
      tool_priority: string[];
      cautions: string[];        // 例:["不要自动 git commit", "破坏性操作前问用户"]
    };
  };
}
```

### 4.4 recon_aggregator 角色(v0.18.0 已实现,v0.22.0 强化)

**v2 修正**:recon_aggregator 不是新角色,v0.18.0 已实现于 [src/moaCore/runRecon.ts](../src/moaCore/runRecon.ts)。v0.22.0 的改造是:

1. **始终运行**(现状:单 Recon 时跳过;改造后:无论几个 Recon 都跑)
2. **原始 Recon 产出始终落盘**(便于复盘):`.moa_cache/<task_id>/iteration_N/recon/recon_<label>.json`
3. **双轨制角色设定**:
   - 默认模式:内置静态 prompt(已有,v0.18.0)
   - Planner 驱动模式:Planner 在 role_setup.recon_aggregator 中定制
4. **可选自迭代**(默认 1 次,最大 3 次):整合完整度 < 0.85 时自迭代

**用户原话**:

> "recon_aggregator 应该一直存在,因为 recon 有时候实在是太粗糙了,统一证据清洁度。但是原始的 recon capture 也应该落盘,因此到底什么情况,也可以复盘查询。"
>
> "对于 recon_aggregator 的角色设定,我认为可以先默认有一个提示词,然后关闭这个选项,让其让 planner 给提供角色。"

**设计要点(更新)**:

- **触发条件**:**始终运行**(改造自 v0.18.0 的"并行模式才运行")
- **输入**:N 个 Recon 的 summary + log(并行模式)/ 1 个 Recon 的 summary(单模式,做格式标准化)
- **输出**:统一的 `merged.summary`(标准化)+ `cross_recon_gaps`(跨 Recon 的信息缺口)
- **工具**:无(纯 LLM 整合)
- **role_setup 来源**:配置项 `moa.reconAggregatorMode`:`default`(内置静态) / `planner`(Planner 提供)
- **在流水线中的位置**(已有):`Recon ×N → recon_aggregator → Refs → Aggregator`

### 4.5 Planner 自迭代机制(用户提出的 plan_coverage)

**用户原话(v2 强化)**:

> "planner 我觉得可以多次迭代,因为只有 2 次次数太少了,**应该默认最多 5 次,最大上限可以是 20 次**。然后固定提示词要更加的发散,并且彻底告诉他整个 moa 的循环以及其角色的重要性,以及设定尺度。"
>
> "plan_coverage 我觉得得 **0.9** 吧,如果一个任务都没有计划好,那怎么才能执行啊。**或者让 LLM 自行决定是否迭代完成,亦或者开 ask_question 询问用户?**"

**设计要点(v2 更新)**:

- Planner 从"iteration 0 单次调用" → "mini-loop **默认最多 5 次,绝对上限 20 次**"
- 每次自评 `plan_coverage`(0-1):
  - **< 0.5 且 iter ≥ 2** → 触发 `ask_user`(让用户澄清,而不是瞎猜)
  - **< 0.9** → 可继续迭代(若 iter < max)
  - **≥ 0.9** → 收敛,输出最终 `PlannerOutput`
  - **iter ≥ 5 默认 / 20 绝对上限** → 强制收敛,在 `clarified_task` 标注"(planner 未完全收敛)"
- **三种收敛路径**(用户原话"或"):
  1. plan_coverage ≥ 0.9(数值阈值)
  2. LLM 自决 needs_replan=false(LLM 判断)
  3. ask_user=true(让用户澄清)
- 迭代期间 Planner **可调 read-only 工具**(read_file / list_dir / grep_search / get_errors),每轮最多 3 次调用
- 完整提示词见 [planner-system-prompt.md](planner-system-prompt.md)

---

## §5. 改造前后对比(具体变化)

### 5.1 角色清单对比

| 维度             | v0.21.x(现状)                            | v0.22.0(改造后)                                                |
| ---------------- | -------------------------------------------- | ------------------------------------------------------------------ |
| 角色数量         | 5(Planner/Recon/Refs/Aggregator/Actor)+ 隐藏的 Recon Aggregator(并行模式才跑) | **6 个全部显式**(Recon Aggregator 始终运行)                       |
| Planner 调用次数 | 1 次(iteration 0)                          | **1-20 次**(mini-loop,默认上限 5,绝对上限 20,plan_coverage ≥ 0.9 收敛) |
| Planner 输出字段 | 6 个(clarified_task/sub_questions/...)    | **13 个**(新增 plan_coverage/needs_replan/ask_user/ask_user_questions/process_language/task_type/role_setup) |
| Planner 工具权限 | 无                                           | **iter 2+ 可调 read-only 工具**(read_file/list_dir/grep_search/get_errors),每轮最多 3 次 |
| 注入路径         | Recon:仅 userPrompt + planner hints        | Recon/Actor:5 sections 全量 + role_setup + iter_state              |
| workspaceContext | **死代码**(moaRunner.ts L320-325 从未生效) | **激活** + 扩展(加 git root + instruction files 清单)             |
| instruction 文件 | 不读取                                       | **扫描 7 路径**(**不截断**)+ 注入到 Planner/Recon/Actor           |
| skill 清单       | 不读取                                       | **扫描 4 文件夹**(name + description)+ Planner 决定推荐哪些       |
| Recon Aggregator | 仅并行模式触发                               | **始终运行**(单 Recon 也做标准化)+ 原始 Recon 落盘 + 双轨制角色(默认/Planner 驱动) |
| 流程语言决策     | 每个角色自己判断"匹配任务语言"              | **Planner 统一决定** `process_language`,所有角色按此语言输出       |

### 5.2 environment_context 扩展详情

`workspaceContext.ts` 的 `WorkspaceContext` 接口将扩展:

```typescript
export interface WorkspaceContext {
  // === 现有字段 ===
  activeFile?: { ... };
  openDocuments: Array<{ ... }>;
  workspaceFolders: string[];
  projectTree?: string;

  // === v0.22.0 新增 ===
  gitRoot?: string;                          // git rev-parse --show-toplevel
  instructionFiles: Array<{                  // 扫描 7 路径发现的指令文件
    path: string;
    relativePath: string;
    sizeKb: number;
    source: 'workspace' | 'home';            // workspace 级 vs 用户级
  }>;
  skillFolders: Array<{                      // 扫描 4 文件夹发现的 skills
    folder: string;
    skillCount: number;
    skills: Array<{
      name: string;
      description: string;                   // 从 SKILL.md frontmatter 取
      hasScripts: boolean;
    }>;
  }>;
  toolInventory?: {                          // 可选:简要工具能力统计
    total: number;
    byCategory: { readFile: number; webSearch: number; database: number; ... };
  };
}
```

### 5.3 Recon prompt 结构变化(示例)

**v0.21.x(现状)**:

```
[System]
你是 MoA 流水线的 Recon ...
## 工具使用(agent 化,灵活调用)...
## 网络搜索策略 ...
## 饱和即停 ...

[User]
### 任务 ...
### 本轮 Recon 焦点 ...
### Planner 给的查询方向 ...
### 已有 evidence 摘要 ...
```

**v0.22.0(改造后)**:

```
[System]
=== ROLE SETUP (Planner 定制) ===
Tone: <Planner 给的 recon.tone>
Perspective: <Planner 给的 recon.perspective>
Tool priority: <Planner 给的 recon.tool_priority>

=== ENVIRONMENT CONTEXT ===
<renderWorkspaceContext() 输出,含 activeFile/openDocs/tree/gitRoot>

=== TOOL EFFICIENCY ===
<MoA 自拼的工具调用纪律>

=== CUSTOM INSTRUCTIONS ===
<7 路径发现的 CLAUDE.md/AGENTS.md/copilot-instructions.md 内容>

=== RUNTIME INSTRUCTIONS (Skills) ===
<4 文件夹扫描的 skill 清单:name + description>

[User]
### 任务 ...
### 本轮 Recon 焦点 ...
### Planner 给的查询方向 + role_setup.recon ...
### 已有 evidence 摘要 ...
```

### 5.4 Refs / Aggregator 故意保持"无注入"

**用户原话**:

> "对于 refs,就是完全相同的固定设定,让其通过同一份证据,然后获得不同 LLM 的判断与想法,最终汇总在 aggregator 来下判断。"

**设计依据**:

- Refs 的价值在**多模型可比性**:所有 Ref 看同一份 evidence、同一份 synthesis、同一份 gaps、同一个固定角色 prompt → 输出差异完全来自模型本身
- 如果给每个 Ref 注入不同的 `ROLE_SETUP`,就破坏了可比性(分不清是模型差异还是 prompt 差异)
- Aggregator 的价值在**中立裁判**:不能被任何 `ROLE_SETUP` 带偏,必须只看 refs 输出 + evidence 做综合
- 这两条是**架构红线**,即使用户提出也不改(用户意见本身也是这个方向)

---

## §6. 实施边界(v0.22.0 scope)

> **详细实施清单见** [roadmap/v0.22.0-role-injection-overhaul.md](roadmap/v0.22.0-role-injection-overhaul.md)。本节是摘要。

### 6.1 新增文件

| 文件路径                      | 行数估计 | 职责                                                                                  |
| ----------------------------- | -------- | ------------------------------------------------------------------------------------- |
| `src/systemContext.ts`        | ~250     | `buildSystemContext()` 总入口 + `renderForRole(role)` 分角色渲染                      |
| `src/instructionScanner.ts`   | ~150     | 扫描 7 路径的指令文件(**不截断**)+ 4 文件夹的 skills(带 mtime 缓存)              |

### 6.2 修改文件

| 文件路径                   | 改动量  | 关键修改                                                                                                                  |
| -------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------- |
| `src/moaCore/roles.ts`     | ~100 行 | `PlannerOutput` schema 扩展 7 字段;`buildPlannerPrompt` 完全重写(完整模板见 [planner-system-prompt.md](planner-system-prompt.md));`buildReconPrompt`/`buildActorPrompt` 注入 role_setup + sections;新增 `buildReconAggregatorPrompt`(静态默认) |
| `src/moaCore/runPlanner.ts`| ~150 行 | **重写**:mini-loop 实现(默认 5 次,绝对上限 20,plan_coverage 收敛);允许 Planner 调 read-only 工具;ask_user 触发逻辑     |
| `src/moaCore/runRecon.ts`  | ~50 行  | `callRecon` **始终** 跑 Recon Aggregator(单 Recon 也跑);接收 systemContext + role_setup 参数;原始 Recon 始终落盘到 `iteration_N/recon/` 子目录 |
| `src/workspaceContext.ts`  | ~60 行  | `WorkspaceContext` 接口扩展 3 字段(gitRoot/instructionFiles/skillFolders);`buildWorkspaceContext` 填充新字段              |
| `src/moaOrchestrator.ts`   | ~40 行  | iter 1 构建 `systemContext` 缓存到 state;`callRecon`/`callActor` 传入 systemContext                                        |
| `src/moaRunner.ts`         | -10 行  | **删除 L320-325 死代码**;analyze 流程也注入 systemContext                                                                |

### 6.3 不在本次范围(留给 v0.23+)

- `code_change_rules`/`guidelines`/`safety`/`last_instructions` 的任何 MoA 等价物(用户明示不要)
- Copilot 固定 `preamble` 的任何 MoA 等价物(用户明示不要)
- **持久记忆系统**(memories)的读取与注入
- Refs / Aggregator 的任何 sections 注入(架构红线,故意保持固定设定)
- 多模态(图像 / 截图)支持
- 跨任务学习(Planner 记住历史任务的 role_setup)
- 可视化(Webview Panel,从 v0.22 推后到 v0.23)

### 6.4 配置开关(保证向后兼容)

新增 6 个配置项(详见 [roadmap/v0.22.0-role-injection-overhaul.md](roadmap/v0.22.0-role-injection-overhaul.md) §P0-1 / P0-4):

- `moa.enablePlannerIteration`(默认 true,关闭回退 v0.21.x 单次模式)
- `moa.plannerMaxIterations`(默认 5,最大 20)
- `moa.plannerCoverageThreshold`(默认 0.9)
- `moa.plannerAllowTools`(默认 true)
- `moa.reconAggregatorMode`(`default` / `planner`,默认 `default`)
- `moa.reconAggregatorMaxIterations`(默认 1,最大 3)

### 6.5 验收标准

- [ ] 6 角色 prompt 全部按 §4.2 矩阵注入正确
- [ ] `workspaceContext.ts` 新增 3 字段在 buildWorkspaceContext 中正确填充
- [ ] `instructionScanner.ts` 扫描 7 路径 + 4 文件夹,**不截断**,带 mtime 缓存
- [ ] Planner `plan_coverage` 收敛逻辑正确(5 次默认,20 次绝对上限,ask_user 触发)
- [ ] `Recon Aggregator` **始终** 运行(单 Recon 也跑)
- [ ] `Recon Aggregator` 双轨制正确(默认静态 / Planner 驱动)
- [ ] 原始 Recon 产出落盘到 `iteration_N/recon/recon_<label>.json`
- [ ] `moaRunner.ts` L320-325 死代码已删除
- [ ] 现有 e2e 测试全部通过(不破坏 v0.21.x 行为)
- [ ] `moa.enablePlannerIteration=false` 时行为与 v0.21.x 完全一致

---

## §7. 未覆盖盲点分析(v2 新增,基于用户"分析还有哪些没覆盖")

> 用户原话:"你分析一下我还有哪些地方没有覆盖。"

以下是用户意见 + 设计文档中**尚未明确决策**的盲点,需要在 v0.22.0 实施前澄清:

### 7.1 失败处理与容错

| 盲点                                              | 候选方案                                                                                              | 当前默认                |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ----------------------- |
| Planner 自迭代期间调工具失败(网络错误 / 文件不存在) | A. 中止迭代,用上一次认知继续 / B. 跳过该工具,继续其他工具 / C. 触发 ask_user                       | **B**(跳过,继续)     |
| Planner LLM 输出非 JSON(extractJson 失败)        | A. 中止 mini-loop,用 fallback plan / B. 重试 1 次 / C. 触发 ask_user                                 | **B**(重试 1 次,失败后 fallback) |
| 5 次迭代仍未到 0.9                                | A. 强制输出 + 标注 / B. ask_user / C. 中止整个任务                                                    | **A**(强制输出 + 标注) |
| Recon Aggregator 自迭代期间 LLM 崩溃              | A. 用上一次整合结果 / B. fallback 到原始终止 / C. 直接传递原始 Recon 给 Refs                          | **A**(用上一次)       |

### 7.2 成本控制

| 盲点                                              | 候选方案                                                                                              | 当前默认                |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ----------------------- |
| Planner 5 次 mini-loop + 完整 sections 注入,token 成本如何? | 默认 5 次,简单任务通常 1-2 次收敛;用户可降 `moa.plannerMaxIterations`                                | 已有方案                |
| 是否要为每次任务建立 token 预算池?                | A. 不建,信任用户配置 / B. 建,超预算时强制收敛 / C. 建,超预算时 ask_user                              | **A**(不建)          |
| Recon Aggregator 始终运行增加成本(单 Recon 也跑)  | 用便宜模型(可配置 `moa.reconAggregatorModel`)                                                       | 已有方案                |
| instruction 文件不截断,大 CLAUDE.md(100KB+)怎么办? | A. 不截断,信任 Planner 消化能力 / B. 超过 200KB 给警告但仍传入 / C. 截断                             | **A + B**(不截断,超 200KB 警告) |

### 7.3 配置开关与向后兼容

| 盲点                                              | 候选方案                                                                                              | 当前默认                |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ----------------------- |
| 新 v0.22 行为应有 `moa.enablePlannerIteration` 开关吗? | 已有,默认 true(开)                                                                                  | 已决策                  |
| 老用户升级后默认开启会破坏现有体验吗?              | 默认开启,但配置开关让用户可关闭回退 v0.21.x                                                          | 已决策                  |
| 是否需要"v0.21.x 兼容模式"作为独立配置?            | A. 用现有开关组合即可 / B. 单独 `moa.legacyPlannerMode=true`                                          | **A**(开关组合)       |

### 7.4 缓存策略

| 盲点                                              | 候选方案                                                                                              | 当前默认                |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ----------------------- |
| `instructionScanner` 缓存按 mtime,缓存 key 怎么设计? | key = 文件绝对路径 + mtime;workspace 切换时清空缓存                                                  | 已决策                  |
| Planner 自迭代期间是否缓存中间状态到 .moa_cache?  | **必须缓存**(便于复盘 + 调优),落盘到 `.moa_cache/<task_id>/planner/iter_N.json`                    | 已决策                  |
| ENV_CONTEXT 在 mini-loop 期间变化吗?              | A. 不变化(任务启动构建一次,跨 mini-loop 复用)/ B. 每轮重新构建                                       | **A**(不变化)        |

### 7.5 语言检测的鲁棒性

| 盲点                                              | 候选方案                                                                                              | 当前默认                |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ----------------------- |
| 用户输入混合中英文怎么办?                         | A. 以主导语言为准(字符统计)/ B. 让 Planner 判断 / C. 询问用户                                        | **B**(Planner 判断,可用启发式 fallback) |
| 用户用英文问但 CLAUDE.md 是中文,应该如何?        | **以用户提问语言为准**(用户原话)                                                                    | 已决策                  |
| 用户明确要求"用英文回答"但问的是中文?             | 尊重用户明示,用 `en`                                                                                  | 已决策                  |
| Planner 误判 process_language 怎么办?             | A. 无 fallback / B. 启发式字符统计 fallback                                                          | **B**(启发式 fallback) |

### 7.6 role_setup 的校验与 fallback

| 盲点                                              | 候选方案                                                                                              | 当前默认                |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ----------------------- |
| Planner 输出的 role_setup 格式不对(缺字段)怎么办? | A. JSON schema 校验 + 默认值(缺则用 v0.21.x 静态 prompt)/ B. 强制重跑 Planner                       | **A**(默认值 fallback) |
| 是否应该有 JSON schema 校验?                      | 是,用 zod 或手写校验                                                                                  | 已决策                  |
| role_setup 让 Refs 失去多模型可比性?              | **架构红线**:Refs 的 role_setup 只有 hint 一句话,不改 JSON schema                                    | 已决策                  |

### 7.7 多 workspace 场景

| 盲点                                              | 候选方案                                                                                              | 当前默认                |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ----------------------- |
| VSCode 多 root workspace 时,ENV_CONTEXT 取哪个?  | A. 第一个 root / B. 合并所有 root / C. 当前活动文件所在 root                                          | **A**(第一个 root),instructionFiles 扫描所有 root |
| instructionScanner 是否扫所有 root?               | 是,workspace 级路径在所有 root 扫,home 级路径只扫一次                                                | 已决策                  |

### 7.8 隐私与安全

| 盲点                                              | 候选方案                                                                                              | 当前默认                |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ----------------------- |
| CLAUDE.md 含 API key 或敏感信息怎么办?            | A. 检测 + 警告(不删减)/ B. 自动脱敏 / C. 不处理                                                     | **A**(检测 + 警告)    |
| Skill 描述含恶意 prompt injection 怎么办?         | A. 信任用户环境,不处理 / B. 沙箱化 skill 描述(用引号包围)/ C. 检测后剥离                            | **A**(信任用户环境)   |

### 7.9 可观测性

| 盲点                                              | 候选方案                                                                                              | 当前默认                |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ----------------------- |
| 用户怎么知道 Planner 迭代了几次?为什么不收敛?    | OutputChannel 日志 + `.moa_cache/<task_id>/planner/iter_N.json` 落盘                                  | 已决策                  |
| 配置面板可视化 plan_coverage 收敛曲线?            | 留待 v0.23+(可视化版本)                                                                              | 已决策                  |

### 7.10 Refs/Aggregator "完全同质"的边界(架构红线再强调)

| 盲点                                              | 候选方案                                                                                              | 当前默认                |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ----------------------- |
| 用户在 CLAUDE.md 写"所有 Refs 必须用中文",这是 custom_instructions,但 Refs 不应该看 sections | 由 Planner 消化后通过 `role_setup.refs.hint` 传递                                            | 已决策                  |
| Planner 能否修改 Refs 的 JSON schema?             | **绝对不能**(架构红线,保证多模型可比性)                                                              | 已决策                  |
| Planner 能否修改 Aggregator 的 next_action 决策权? | **绝对不能**(架构红线,保证中立裁判)                                                                  | 已决策                  |

### 7.11 Recon 数量 = 0(全部失败)的 fallback

| 盲点                                              | 候选方案                                                                                              | 当前默认                |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ----------------------- |
| 所有 Recon 都失败时,Recon Aggregator 怎么办?      | A. 输出空 summary,Aggregator 触发 recon_needed / B. Aggregator 直接 abort / C. 用 error message 作为 evidence | **A**(空 summary,让 Aggregator 决策) |

### 7.12 Actor 的 role_setup 变体

| 盲点                                              | 候选方案                                                                                              | 当前默认                |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ----------------------- |
| Planner 给 Actor 的 role_setup 应该包含什么?      | tone(语气)/ perspective(视角)/ tool_priority(推荐工具)/ cautions(破坏性操作注意)              | 已决策                  |
| Actor 失败后 role_setup 是否要更新?               | A. 不更新,Planner 已收敛 / B. 下次任务时 Planner 重新设计                                            | **A**(不更新)        |

### 7.13 测试策略

| 盲点                                              | 候选方案                                                                                              | 当前默认                |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ----------------------- |
| 如何测试 Planner 自迭代的收敛性?                  | 单元测试 mock LLM 输出不同 plan_coverage,验证收敛逻辑                                                | 已决策                  |
| 如何测试 role_setup 的质量?                       | e2e 测试覆盖典型场景(简单/复杂/多语言),人工评估 role_setup 合理性                                  | 已决策                  |

### 7.14 待用户最终决策的开放问题(精简后)

经 v2 修订,以下是**仍需用户最终拍板**的开放问题(其他盲点已有默认方案,实施时若用户不反对则按默认执行):

1. **token 预算池**:是否需要?(默认:不需要,信任用户配置)
2. **v0.21.x 兼容模式**作为独立配置?(默认:用现有开关组合)
3. **恶意 skill 描述防护**:沙箱化还是信任?(默认:信任)
4. **敏感信息检测**:警告级别?(默认:警告,不删减)
5. **Recon Aggregator 自迭代默认次数**:1 次还是 2 次?(默认:1 次,可配置)

---

## §8. 与 Copilot 的本质差异(哲学层)

| 维度             | Copilot                                                                                | MoA v0.22.0                                                                                  |
| ---------------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| **身份来源**     | Cloud 渲染的固定 preamble("你是 GitHub Copilot")                                    | **Planner 动态产出**(每个角色独立 role_setup)                                                |
| **tone 控制**    | VSCode 扩展 prompt-tsx 按模型族硬编码(anthropicPrompts.tsx 等)                      | **Planner 按任务属性定制**(研究任务 vs 代码任务给不同 tone)                                  |
| **工具能力**     | Cloud 拼装 tool_instructions(每个工具一段说明)                                      | **靠 `vscode.lm.tools[].description` 让 LLM 自读**(无冗余拼装)                              |
| **用户指令**     | 静态读取 CLAUDE.md/AGENTS.md/copilot-instructions.md                                 | **同源读取 + Planner 消化后通过 role_setup 传递**(下游角色看 Planner 提炼版,避免 token 爆炸) |
| **skill 发现**   | 运行时拼装 skill 清单到 runtime_instructions                                          | **同源扫描 + Planner 按任务相关性筛选**(不把 200 个 skills 全塞给 Recon)                    |
| **安全策略**     | Microsoft 条款 + 版权保护(base/safetyRules.tsx)                                     | **不拼**(用户明示不要;MoA 的安全由 Recon read-only 限制 + Actor Approval Gate 保证)        |
| **迭代控制**     | last_instructions 里"parallel tool calling/persistence"                              | **MoA 自己的 saturated/stagnant/capped 逻辑**(Recon)+ **plan_coverage**(Planner)            |
| **决策链**       | 单 agent 自己决策                                                                      | **Planner→Recon→recon_aggregator→Refs→Aggregator→Actor 六角色分工**                          |
| **流程语言**     | VSCode locale 决定                                                                     | **Planner 根据用户提问语言决定**(更精细)                                                     |

**一句话总结**:Copilot 是"单 agent + cloud 渲染的巨型 system message",MoA 是"Planner 作为智能路由 + 多角色分工 + 每个角色只看它该看的"。MoA 的 `ROLE_SETUP` 是 Copilot 没有的全新维度——把"角色身份设计"从 cloud 硬编码变成 Planner LLM 动态产出。

**详细哲学对照见** [moa-role-design-philosophy.md](moa-role-design-philosophy.md) §6 / §7。

---

## §9. 参考资料

### 9.1 本仓库内文档(v0.22.0 设计套件)

- [moa-role-design-philosophy.md](moa-role-design-philosophy.md) — **6 角色设计哲学**(三层分离 / 打猎哲学 / 固定 vs 可定制 / 与其他多智能体框架对比)
- [planner-system-prompt.md](planner-system-prompt.md) — **Planner 完整系统提示词**(应对复杂工程的详尽版本)
- [roadmap/v0.22.0-role-injection-overhaul.md](roadmap/v0.22.0-role-injection-overhaul.md) — **v0.22.0 详细路线图**(P0/P1/P2/P3 任务 + 工作量 + 风险)
- [copilot-system-message-sections.md](copilot-system-message-sections.md) §1 — 12 sections 官方语义
- [copilot-system-message-sections.md](copilot-system-message-sections.md) §3.4 — 5 角色 × section 矩阵(本文 §4.2 是其扩展版,6 角色 × 7 注入项)
- [ARCHITECTURE.md](ARCHITECTURE.md) — MoA 现有架构文档
- [roadmap/long-term-roadmap.md](roadmap/long-term-roadmap.md) — 长期路线图(v0.22 后可视化推到 v0.23+)

### 9.2 源码参考

- [`src/moaCore/roles.ts`](../src/moaCore/roles.ts) — 当前 5 角色 prompt builder 源码
- [`src/moaCore/runPlanner.ts`](../src/moaCore/runPlanner.ts) — 当前 Planner(单次调用,v0.22 重写)
- [`src/moaCore/runRecon.ts`](../src/moaCore/runRecon.ts) — 当前 Recon + Recon Aggregator(v0.18.0 已实现)
- [`src/workspaceContext.ts`](../src/workspaceContext.ts) — 当前 environment_context 实现(有 dead code bug)

### 9.3 外部参考

- VSCode Copilot 扩展 prompt-tsx 源码:`microsoft/vscode/extensions/copilot/src/platform/prompts/`
- Copilot SDK section override 文档:`copilot-sdk/nodejs/src/types.ts` L952-978
- Hermes MoA 论文与开源实现
- AutoGen v0.4 / CrewAI / LangGraph / OpenAI Swarm 文档(详见 [moa-role-design-philosophy.md](moa-role-design-philosophy.md) §7)
