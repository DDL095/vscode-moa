# MoA 角色自定义系统设计蓝图(v0.22.0)

> 日期:2026-07-21(v3,整合用户第三轮反馈)
> 用途:**v0.22.0 是"风味与个性化强力设定"版本 —— 让 MoA 成为 VSCode 中长出的个人化檽寄生**
> 关联文档:
> - [moa-role-injection-design.md](moa-role-injection-design.md) — 注入矩阵主总览
> - [moa-role-design-philosophy.md](moa-role-design-philosophy.md) — 设计哲学
> - [planner-system-prompt.md](planner-system-prompt.md) — Planner 提示词
> - [roadmap/v0.22.0-role-injection-overhaul.md](roadmap/v0.22.0-role-injection-overhaul.md) — 路线图
> 状态:**设计阶段 v3**,待用户确认后进入实施

---

## §0. 核心理念(用户原话归纳)

> "这一大版本就是一个风味与个性化的强力设定,就是在 vscode 当中长出来的一个个人 MOA 檽寄生。"

**3 大支柱**:

1. **用户主权(User Sovereignty)**:用户拥有每个角色的最终设定权,包括 tone / perspective / tool_priority / 语言 / 整个 prompt
2. **AI 辅助(AI Assistance)**:Planner 可自动生成 role_setup,但**采纳与否由开关决定**
3. **组合传承(Preset Inheritance)**:类似 moa 模型选择,角色设定可作为"风味预设"保存/加载/分享

---

## §1. 用户角色设定的层次结构(类似 moa 模型预设)

### 1.1 借鉴 moa 模型预设的设计

现有 moa 模型预设([src/presetConfig.ts](../src/presetConfig.ts))结构:

```typescript
interface ModelPreset {
  name: string;
  description: string;
  planner: { model: string };
  reconModels: [{ model: string }, ...];
  reconAggregator: { model: string };
  refModels: [{ model: string }, ...];
  aggregator: { model: string };
  actor: { model: string };
}
```

v0.22.0 新增**角色设定预设**(并行结构):

```typescript
interface RoleSetupPreset {
  /** 预设名(用户可命名,如 "严谨研究者"/"快速代码工"/"混合双修") */
  name: string;
  /** 组合说明(任意语言,展示给用户看) */
  description: string;
  /** 创建/修改时间 */
  createdAt: string;
  updatedAt: string;
  /** 流程默认语言(可被 Planner process_language 覆盖) */
  defaultLanguage: 'zh-CN' | 'en' | 'mixed' | 'ja' | 'ko' | 'fr' | 'de' | ...;
  /** 6 角色各自的设定 */
  roles: {
    planner?: RoleOverride;
    recon: RoleOverride;
    reconAggregator: RoleOverride;
    refs: RoleOverride;
    aggregator: RoleOverride;
    actor: RoleOverride;
  };
  /** AI 自生成的开关(详见 §2) */
  aiGenerated: {
    enabled: boolean;
    autoAccept: boolean;
  };
}

interface RoleOverride {
  /** 角色语气(限定枚举,详见 §3) */
  tone?: TonePreset;
  /** 自由文本:分析视角/职责边界 */
  perspective?: string;
  /** 推荐工具(排序后的,不拆分) */
  toolPriority?: string[];
  /** 注意事项 */
  cautions?: string[];
  /** 整合重点(仅 recon_aggregator) */
  focus?: string[];
  /** 完整 prompt 覆盖(高级模式,直接替换 build*Prompt 的 system 部分) */
  customSystemPrompt?: string;
}

type TonePreset =
  | 'strict-evidence'      // 严谨证据收集者
  | 'faithful-integrator'  // 忠实整合者
  | 'neutral-judge'        // 中立裁判
  | 'strict-executor'      // 严格执行者
  | 'creative-explorer'    // 创造性探索者
  | 'conservative'         // 保守模式
  | 'aggressive'           // 激进模式
  | 'custom';              // 自定义(配合 perspective)
```

### 1.2 与模型预设的关系

| 项                | 模型预设(已有)               | 角色设定预设(v0.22.0 新增)                              |
| ----------------- | ------------------------------ | --------------------------------------------------------- |
| 决定什么          | 每个角色用哪个 LLM             | 每个角色的 prompt 风味(tone / perspective / ...)       |
| 存储位置          | VSCode settings.json           | VSCode settings.json(或独立 .moa-presets.json)        |
| 加载方式          | presetConfig.getActivePreset() | roleSetupPreset.getActive()                              |
| 切换方式          | "Moa: Switch Preset" command   | "Moa: Switch Role Setup Preset" command                  |
| 组合关系          | 独立                           | **可与任意模型预设组合**(笛卡尔积)                      |
| 用户可导入/导出   | 是(JSON)                     | 是(JSON)                                               |

**组合示例**:

- 模型预设 `"cost-effective"`(DeepSeek-Flash + MiniMax-M3)+ 角色设定预设 `"strict-researcher"`(严谨证据 + 中立裁判)
- 模型预设 `"premium"`(Claude Sonnet + GLM-5.2)+ 角色设定预设 `"creative-explorer"`(创造性探索)

---

## §2. AI 自生成开关机制(用户原话 #1.1)

### 2.1 三层开关(从宽松到严格)

用户原话:"**对于 AI 自生成采纳与否,也要有开关**"

```typescript
interface AIGenerationConfig {
  /**
   * 层 1:Planner 是否被允许生成 role_setup(总开关)
   * true: Planner 输出 role_setup 字段
   * false: Planner 跳过 role_setup 生成(老行为)
   */
  enabled: boolean;  // 默认 true

  /**
   * 层 2:Planner 生成的 role_setup 是否自动采纳
   * true: 直接使用 Planner 的 role_setup
   * false: 通过 Approval Gate 让用户选择(详见 §4)
   */
  autoAccept: boolean;  // 默认 false(需用户确认)

  /**
   * 层 3:如果 autoAccept=false,采用哪种确认 UI
   * - 'quick-pick': QuickPick 列表选 "采纳 AI 生成" / "用我的预设" / "手动编辑"
   * - 'diff-view': Webview diff 对比 AI 生成 vs 用户预设,用户编辑后采纳
   * - 'plan-mode': 完整 plan mode(详见 §5)
   */
  confirmationUI: 'quick-pick' | 'diff-view' | 'plan-mode';  // 默认 'plan-mode'

  /**
   * 层 4:Plan mode 下,实时报告的内容范围
   */
  planModeReportScope: {
    showPlan: boolean;          // 显示 plan(默认 true)
    showReconPrompt: boolean;   // 显示 Recon 提示词(默认 true)
    showRoleSetup: boolean;     // 显示所有角色设定(默认 true)
    showTokenCost: boolean;     // 显示操作消耗(默认 true)
    showPlanCoverage: boolean;  // 显示 plan_coverage 收敛曲线(默认 true)
  };
}
```

### 2.2 决策矩阵(用户选哪一档)

| 场景                       | enabled | autoAccept | confirmationUI | 行为                                                     |
| -------------------------- | ------- | ---------- | -------------- | -------------------------------------------------------- |
| 老用户习惯 v0.21.x         | false   | -          | -              | Planner 单次,无 role_setup,完全用用户预设              |
| 新用户体验 AI 生成         | true    | false      | 'quick-pick'   | Planner 生成,用户选"采纳/用预设/手动编辑"              |
| 中级用户精细控制           | true    | false      | 'diff-view'    | Planner 生成,Webview diff 对比,用户编辑后采纳         |
| **专家用户 plan mode**(默认推荐) | true    | false      | 'plan-mode'    | Planner 生成,完整 plan mode 报告 + 实时确认            |
| 自动化场景(CI/CD)         | true    | true       | -              | Planner 生成,自动采纳,不打扰用户                       |

### 2.3 默认配置(开箱即用)

```json
{
  "moa.roleSetup.aiGeneration.enabled": true,
  "moa.roleSetup.aiGeneration.autoAccept": false,
  "moa.roleSetup.aiGeneration.confirmationUI": "plan-mode",
  "moa.roleSetup.aiGeneration.planModeReportScope": {
    "showPlan": true,
    "showReconPrompt": true,
    "showRoleSetup": true,
    "showTokenCost": true,
    "showPlanCoverage": true
  }
}
```

**设计理由**:

- `enabled=true`:让新用户感受 AI 生成的价值
- `autoAccept=false`:不让 AI 替用户做决定(用户主权)
- `confirmationUI='plan-mode'`:借鉴 Copilot Plan agent,但**以 MoA 为主干**(详见 §5)

---

## §3. Tone 限定系统(用户原话 #1.2)

> 用户原话:"tone 应该要限定,与当前工作流适配。"

### 3.1 7 个限定 Tone(不再开放自由文本)

| Tone ID             | 中文标签       | 适用角色                                | 核心特征                                                          |
| ------------------- | -------------- | --------------------------------------- | ----------------------------------------------------------------- |
| `strict-evidence`   | 严谨证据       | Recon(默认)                          | 保留所有数字/引用/关键句,不归因不解读不补全                       |
| `faithful-integrator` | 忠实整合       | Recon Aggregator(默认)               | 保留原证据,不补充不解读,做去重/排序/质量分级                     |
| `neutral-judge`     | 中立裁判       | Aggregator(默认,固定)                | 只看 refs 输出做综合,不被任何 role_setup 带偏                     |
| `strict-executor`   | 严格执行       | Actor(默认)                          | 严格按 action_items 顺序执行,失败如实记录                         |
| `creative-explorer` | 创造探索       | Refs(可选)/ Recon(可选)            | 鼓励提出非常规视角,容忍合理推测(明确标注 confidence=low/medium) |
| `conservative`      | 保守模式       | Actor(可选)                          | 破坏性操作前必问用户,优先用 .bak 备份                            |
| `aggressive`        | 激进模式       | Actor(可选,危险)                    | 自动执行不问,git commit 自动化(仅 CI/CD 场景)                  |

### 3.2 为什么限定(而不是自由文本)

- **可比较**:用户在两个预设间切换时,tone 含义一致,不会"张三的严谨 ≠ 李四的严谨"
- **可测试**:每个 tone 对应确定性的 prompt 片段,单元测试可覆盖
- **防越界**:避免用户写出"激进到失控"的 tone(如"忽略所有安全规则")
- **可国际化**:每个 tone 有中英文双语标签,跨语言工作流不歧义

### 3.3 用户如何自定义 tone

用户只能选 7 个限定 ID 之一。若需更细的控制,通过 `perspective`(自由文本)补充:

```json
{
  "recon": {
    "tone": "strict-evidence",
    "perspective": "特别关注 p-value < 0.01 的结果,警惕样本量 < 10 的研究"
  }
}
```

**高级模式**:`customSystemPrompt` 完全替换 system prompt(专家用户,风险自负)。

---

## §4. Plan Mode 实时报告(用户原话 #1.4,核心创新)

> 用户原话:"可以有一个开关,就是通过 ask_question 的形式,实时给用户报告所形成的 plan 计划,recon 提示词,给 recon 的角色设定,recon_aggregator 以及 actor 的角色设定,以及操作消耗和内容。我认为这个是最为关键的入口,有些类似于 plan 模式 agent 的工作。"

### 4.1 借鉴 Copilot Plan Agent(但 MoA 为主干)

**Copilot Plan.agent.md 核心思想**(作为启发,不照搬):

1. **Discovery** → **Alignment** → **Design** → **Refinement** 四阶段
2. `searchSubagent` 并行收集
3. `vscode/askQuestions` 澄清需求
4. **必须显示 plan 给用户**(plan.md 是持久化,显示是必须的)
5. `handoffs` 让用户选"开始实施"/"打开编辑器"
6. 持久化到 `/memories/session/plan.md`

**MoA 主干(不照搬 Copilot)**:

- MoA 有 6 角色流水线(Planner→Recon→RA→Refs→Aggregator→Actor),不是 Copilot 的单 agent
- MoA 的 Planner **本身就是设计阶段**,无需 Copilot 的"Discovery → Alignment"区分(Planner mini-loop 已涵盖)
- MoA 的"显示"应该用 **vscode_askQuestions**(用户原话)而非 Copilot 的 markdown 渲染
- MoA 的"持久化"用 `.moa_cache/<task_id>/planner/`(已有,不是 memories)

### 4.2 MoA Plan Mode 工作流(4 阶段)

```
用户提问 "分析一下冬眠小鼠胃部数据"
         ↓
┌────────────────────────────────────────────────────────────┐
│ 阶段 A:Planner mini-loop(自动,后台)                    │
│   iter 1: 出 plan_coverage=0.65, needs_replan=true         │
│   iter 2: 调 list_dir 修正认知,plan_coverage=0.88          │
│   iter 3: 出 plan_coverage=0.92, needs_replan=false        │
│   (若 plan_coverage < 0.5 → 触发 ask_user)                │
└────────────────────────────────────────────────────────────┘
         ↓
┌────────────────────────────────────────────────────────────┐
│ 阶段 B:Plan Mode 报告(vscode_askQuestions 显示)         │
│                                                            │
│ ┌─ 标题: MoA Plan 已生成 (3 次迭代, plan_coverage=0.92) ─┐│
│ │                                                          ││
│ │ 📋 Clarified Task:                                       ││
│ │    针对用户已有的冬眠小鼠胃部...                        ││
│ │                                                          ││
│ │ 🎯 Sub Questions (5):                                    ││
│ │    1. 在 projectTree 查找 .rds 文件                      ││
│ │    2. 确认实验设计...                                    ││
│ │                                                          ││
│ │ 🎭 Role Setup:                                           ││
│ │    Recon: strict-evidence                                ││
│ │      - tool_priority: [list_dir, read_file, PubMed, ...]││
│ │    Recon Aggregator: faithful-integrator                 ││
│ │    Actor: strict-executor                                ││
│ │                                                          ││
│ │ 💰 操作消耗预估:                                         ││
│ │    Planner: 3 次 × ~2000 tokens = ~6000 tokens           ││
│ │    Recon: 2 模型 × 8 工具调用 × ~1500 tokens = ~24000    ││
│ │    Refs: 3 模型 × ~1000 tokens = ~3000                   ││
│ │    Aggregator: ~2000 tokens                              ││
│ │    总计:~35000 tokens (约 ¥0.3-0.5)                     ││
│ │                                                          ││
│ │ 📊 plan_coverage 收敛曲线:                               ││
│ │    iter 1: 0.65 → iter 2: 0.88 → iter 3: 0.92 ✓         ││
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
│ 阶段 D:Final.md 在主会话内展示(详见 §7)                │
└────────────────────────────────────────────────────────────┘
```

### 4.3 vscode_askQuestions 的 schema

```typescript
interface MoAPlanReport {
  /** 标题 */
  title: string;  // "MoA Plan 已生成"
  /** Planner 迭代信息 */
  iterations: number;
  planCoverage: number;
  /** Clarified task */
  clarifiedTask: string;
  /** Sub questions */
  subQuestions: string[];
  /** Role setup 摘要(每个角色的 tone + tool_priority) */
  roleSetupSummary: {
    recon: { tone: TonePreset; toolPriority: string[] };
    reconAggregator: { tone: TonePreset; focus: string[] };
    actor: { tone: TonePreset; toolPriority: string[] };
  };
  /** 完整 plan 文本(便于用户复制) */
  fullPlanText: string;
  /** 操作消耗预估 */
  estimatedCost: {
    plannerTokens: number;
    reconTokens: number;
    refsTokens: number;
    aggregatorTokens: number;
    totalTokens: number;
    estimatedYuan: number;
  };
  /** 用户选择项 */
  choices: Array<{
    label: string;
    description: string;
    action: 'accept' | 'edit-role-setup' | 'switch-preset' | 'iterate-planner' | 'cancel';
  }>;
}
```

### 4.4 "修改时对话框内显示便于复制粘贴"(用户原话 #1.3)

用户在 Plan Mode 选"编辑 Role Setup 后再执行"时:

1. VSCode 弹出**新 untitled 文档**:`untitled:moa-role-setup-${timestamp}.json`
2. 文档内容是当前 Planner 生成的 role_setup 的 JSON
3. 用户在外部编辑器修改(任意语言注释、调整 tone、改 tool_priority)
4. 保存后(或关闭文档时)MoA 检测变更,询问"应用修改?"
5. 应用后,Role Setup Preset 自动保存为新的(可选)

**设计理由**:

- VSCode 编辑器比任何 modal 都强大(语法高亮、JSON schema 校验、find/replace)
- 用户可同时打开多个文档对比(用户预设 vs AI 生成)
- 复制粘贴到外部工具(如 diff checker、AI 对话)便利
- 符合用户原话"对话框内加入,便于复制粘贴然后在外部修改与替换"

---

## §5. Recon Aggregator 自迭代与评分(用户原话 #1.5)

> 用户原话:"Recon Aggregator 默认自迭代 1 次,因为只是一个迭代工具,但是开放权限到 10 次,并且总的让 Recon Aggregator 给出一个聚合度与忠诚度的评分。"

### 5.1 自迭代配置

```json
{
  "moa.reconAggregatorMaxIterations": {
    "type": "number",
    "default": 1,
    "minimum": 1,
    "maximum": 10,
    "description": "Recon Aggregator 自迭代最大次数。默认 1(单次),最大 10(允许深度整合)。每次自迭代会增加 LLM 调用成本。"
  },
  "moa.reconAggregatorConvergenceMode": {
    "type": "string",
    "enum": ["score-threshold", "fixed-iterations"],
    "default": "score-threshold",
    "description": "收敛模式。'score-threshold' = 基于聚合度+忠诚度评分自动收敛;'fixed-iterations' = 固定跑 maxIterations 次。"
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

### 5.2 Recon Aggregator 输出扩展

```typescript
interface ReconAggregatorOutput {
  /** 整合后的 summary */
  summary: string;
  /** 跨 Recon 缺口(已有) */
  crossReconGaps: string[];

  // === v0.22.0 新增 ===
  /** 聚合度评分(0-1):多 Recon 信息的整合完整度 */
  aggregationScore: number;
  /** 忠诚度评分(0-1):整合后内容对原始 Recon 的忠实程度(无歪曲/无补充) */
  fidelityScore: number;
  /** 自评:是否需要再迭代一次 */
  needsReiteration: boolean;
  /** 自迭代次数(实际跑了多少次) */
  iterationsCompleted: number;
}
```

### 5.3 评分语义

**聚合度(Aggregation Score)**:

- **0.9-1.0**:所有 Recon 的关键信息都已整合,无遗漏
- **0.7-0.9**:大部分信息已整合,有少量遗漏(可接受)
- **0.5-0.7**:有明显遗漏,建议再迭代
- **< 0.5**:严重遗漏,必须再迭代(或回 Recon 补查)

**忠诚度(Fidelity Score)**:

- **0.9-1.0**:完全忠实于原始 Recon,无歪曲/补充/解读
- **0.7-0.9**:基本忠实,有极少量合理推断(已标注)
- **0.5-0.7**:有可察觉的歪曲或补充(Refs 可能受影响)
- **< 0.5**:严重歪曲原始证据(Refs 必须重新评估)

### 5.4 自迭代触发逻辑

```
iter 1:
  Recon Aggregator 整合 → 输出 aggregationScore + fidelityScore
  
  if convergenceMode == 'score-threshold':
    if aggregationScore >= threshold AND fidelityScore >= threshold:
      收敛 ✓
    else if iter < maxIterations:
      needsReiteration = true  // 进入 iter 2
    else:
      强制输出 + 标注 "(recon_aggregator 未完全收敛)"
  
  if convergenceMode == 'fixed-iterations':
    跑满 maxIterations 次后输出
```

---

## §6. 用户自定义的技术实现

### 6.1 配置存储

**方案 A(推荐)**:独立文件 `~/.moa/role-setup-presets.json`

```json
{
  "version": "1.0",
  "activePreset": "strict-researcher",
  "presets": [
    {
      "name": "strict-researcher",
      "description": "严谨研究者:适合学术研究、文献综述、数据分析任务",
      "defaultLanguage": "zh-CN",
      "aiGenerated": { "enabled": true, "autoAccept": false },
      "roles": {
        "recon": {
          "tone": "strict-evidence",
          "perspective": "优先 PubMed/bioRxiv 等权威学术数据库",
          "toolPriority": ["mcp_unified-acade_*", "fetch_webpage", "read_file"],
          "cautions": ["不擅自解读数据", "保留所有 p-value"]
        },
        "reconAggregator": {
          "tone": "faithful-integrator",
          "focus": ["去重", "识别与保留冲突", "证据质量分级"]
        },
        "refs": { "tone": "neutral-judge" },
        "aggregator": { "tone": "neutral-judge" },
        "actor": {
          "tone": "strict-executor",
          "cautions": ["不自动 git commit"]
        }
      },
      "createdAt": "2026-07-21T10:00:00",
      "updatedAt": "2026-07-21T10:00:00"
    },
    {
      "name": "quick-coder",
      "description": "Quick Coder: 适合代码修改、调试、重构任务",
      "defaultLanguage": "en",
      "aiGenerated": { "enabled": false, "autoAccept": false },
      "roles": { ... }
    }
  ]
}
```

**方案 B(备选)**:存到 VSCode settings.json 的 `moa.roleSetupPresets` 数组。

**选择 A 的理由**:

- 独立文件便于版本控制(git)
- 用户可直接编辑(不需要 VSCode UI)
- 跨机器同步方便(放进 dotfiles)

### 6.2 配置 UI(VSCode 命令)

新增命令(注册到 package.json):

| 命令 ID                          | 功能                                                             |
| -------------------------------- | ---------------------------------------------------------------- |
| `moa.createRoleSetupPreset`      | 创建新的 Role Setup Preset(弹出 untitled JSON 让用户编辑)     |
| `moa.switchRoleSetupPreset`      | 切换当前 active preset(QuickPick 列表)                         |
| `moa.editRoleSetupPreset`        | 编辑现有 preset(打开 JSON 文件)                                |
| `moa.deleteRoleSetupPreset`      | 删除 preset                                                      |
| `moa.exportRoleSetupPreset`      | 导出为 JSON 文件(便于分享)                                     |
| `moa.importRoleSetupPreset`      | 从 JSON 文件导入                                                 |
| `moa.toggleAIGeneration`         | 快速开关 AI 生成(状态栏按钮)                                   |
| `moa.togglePlanModeReport`       | 快速开关 Plan Mode 实时报告                                      |

### 6.3 与模型预设的协同

**模型预设 + 角色设定预设 = 完整工作流配置**:

```
用户在 VSCode 中:
1. "Moa: Switch Preset" → 选模型预设(决定 LLM)
2. "Moa: Switch Role Setup Preset" → 选角色设定预设(决定 prompt 风味)
3. `@moa <任务>` → 启动 MoA 流水线
```

**Plan Mode 报告中显示两者**:

```
📋 MoA Plan 已生成
─────────────────────────────────
模型预设: cost-effective (DeepSeek-V4-Flash + MiniMax-M3)
角色设定: strict-researcher (严谨研究者)
流程语言: zh-CN
```

---

## §7. Final.md 在主会话内展示(用户额外要求)

> 用户原话:"在最终的主会话的输出中,感觉还是很草率,我觉得直接将 final.md 直接在会话内展现出来,或者如果太长,将其缩略提炼后展示出来也是可以的,关键信息也能在上下文暴露,让下一轮对话能够直接获取相应的信息而不必调取工具去多轮次查询与验证。"

### 7.1 当前问题(v0.21.x)

- final.md 写到 `.moa_cache/<task_id>/final.md`,主会话只显示一句"任务完成,见 .moa_cache/..."
- 下一轮对话若要参考上一轮结果,必须 read_file 调取 final.md(多一次工具调用)
- 关键信息(关键发现、决策、action_items)不在上下文中

### 7.2 v0.22.0 改进策略

**分级展示**(根据 final.md 长度):

| final.md 长度 | 展示策略                                                               |
| ------------- | ---------------------------------------------------------------------- |
| < 2000 字符   | **完整内嵌**到主会话 Markdown 响应                                     |
| 2000-8000 字符 | **摘要 + 关键信息内嵌** + 完整内容链接到 final.md                      |
| > 8000 字符   | **结构化摘要**(TL;DR + 关键发现 top 5 + action_items)+ 链接到 final.md |

### 7.3 内嵌模板(主会话响应)

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

### 7.4 实现位置

修改 [src/moaHandler.ts](../src/moaHandler.ts) 的 ChatRequestHandler 退出逻辑:

```typescript
// 现状(v0.21.x):
// task complete → progress report → "见 .moa_cache/..."

// v0.22.0:
// task complete → 读 final.md → 按长度分级展示 → 内嵌 Markdown → 工作区链接
```

---

## §8. 端口与工具获取能力验证(用户原话 #1.1)

> 用户原话:"同时也要测试相应的端口与工具特别是信息能否获取到。"

### 8.1 验证目标

在 v0.22.0 实施前,必须验证以下信息源**确实可获取**:

| 信息源                | API                                                                      | 验证方法                                   |
| --------------------- | ------------------------------------------------------------------------ | ------------------------------------------ |
| Active editor         | `vscode.window.activeTextEditor`                                         | 在 moaDev.test.ts 写测试                   |
| Open documents        | `vscode.workspace.textDocuments`                                         | 同上                                       |
| Workspace folders     | `vscode.workspace.workspaceFolders`                                      | 同上                                       |
| Project tree          | `fs.readdir`(递归)                                                     | 同上                                       |
| Git root              | `child_process.execSync('git rev-parse --show-toplevel')`                | 同上                                       |
| Instruction files     | `fs.readFile(7 路径)`                                                   | 同上                                       |
| Skill folders         | `fs.readdir(4 文件夹)` + 读 SKILL.md frontmatter                       | 同上                                       |
| Available LM tools    | `vscode.lm.tools`(或 `vscode.lm.selectChatModels`?)                  | 同上                                       |
| Available LM models   | `vscode.lm.selectChatModels({})`                                         | 同上                                       |
| Active model preset   | `getActivePresetConfig()`                                                | 同上                                       |

### 8.2 诊断命令

新增命令 `moa.diagnoseEnvironment`:

- 跑全部 10 个信息源测试
- 输出到 OutputChannel + 弹出 Markdown 报告
- 报告含每个信息源的:✅ 可获取 / ❌ 失败(原因)/ ⚠️ 部分获取

**报告示例**:

```markdown
# MoA Environment Diagnostics

**运行时间**: 2026-07-21 14:30:15
**VSCode**: 1.95.0
**MoA**: v0.22.0

## 信息源验证

| # | 信息源             | 状态 | 详情                                         |
|---|--------------------|------|----------------------------------------------|
| 1 | Active editor      | ✅   | src/foo.ts (TypeScript, 1234 lines)         |
| 2 | Open documents     | ✅   | 5 documents open                            |
| 3 | Workspace folders  | ✅   | 1 folder: d:\...\vscode-moa                 |
| 4 | Project tree       | ✅   | 247 entries (depth=6, maxEntries=2000)      |
| 5 | Git root           | ✅   | d:\...\vscode-moa                            |
| 6 | Instruction files  | ⚠️   | Found: CLAUDE.md (workspace) only            |
| 7 | Skill folders      | ✅   | ~/.copilot/skills: 47 skills                 |
| 8 | LM tools           | ✅   | 213 tools available                          |
| 9 | LM models          | ✅   | 12 models (3 vendors)                        |
| 10| Active preset      | ✅   | cost-effective                               |

## 警告

- ⚠️ 仅发现 1 个指令文件(workspace CLAUDE.md)。考虑添加 ~/.claude/CLAUDE.md 用于全局指令。
```

### 8.3 端口连通性测试(若 MoA 使用任何本地端口)

若 v0.22.0 引入了本地服务(如 webview panel 的 dev server),需测试端口连通性。当前 v0.22.0 设计无本地服务,此节 N/A。

---

## §9. 设计美学指南(用户原话 #1.3)

> 用户原话:"要有专门的技术篇章给用户指导如何设置与使用,每个的设计美学是什么样的,最大程度给用户一个可用的独立的自迭代与自设定的 ai 模型。"

### 9.1 6 角色的设计美学(给用户的指南)

#### Planner 的美学:**参谋长哲学**

- **不回答,只规划**:Planner 永远不在 clarified_task 写"答案是 X"
- **消化不中继**:把 ENV_CONTEXT 等原始信息消化成 role_setup,不是简单转发
- **节制迭代**:默认 5 次,简单任务 1-2 次收敛,复杂任务不超 20 次
- **敢于问用户**:信息严重不足时触发 ask_user,不硬撑

**用户自定义建议**:

- 研究类任务:Planner 用强推理模型(GLM-5.2 / Claude Sonnet)
- 代码类任务:Planner 可用便宜模型(DeepSeek-V4-Flash 够用)
- 不需要自定义 Planner 的 tone(它是规划者,语气不重要)

#### Recon 的美学:**侦察兵哲学**

- **多角度**:同一主题用 2-3 个关键词角度搜,覆盖面广
- **链式深入**:搜索 → 发现相关 → fetch 全文 → 再搜引用
- **保留原味**:不归因、不解读、不补全,只保留数字/引用/关键句
- **警惕噪音**:SEO 垃圾、低质量博客要过滤

**用户自定义建议**:

- 学术研究:`tone=strict-evidence`,tool_priority 偏向 PubMed/bioRxiv
- 代码调研:`tone=strict-evidence`,tool_priority 偏向 read_file/grep_search
- 市场调研:`tone=creative-explorer`(容忍推测),tool_priority 偏向 web search

#### Recon Aggregator 的美学:**侦查大队长哲学**

- **忠实**:不补充不解读,只整合
- **识别与保留冲突**(用户修订):冲突是 Refs 判断的重要来源,不强行消歧
- **质量分级**:每条证据标注 high/medium/low confidence
- **自迭代节制**:默认 1 次,深度任务最多 10 次

**用户自定义建议**:

- 文献综述:focus 加"引用格式标准化"
- 代码 review:focus 加"代码片段完整保留"
- 数据分析:focus 加"数据来源标注"

#### Refs 的美学:**参谋联席会哲学**

- **完全同质**:所有 Refs 看同一份 evidence + 固定 prompt,差异来自模型
- **独立判断**:每个 Ref 不看其他 Ref 的输出
- **多视角**:不同模型有不同偏见,多模型并行抵消

**用户自定义建议**:

- **不要**给 Refs 不同的 role_setup(破坏多模型可比性)
- 选择异构模型(不同厂商 / 不同架构)最大化多样性
- 3-5 个 Refs 最佳(< 3 多样性不足,> 5 成本高收益低)

#### Aggregator 的美学:**司令哲学**

- **中立**:只看 refs 输出 + evidence,不被任何 role_setup 带偏
- **果断**:能 finalize 就 finalize,不为"完整"强行多轮
- **透明**:evidence_coverage 评分必须诚实

**用户自定义建议**:

- **不要**给 Aggregator 不同的 role_setup(破坏中立裁判)
- Aggregator 用强推理模型(GLM-5.2 / Claude Sonnet 级别)
- 不需要自定义 tone(中立是核心)

#### Actor 的美学:**工兵哲学**

- **严格**:按 action_items 顺序执行,不自作主张
- **诚实**:失败就如实记录,不撒谎
- **破坏性操作前问用户**(默认):除非用户配 `executionPreset='autopilot'`

**用户自定义建议**:

- 谨慎场景:`tone=conservative`,cautions 加"git commit 前必问"
- 自动化场景(CI):`tone=aggressive`,但**仅在你完全信任的任务上**
- 默认:`tone=strict-executor`

### 9.2 推荐预设组合(开箱即用)

v0.22.0 内置 5 个 Role Setup Preset:

| 预设名                | 适用场景                       | 关键设定                                                                       |
| --------------------- | ------------------------------ | ------------------------------------------------------------------------------ |
| `strict-researcher`   | 学术研究、文献综述、数据分析   | Recon=strict-evidence,RA=faithful-integrator,Actor=strict-executor             |
| `quick-coder`         | 代码修改、调试、重构           | Recon=strict-evidence(tool_priority 偏代码),Actor=strict-executor             |
| `creative-explorer`   | 创意写作、brainstorm、设计    | Refs=creative-explorer,Recon=creative-explorer                                |
| `conservative-mode`   | 生产环境、敏感数据、不可逆操作 | Actor=conservative,所有 cautions 加"破坏性操作前问用户"                       |
| `auto-pilot`          | CI/CD、批量任务、低风险场景    | Actor=aggressive,aiGenerated.autoAccept=true                                  |

用户可基于这 5 个修改,或从零创建。

### 9.3 长期 memory = MoA 角色设定(用户原话 #1.3)

> 用户原话:"所谓的长期 memory,也就是 moa 角色的设定,我认为也可以有类似于 moa 模型选择的建构方式。"

**解读**:用户把"角色设定预设"视为 MoA 的"长期 memory"—— 跨任务、跨会话持久的用户偏好。

**实现**:

- Role Setup Preset 存到 `~/.moa/role-setup-presets.json`(跨会话持久)
- 用户可导出分享(给团队 / 给社区)
- 社区可分享预设(类似 VSCode 主题市场,但更轻量)
- v0.23+ 可考虑集成到 VSCode Marketplace(vsx 文件包含预设)

---

## §10. 实施优先级与依赖

| 任务                                    | 优先级 | 依赖                       | 工作量    |
| --------------------------------------- | ------ | -------------------------- | --------- |
| §1 RoleSetupPreset 数据结构             | P0     | 无                         | 0.5 天    |
| §3 Tone 限定系统(7 个 tone)          | P0     | §1                         | 1 天      |
| §6.1 配置存储 + 加载                    | P0     | §1                         | 1 天      |
| §6.2 配置 UI(8 个命令)               | P0     | §6.1                       | 2 天      |
| §2 AI 生成开关(3 层)                  | P0     | §1                         | 0.5 天    |
| §8 端口/工具验证(moa.diagnoseEnvironment) | P0     | 无                         | 1 天      |
| §4 Plan Mode 实时报告                   | P0     | §2 + planner-system-prompt | 3-4 天    |
| §5 Recon Aggregator 自迭代 + 评分       | P0     | 无                         | 1 天      |
| §7 final.md 主会话展示                  | P1     | 无                         | 1 天      |
| §9.2 内置 5 个预设                      | P1     | §1 + §3                    | 0.5 天    |
| §9.1 设计美学指南(本文档)             | P2(文档) | 无                       | 已完成    |
| **总计**                                |        |                            | **12-14 天** |

**与原 v0.22.0 路线图的关系**:

本文档新增的任务合并到 [roadmap/v0.22.0-role-injection-overhaul.md](roadmap/v0.22.0-role-injection-overhaul.md),形成 v0.22.0 完整 scope(原 6-10 天 + 本 12-14 天 = **18-24 天**,约 4 周)。

---

## §11. 开放问题(待用户最终决策)

1. **Role Setup Preset 存储位置**:`~/.moa/role-setup-presets.json`(独立文件)vs VSCode settings.json?(默认:独立文件)
2. **Tone 是否真的限定 7 个**?是否需要 `custom` 第 8 个?(默认:7 个 + custom)
3. **Plan Mode 报告是 vscode_askQuestions 还是 Webview**?(默认:vscode_askQuestions,更轻量)
4. **Recon Aggregator 评分阈值**(0.85)?(默认:0.85,可配置)
5. **final.md 内嵌阈值**(2000/8000 字符)?(默认:是)
6. **内置 5 个预设的命名与定位**?(默认:strict-researcher / quick-coder / creative-explorer / conservative-mode / auto-pilot)
7. **是否支持预设分享到社区**(v0.22.0 或 v0.23+)?(默认:v0.23+)

---

## §12. 参考资料

- [moa-role-injection-design.md](moa-role-injection-design.md) — 注入矩阵主总览
- [moa-role-design-philosophy.md](moa-role-design-philosophy.md) — 设计哲学(本文档是其扩展)
- [planner-system-prompt.md](planner-system-prompt.md) — Planner 提示词(Plan Mode 在 §4 详述)
- [copilot-system-message-sections.md](copilot-system-message-sections.md) — Copilot 12 sections 参考
- [roadmap/v0.22.0-role-injection-overhaul.md](roadmap/v0.22.0-role-injection-overhaul.md) — 路线图(本文档任务合并入此)
- `C:\Users\Administrator\AppData\Roaming\Code\User\globalStorage\github.copilot-chat\plan-agent\Plan.agent.md` — Copilot Plan Agent(启发源,不照搬)
- [src/presetConfig.ts](../src/presetConfig.ts) — 现有模型预设(本文档角色预设借鉴其结构)
