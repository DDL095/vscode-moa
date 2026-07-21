/**
 * moaCore/roles.ts — v0.15.0 共享角色类型与 prompt 模板
 *
 * 这是 5 角色（Planner / Recon / Refs / Aggregator / Actor）的统一类型定义
 * 与 prompt 构建函数。被 moaOrchestrator.ts（orchestrate）和 moaRunner.ts
 * （analyze）共同复用，避免两套独立的 prompt 代码。
 *
 * 设计哲学：
 *   - 类型集中：所有角色的输入输出类型都在这里
 *   - Prompt 模板集中：每个角色一个 build*Prompt 函数
 *   - 解析函数集中：extractJson / extractPlannerOutput 等
 */

import type * as vscode from 'vscode';

// ─────────────────────────────────────────────────────────────────────────
// Planner 角色类型
// ─────────────────────────────────────────────────────────────────────────

/**
 * Planner 输出。
 *
 * v0.22.0 P0-1: 扩展为 13 字段 schema(7 个原有 + 6 个新增 + role_setup)。
 * 新增字段全部可选,保证 v0.21.x 解析仍能工作(若 LLM 未输出,使用默认值)。
 *
 * 完整设计见 docs/planner-system-prompt-v2.md §5(输出 schema)。
 */
export interface PlannerOutput {
  // === v0.21.x 原有字段(保留) ===
  /** 1-2 句话清晰描述任务目标（去模糊化）。 */
  clarified_task: string;
  /** Recon 该查的具体子问题（最多 5 个）。 */
  sub_questions: string[];
  /** 搜索关键词、可能的文件路径、URL 等（最多 8 条）。 */
  recon_hints: string[];
  /** 预期输出形式（影响 final.md 的 action_item 类型）。 */
  expected_output_format: 'report' | 'comparison' | 'code' | 'analysis' | 'document' | 'other';
  /** Planner 判断的难度（影响 MAX_ITER 建议）。 */
  difficulty: 'simple' | 'moderate' | 'complex' | 'research';
  /** Planner 自己判断是否需要多轮（false = 简单任务，建议单次走 analyze）。 */
  needs_iteration: boolean;

  // === v0.22.0 P0-1 新增字段(全部可选,LLM 未输出时用默认值) ===

  /**
   * v0.22: 任务类型(agent 化判断,不僵化套模板)。
   * 默认:从 difficulty 推断(research→research, complex→hybrid, ...)。
   */
  task_type?: 'research' | 'coding' | 'documentation' | 'analysis' | 'hybrid';

  /**
   * v0.22: 流程语言(所有下游角色按此语言输出)。
   * 默认:从 user prompt 启发式检测。
   * 取值:'zh-CN' | 'en' | 'mixed' | 'ja' | 'ko' | 'fr' | 'de' | ...
   */
  process_language?: string;

  /**
   * v0.22 mini-loop: Planner 自评规划完整度(0-1)。
   * 默认:1.0(视为已收敛,v0.21.x 兼容)。
   * 收敛阈值:moa.plannerCoverageThreshold(默认 0.9)。
   */
  plan_coverage?: number;

  /**
   * v0.22 mini-loop: 是否需要再迭代一次。
   * 默认:true(自迭代是 Planner 核心能力)。
   * 收敛时设为 false。
   */
  needs_replan?: boolean;

  /**
   * v0.22 mini-loop: 是否需要询问用户(任务超出 Planner 规划能力)。
   * 默认:false(避免打扰)。
   * 触发条件:plan_coverage < 0.5 且 iter >= 2。
   */
  ask_user?: boolean;

  /**
   * v0.22 mini-loop: 要问用户的具体问题(最多 3 个,每个含推荐答案)。
   * 仅 ask_user=true 时有意义。
   */
  ask_user_questions?: string[];

  /**
   * v0.22 P0-1: 下游 3 角色定制(Refs/Aggregator 完全不可定制,架构红线)。
   * 默认:每个角色用 v0.21.x 静态 prompt fallback。
   */
  role_setup?: PlannerRoleSetup;
}

/**
 * Planner 给下游 3 角色的定制(对齐 docs/planner-system-prompt-v2.md §5)。
 *
 * 架构红线:
 *   - 没有 role_setup.refs 和 role_setup.aggregator(完全不可定制)
 *   - 保证多模型可比性 + 中立裁判
 */
export interface PlannerRoleSetup {
  recon?: PlannerReconRoleSetup;
  recon_aggregator?: ReconAggregatorRoleSetup;  // 复用 P0-4 已定义的类型
  actor?: PlannerActorRoleSetup;
}

/** Planner 给 Recon 的角色定制。 */
export interface PlannerReconRoleSetup {
  /** v0.22: tone 限定枚举(对齐 docs/moa-role-design-philosophy-v2.md §3) */
  tone?: 'strict-evidence' | 'creative-explorer' | 'conservative';
  /** 自由文本:分析视角 */
  perspective?: string;
  /** 推荐工具/skill 列表(排序后的完整列表,不拆分,不限定) */
  tool_priority?: string[];
  /** 注意事项 */
  cautions?: string[];
}

/** Planner 给 Actor 的角色定制。 */
export interface PlannerActorRoleSetup {
  /** tone 限定枚举 */
  tone?: 'strict-executor' | 'conservative' | 'aggressive';
  /** 自由文本:执行视角 */
  perspective?: string;
  /** 推荐工具列表(独立排序,可与 recon 不同) */
  tool_priority?: string[];
  /** 注意事项(如 "破坏性操作前问用户") */
  cautions?: string[];
}

// ─────────────────────────────────────────────────────────────────────────
// v0.22.0 P0-4: Recon Aggregator role_setup 类型(双轨制)
// ─────────────────────────────────────────────────────────────────────────

/**
 * Recon Aggregator 的角色设定(由 Planner 通过 role_setup.recon_aggregator
 * 传入,实现"双轨制" — default 模式用内置 prompt,planner 模式用此字段)。
 *
 * tone 限定枚举(对齐 docs/moa-role-design-philosophy-v2.md §3):
 *   - 'faithful-integrator' (默认): 保留原证据,做去重/排序/识别与保留冲突
 *   - 'strict-evidence': 严格证据模式,不做任何整合性推理
 *   - 'creative-explorer': 鼓励识别跨 recon 的隐性主题
 *   - 'conservative': 仅做最小去重,尽量保留原文
 *
 * 整合原则(对齐 v2 设计):
 *   "去重 / 排序 / 识别与保留冲突 / 缺口识别 / 证据质量分级"
 *   (不再"消歧" — 冲突是 Refs 分析的重要素材)
 */
export interface ReconAggregatorRoleSetup {
  tone?: 'faithful-integrator' | 'strict-evidence' | 'creative-explorer' | 'conservative';
  /** 自由文本:整合视角(Planner 给的现场指导)。 */
  perspective?: string;
  /** 整合重点(Planner 强调的关键操作,如 ["去重", "识别与保留冲突", ...])。 */
  focus?: string[];
}

/**
 * 构建 Planner 的 system + user prompt。
 *
 * v0.21.x: 单次调用签名 `buildPlannerPrompt(userPrompt)`(向后兼容)。
 * v0.22.0 P0-1: 扩展为接受可选 options,启用 mini-loop 时注入完整 v2 模板。
 *
 * 设计(对齐 docs/planner-system-prompt-v2.md):
 *   - 不传 options 或 options.v22=false → 走 v0.21.x 简洁模板(单次调用)
 *   - 传 options.v22=true → 走 v0.22 完整模板(mini-loop + role_setup + 入口类型 + etc)
 *
 * 调用方:runPlanner.ts 根据配置项 moa.enablePlannerIteration 决定传哪个。
 */
export function buildPlannerPrompt(
  userPrompt: string,
  options?: {
    /**
     * v0.22: 启用完整 v2 模板(默认 false,走 v0.21.x 简洁模板)。
     * 由 runPlanner 根据 moa.enablePlannerIteration 自动决定。
     */
    v22?: boolean;
    /** v0.22: 当前 mini-loop 迭代号(从 1 开始)。 */
    iteration?: number;
    /** v0.22: 上一轮 plan_coverage(iter >= 2 时注入)。 */
    prevCoverage?: number;
    /** v0.22: MoA 入口类型(@moa/@moaloop/@moasingle/moa_analyze/moa_orchestrate)。 */
    entryType?: string;
    /** v0.22: 基础设施层注入文本(由 systemContext.ts renderForRole('planner') 生成)。 */
    systemContextText?: string;
    /** v0.22: 用户自定义 few-shot(从 Role Setup Preset 加载,v3 默认空字符串)。 */
    fewShotsText?: string;
  }
): { system: string; user: string } {
  // ── v0.21.x 兼容路径 ──
  if (!options?.v22) {
    return buildPlannerPromptV21(userPrompt);
  }

  // ── v0.22 完整模板 ──
  const {
    iteration = 1,
    prevCoverage,
    entryType = '@moa',
    systemContextText = '',
    fewShotsText = '',
  } = options;

  // 完整模板(简化版,涵盖 planner-system-prompt-v2.md §1 的核心要点)
  const system = [
    '你是一位 MoA(Mixture-of-Agents)流水线的 Planner —— 一个**可迭代智能路由 + 多角色身份设计师**。',
    '',
    '## 第一部分:MoA 完整循环',
    '',
    'MoA 是 6 角色多智能体流水线:',
    '  [你 Planner] → Recon(N 个并行) → Recon Aggregator(始终运行)',
    '                → Refs(N 个并行,固定设定) → Aggregator(固定,中立裁判)',
    '                → Actor(全工具权限) → 循环或 finalize',
    '',
    '**关键约束**:',
    '- Refs 和 Aggregator **完全不可定制**(架构红线:保证多模型可比性 + 中立裁判)',
    '- 你**只能**定制 3 个角色:Recon / Recon Aggregator / Actor',
    '- 你的 role_setup 是**软建议**,下游保留判断权',
    '',
    '## 第二部分:你的 6 项核心职责',
    '',
    '1. **任务去模糊化**(在 clarified_task 中补全隐含假设 + 标注歧义点)',
    '2. **任务拆解 + 子问题设计**(sub_questions 最多 5 个,必须是 Recon 能用工具验证的)',
    '3. **工作环境/工具能力/用户指令的消化者**(从动态注入的 4 段内容提炼,不原样塞给下游)',
    '4. **下游 3 角色的身份设计师**(通过 role_setup 字段定制)',
    '5. **流程语言决策者**(检测用户 prompt 主导语言,所有下游按此语言输出)',
    '6. **自身迭代的自评者**(通过 plan_coverage 决定何时收敛)',
    '',
    '## 第三部分:工作环境与工具能力(动态注入)',
    '',
    systemContextText,
    '',
    '## 第四部分:迭代状态 + MoA 入口类型',
    '',
    `当前 mini-loop 迭代:${iteration}`,
    `上一轮 plan_coverage:${prevCoverage !== undefined ? prevCoverage : '(iter 1,无上一轮)'}`,
    `MoA 入口类型:${entryType}`,
    '',
    '**MoA 入口类型对 needs_iteration 决策的影响**:',
    '- @moa / @moaloop / moa_orchestrate → **强制 needs_iteration=true**(用户选 loop 入口)',
    '- @moasingle / moa_analyze → **强制 needs_iteration=false**(单次模式不支持多轮)',
    '- 你的 needs_iteration 字段必须同时考虑任务复杂度 + 入口类型',
    '',
    '## 第五部分:输出 schema(严格 JSON,不要 markdown fence)',
    '',
    '{',
    '  "clarified_task": "<1-3 句话清晰描述任务目标,补全隐含假设,标注歧义点>",',
    '  "process_language": "zh-CN | en | mixed | ja | ko | fr | de | ...",',
    '  "sub_questions": ["<Recon 必须回答的具体子问题,每个都要能被工具验证>", ...],',
    '  "recon_hints": ["<具体文件路径/搜索关键词/URL/DOI/skill 名/数据库名>", ...],',
    '  "expected_output_format": "report | comparison | code | analysis | document | roadmap | other",',
    '  "difficulty": "simple | moderate | complex | research | engineering",',
    '  "task_type": "research | coding | documentation | analysis | hybrid",',
    '  "needs_iteration": 「true 表示需要 MoA 多轮; false 表示单次完成」',
    '',

    '  "plan_coverage": 「0-1, 默认 0.9 收敛,本次规划完整度的自评」,',
    '  "needs_replan": 「true 表示需要再迭代; false 表示已收敛。**默认 true**」,',
    '  "ask_user": 「true 表示需要用户澄清; false 表示不需要。**默认 false**」,',
    '  "ask_user_questions": ["<仅 ask_user=true 时填: 最多 3 个>"],',
    '',
    '  "role_setup": {',
    '    "recon": {',
    '      "tone": "strict-evidence | creative-explorer | conservative",',
    '      "perspective": "<自由文本>",',
    '      "tool_priority": ["<推荐工具/skill 名,排序后的完整列表>"],',
    '      "cautions": ["<注意事项>"]',
    '    },',
    '    "recon_aggregator": {',
    '      "tone": "faithful-integrator | strict-evidence",',
    '      "perspective": "<自由文本>",',
    '      "focus": ["去重", "识别与保留冲突", "缺口识别", "证据质量分级"]',
    '    },',
    '    "actor": {',
    '      "tone": "strict-executor | conservative | aggressive",',
    '      "perspective": "<自由文本>",',
    '      "tool_priority": ["<推荐工具,排序后的完整列表>"],',
    '      "cautions": ["<破坏性操作前的注意>"]',
    '    }',
    '  }',
    '}',
    '',
    '**注意**:**没有** role_setup.refs 和 role_setup.aggregator 字段(架构红线)。',
    '',
    '## 第六部分:决策准则',
    '',
    '### difficulty 评分',
    '- simple: 单一事实查询、概念解释',
    '- moderate: 对比分析、简单代码生成、单文档撰写',
    '- complex: 多步推理、多文件协调、需要 Actor 执行',
    '- research: 深度文献调研、跨学科综合',
    '- engineering: 复杂工程任务:架构设计、大规模重构',
    '',
    '### needs_iteration 决策(综合任务复杂度 + MoA 入口类型)',
    '详见第四部分表格 — 入口类型强制倾向,任务复杂度作辅',
    '',
    '### role_setup 设计哲学',
    '1. **定向不限定(打猎哲学)**:给 Recon 推荐工具,但**不限定**它必须用',
    '2. **agent 化,不僵化**:不同 task_type 的 role_setup 应明显不同,但根据现场灵活调整',
    '3. **工具太多时识别后排序(不拆分)**:识别所有相关工具 → 排序 → 完整列表给 recon 和 actor(各自独立排序)',
    '',
    '## 第七部分:典型场景示例(用户可外部自定义)',
    '',
    fewShotsText || '(用户未自定义 few-shot 示例 — 仅依赖以上规则描述工作)',
    '',
    '## 第八部分:迭代收敛规则',
    '',
    '你处于 mini-loop(默认 5 次,绝对上限 20 次)。收敛路径三选一:',
    '- **路径 A(自然收敛)**:plan_coverage >= 0.9 → needs_replan=false',
    '- **路径 B(强制收敛)**:iter >= 5 且 plan_coverage < 0.9 → needs_replan=false + clarified_task 末尾标注 "(planner 未完全收敛)"',
    '- **路径 C(询问用户)**:plan_coverage < 0.5 且 iter >= 2 → ask_user=true + ask_user_questions',
    '',
    '**绝对上限**:iter >= 20 强制路径 B',
    '',
    '**默认值**:',
    '- plan_coverage 默认目标:**0.9**',
    '- needs_replan 默认:**true**(自迭代是核心能力)',
    '- ask_user 默认:**false**(避免打扰)',
    '',
    '## 第九部分:工具权限(iter 1+ 开放,仅概念澄清)',
    '',
    '允许调用:read_file / list_dir / grep_search / get_errors / web_search(仅概念澄清)',
    '禁止调用:任何写工具 / run_in_terminal / 浏览器工具 / 学术数据库 MCP / 网页抓取(那是 Recon 的活)',
    '每轮迭代最多调 3 次工具(防止过度探索)',
    '',
    '## 第十部分:最后的提醒',
    '',
    '- 你不是回答者,你是规划者',
    '- 你不是调研者(除了概念澄清),你是工具能力的设计师',
    '- Refs 和 Aggregator 你完全不能定制',
    '- 如果任务超出你的能力,触发 ask_user,不要硬撑',
    '- 语言决策一旦做出,不要在 mini-loop 中途改变',
    '- needs_iteration 决策受 MoA 入口类型约束',
  ].join('\n');

  const user = [
    '### 用户的原始任务',
    '',
    userPrompt,
  ].join('\n');

  return { system, user };
}

/**
 * v0.21.x Planner prompt 模板(向后兼容 fallback)。
 *
 * 当 moa.enablePlannerIteration=false 或 mini-loop 失败时,使用此简洁模板。
 */
function buildPlannerPromptV21(userPrompt: string): { system: string; user: string } {
  const system = [
    '你是 MoA 流水线的 Planner（规划者）。',
    '',
    '你的职责是把用户的原始问题**理解、去模糊化、拆解**，为下游的 Recon（侦察）角色提供清晰的方向。',
    '你不调用任何工具，只做任务分析和规划。',
    '',
    '严格按 JSON 格式输出（不要 markdown fence，不要前后多余文字）：',
    '{',
    '  "clarified_task": "<1-2 句话清晰描述任务目标>",',
    '  "sub_questions": ["<Recon 该查的具体子问题>", ...],  // 最多 5 个',
    '  "recon_hints": ["<搜索关键词/文件路径/URL 等>", ...],  // 最多 8 条',
    '  "expected_output_format": "report | comparison | code | analysis | document | other",',
    '  "difficulty": "simple | moderate | complex | research",',
    '  "needs_iteration": 「true 表示复杂任务需要多轮，false 表示简单任务可单次完成」',
    '}',
    '',
    '判断准则：',
    '- simple: 单一事实查询、概念解释（如"什么是冬眠"）',
    '- moderate: 对比分析、简单代码生成（如"对比 PG 和 MySQL"）',
    '- complex: 多步推理、需要查多个资料源（如"实现一个完整功能"）',
    '- research: 需要深度调研、不确定答案（如"前沿技术对比"）',
    '',
    'sub_questions 必须是 Recon 能用工具（readFile/grep/fetch_webpage）回答的具体问题，',
    '不要写"分析一下"、"了解一下"这种模糊表述。',
    'recon_hints 要给出具体的搜索词、文件路径、URL，让 Recon 不用从零开始。',
    '',
    '匹配任务语言（中文任务 → 中文输出）。',
  ].join('\n');

  const user = [
    '用户的原始任务：',
    '',
    userPrompt,
  ].join('\n');

  return { system, user };
}

// ─────────────────────────────────────────────────────────────────────────
// v0.22.0 P0-1: Role setup 渲染辅助函数
// ─────────────────────────────────────────────────────────────────────────

/**
 * 把 PlannerReconRoleSetup 渲染为注入到 buildReconPrompt 的 roleSetupText 字符串。
 *
 * 输出格式(拼到 prompt 开头):
 *   Tone: <tone> — <tone label>
 *   Perspective: <perspective>
 *   Tool priority: <tool_priority joined>
 *   Cautions: <cautions joined>
 */
export function renderReconRoleSetup(setup: PlannerReconRoleSetup): string {
  const lines: string[] = [];
  if (setup.tone) {
    const label: Record<NonNullable<PlannerReconRoleSetup['tone']>, string> = {
      'strict-evidence': '严谨证据(默认):保留所有数字/引用/关键句',
      'creative-explorer': '创造探索:鼓励非常规视角,容忍合理推测(标注 confidence)',
      'conservative': '保守模式:优先 .bak 备份,破坏性操作前必问',
    };
    lines.push(`Tone: ${setup.tone} — ${label[setup.tone]}`);
  }
  if (setup.perspective) lines.push(`Perspective: ${setup.perspective}`);
  if (setup.tool_priority && setup.tool_priority.length > 0) {
    lines.push(`Tool priority (推荐顺序,不限定): ${setup.tool_priority.join(' / ')}`);
  }
  if (setup.cautions && setup.cautions.length > 0) {
    lines.push(`Cautions: ${setup.cautions.join('; ')}`);
  }
  return lines.join('\n');
}

/**
 * 把 PlannerActorRoleSetup 渲染为注入到 buildActorPrompt 的 roleSetupText 字符串。
 */
export function renderActorRoleSetup(setup: PlannerActorRoleSetup): string {
  const lines: string[] = [];
  if (setup.tone) {
    const label: Record<NonNullable<PlannerActorRoleSetup['tone']>, string> = {
      'strict-executor': '严格执行(默认):严格按 action_items 顺序执行',
      'conservative': '保守模式:破坏性操作前必问,优先 .bak 备份',
      'aggressive': '激进模式:自动执行不问(仅 CI/CD 场景,危险)',
    };
    lines.push(`Tone: ${setup.tone} — ${label[setup.tone]}`);
  }
  if (setup.perspective) lines.push(`Perspective: ${setup.perspective}`);
  if (setup.tool_priority && setup.tool_priority.length > 0) {
    lines.push(`Tool priority (推荐顺序,不限定): ${setup.tool_priority.join(' / ')}`);
  }
  if (setup.cautions && setup.cautions.length > 0) {
    lines.push(`Cautions: ${setup.cautions.join('; ')}`);
  }
  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────
// Recon 角色类型
// ─────────────────────────────────────────────────────────────────────────

/**
 * Recon 触发原因（v0.15.0 新增，替代 v0.14.x 的 need_more_analysis）。
 * 指导 Recon 用什么策略。
 */
export type ReconReason =
  | 'initial'                // 首轮初始收集
  | 'missing_data'           // 缺具体事实/数据（让 Recon 查更多文件/网页）
  | 'need_deeper_analysis'   // 信息够了但需要换视角思考
  | 'actor_failed'           // Actor 执行失败（让 Recon 调查根因）
  | 'contradiction';         // Refs 之间矛盾（让 Recon 重点核查冲突点）

/**
 * Recon 的单轮产出（每轮 Recon 是一个小 loop，多轮工具调用后产出此结构）。
 */
export interface ReconResult {
  /** Recon 综合后的发现摘要（Markdown，注入下游 Refs 的 evidence 池）。 */
  summary: string;
  /** 本轮 Recon 调用的工具次数。 */
  tool_calls: number;
  /** 本轮 Recon 的 wall-clock 耗时（秒）。 */
  elapsed_sec: number;
  /** 早停原因（如果提前结束）。 */
  early_stop_reason?: 'saturated' | 'stagnant' | 'capped' | 'manual' | 'error';
  /** Recon 的内部 log（每个工具调用一条）。 */
  log: Array<{
    iteration: number;           // recon 内部 loop 计数
    tool_name: string;
    input_brief: string;         // 截断的工具输入
    result_chars: number;
    timestamp: string;
  }>;
  /** 如果 Recon 失败（LLM 崩溃等），error 非空。 */
  error?: string;
}

/**
 * 构建 Recon 的 prompt。
 *
 * 设计：**动态构建**——同一个函数根据 state 当前内容输出不同 prompt。
 * - 第 1 轮：注入 Planner 的 hint
 * - 后续轮：注入上轮 Aggregator 的 gaps + Actor 历史 + 累积 evidence 摘要
 *
 * @param userPrompt     用户的原始任务
 * @param planner        Planner 输出（首轮才有，后续传 undefined）
 * @param reason         本轮 Recon 触发原因
 * @param gaps           上轮 Aggregator 标记的 critical_gaps
 * @param actorLog       上轮 Actor 的执行日志（如有）
 * @param evidenceBrief  当前累积 evidence 的摘要（防止 Recon 重复查）
 * @param iteration      当前 orchestrate iteration（用于 prompt 上下文）
 */
export function buildReconPrompt(params: {
  userPrompt: string;
  planner?: PlannerOutput;
  reason: ReconReason;
  gaps: string[];
  actorLog?: string;
  evidenceBrief: string;
  iteration: number;
  /**
   * v0.22.0 P0-5: 基础设施层注入文本(ENV_CONTEXT + TOOL_EFFICIENCY +
   * CUSTOM_INSTRUCTIONS + RUNTIME_INSTRUCTIONS)。
   *
   * 由调用方(moaOrchestrator.ts)在 iter 1 通过 systemContext.renderForRole('recon')
   * 构建,缓存到 state 跨轮次复用。空字符串或不传时走 v0.21.x 行为(向后兼容)。
   */
  systemContextText?: string;
  /**
   * v0.22.0 P0-5: 角色身份层注入文本(Planner 给的 role_setup.recon 渲染)。
   * P0-1 实施后由调用方从 PlannerOutput.role_setup.recon 构建。
   */
  roleSetupText?: string;
}): { system: string; user: string } {
  const { userPrompt, planner, reason, gaps, actorLog, evidenceBrief, iteration,
          systemContextText, roleSetupText } = params;

  // v0.22.0 P0-5: 拼装 prefix(基础设施层 + 角色身份层)
  //   设计矩阵(对齐 docs/moa-role-injection-design.md §4.2):
  //     Recon 看: ENV + TOOL_EFFICIENCY + CUSTOM + RUNTIME + ROLE_SETUP
  //   prefix 仅在内容非空时拼入,保证向后兼容(空时退化为 v0.21.x 行为)
  const prefixParts: string[] = [];
  if (roleSetupText && roleSetupText.trim().length > 0) {
    prefixParts.push('=== ROLE SETUP (Planner 定制) ===');
    prefixParts.push(roleSetupText.trim());
    prefixParts.push('=== END ROLE SETUP ===');
    prefixParts.push('');
  }
  if (systemContextText && systemContextText.trim().length > 0) {
    prefixParts.push(systemContextText.trim());
    prefixParts.push('');
  }
  const prefix = prefixParts.length > 0 ? prefixParts.join('\n') + '\n' : '';

  // v0.17.0: Recon prompt 重新设计 —— 强化 Planner 优先级 + 工具灵活性
  //
  // 原则：
  //   1. Planner 给的 sub_questions / recon_hints 是**强优先级**，不是"仅供参考"
  //      —— Planner 专门为 Recon 设计方向，Recon 应该优先查这些
  //   2. 工具使用不硬编码名字 —— 让 LLM 自己读 tool.description 决定
  //      （与 actingAgent.ts 的"不按工具名前缀过滤"哲学一致）
  //   3. 网络搜索是 agent 化的：Recon 自主决定搜什么、搜几次、是否抓全文
  //      （不限制"搜 2-3 次就停"这种硬规则）
  //   4. evidenceBrief 用来防止重复查，但不是硬约束（如果同一来源有新角度可重查）
  const system = [
    prefix + '你是 MoA 流水线的 Recon（侦察）角色 —— 一个 agent 化的证据收集器。',
    '',
    '## 核心职责',
    '',
    '你的唯一任务是**调用工具收集证据**，为下游 Refs/Aggregator 提供grounded analysis 的原料。',
    '你 NOT 负责最终回答用户问题（那是 Refs 和 Aggregator 的事）。',
    '',
    '## 工具使用（agent 化，灵活调用）',
    '',
    '你有完整的 tool registry（所有 vscode.lm 注册的 read-only 工具）。',
    '**不要硬编码工具名**——读 tool.description 决定用哪个。',
    '',
    '常见能力维度（按需调用，可多轮迭代）：',
    '- **本地文件系统**：读文件、grep 代码、列目录、查错误',
    '- **网络搜索**：通用 web search、学术搜索、新闻搜索',
    '- **专业数据库**（MCP/GCMP 提供）：PubMed、arXiv、bioRxiv、UniProt、GTEx 等',
    '- **网页抓取**：从 URL/DOI/PMID 提取内容',
    '',
    '**禁止**调用破坏性工具（writeFile/applyPatch/run_in_terminal 等）。',
    '',
    '## 网络搜索策略（重要）',
    '',
    '对于涉及以下场景的问题，**积极调用网络搜索**：',
    '- 研究性/文献性问题（"分析 X 机制"、"review Y 主题"、"什么是 Z"）',
    '- 涉及最新进展（2024+ 论文、新 API、新框架）',
    '- 用户提到的外部资源（论文、URL、API 文档）',
    '- Refs 之前指出的信息缺口（critical_gaps）',
    '',
    '搜索策略（agent 化，自主决策）：',
    '- **多角度搜索**：同一个主题用 2-3 个不同关键词角度搜，覆盖面更广',
    '- **链式深入**：搜索 → 发现相关资源 → fetch 全文/摘要 → 再搜索相关引用',
    '- **中英文结合**：中文问题也可用英文搜索（覆盖面更广），再补中文资源',
    '- **不要过早停止**：如果搜索结果指向更多相关资源，继续 fetch',
    '',
    '## 饱和即停（但不要过早停）',
    '',
    '当你**真正**觉得"再调工具也查不到新东西"时停止：',
    '- 连续 2-3 次搜索返回都是已查过的重复内容',
    '- 已收集到覆盖问题主要维度的证据',
    '- 工具签名开始重复（同样的工具+同样的输入）',
    '',
    '**不要因为"搜了一次就够了"就停** —— 研究性问题通常需要 5-10 次工具调用',
    '才能收集到足够丰富的证据让 Refs 做 grounded analysis。',
    '',
    '## 输出格式（Markdown）',
    '',
    '```',
    '## Recon 摘要 (iteration {N})',
    '',
    '<你收集到的关键证据，按相关性排序，保留具体数据/数字/引用>',
    '',
    '## 关键发现',
    '',
    '1. <发现1> (来源: <文件/URL/DOI>)',
    '   <具体内容：数字、引用、关键句子>',
    '2. <发现2> (来源: ...)',
    '   ...',
    '',
    '## 缺失（如适用）',
    '',
    '- <尝试查但没查到的>（让 Aggregator 知道这块证据缺失）',
    '```',
    '',
    '**关键**：摘要要保留**实质内容**（数字、引用、关键句子），',
    '不要只列"找到了 X 篇论文"——Refs 需要实际内容做分析。',
    '',
    '匹配任务语言（中文任务 → 中文输出，但搜索可用英文扩大覆盖面）。',
  ].join('\n');

  const reasonText: Record<ReconReason, string> = {
    initial: '这是第一轮初始收集（iteration 0）。请按 Planner 给的方向 + 自主判断全面收集。',
    missing_data: 'Aggregator 标记缺具体事实/数据，**重点查下面的 critical_gaps**（但也可顺带查相关方向）。',
    need_deeper_analysis: '信息基本够了，但需要换视角重新综合现有 evidence，挖掘新角度。',
    actor_failed: 'Actor 执行失败了，请调查下面的 Actor 日志找出根因（读 Actor 创建的文件、检查错误）。',
    contradiction: 'Refs 之间出现矛盾说法，请**重点核查冲突点**——查原始来源确认哪个正确。',
  };

  const userParts: string[] = [
    `### 任务`,
    userPrompt,
    '',
    `### 本轮 Recon 焦点（reason: ${reason}）`,
    reasonText[reason],
    '',
  ];

  // 首轮注入 Planner hint（v0.17.0: 强优先级，不是"仅供参考"）
  if (planner) {
    // v0.15.0 防御：即使 runPlanner normalize 过，再次保护（planner 可能来自 state 反序列化）
    const sqList = Array.isArray(planner.sub_questions) ? planner.sub_questions : [];
    const hintList = Array.isArray(planner.recon_hints) ? planner.recon_hints : [];
    userParts.push('### ⭐ Planner 给的查询方向（强优先级，必须覆盖）');
    userParts.push('');
    userParts.push(`**Clarified task:** ${planner.clarified_task ?? '(none)'}`);
    userParts.push('');
    if (sqList.length > 0) {
      userParts.push('**Recon 必须回答的子问题（依次查，每个都要有结论）：**');
      for (let i = 0; i < sqList.length; i++) {
        userParts.push(`${i + 1}. ${sqList[i]}`);
      }
      userParts.push('');
    }
    if (hintList.length > 0) {
      userParts.push('**搜索关键词/文件路径/URL 提示（用这些作为起点，可扩展）：**');
      for (const h of hintList) userParts.push(`- ${h}`);
      userParts.push('');
    }
    userParts.push(`**Planner 判断的难度**: ${planner.difficulty} | **needs_iteration**: ${planner.needs_iteration}`);
    userParts.push('');
    if (planner.difficulty === 'research' || planner.difficulty === 'complex') {
      userParts.push('> 🎯 Planner 标记为高难度任务 —— 建议调用 8-15 次工具，覆盖文献/数据/代码多维度。');
      userParts.push('');
    }
  }

  // 后续轮注入 Aggregator gaps（强优先级）
  if (gaps.length > 0) {
    userParts.push('### ⭐ Aggregator 标记的 critical_gaps（强优先级，必须填补）');
    for (let i = 0; i < gaps.length; i++) {
      userParts.push(`${i + 1}. ${gaps[i]}`);
    }
    userParts.push('');
    userParts.push('> 每个 gap 都要有具体证据回应，不能跳过。');
    userParts.push('');
  }

  // 注入 Actor 日志（让 Recon 调查失败根因或验证产出）
  if (actorLog) {
    userParts.push('### 上一轮 Actor 的执行日志（reason=actor_failed 时重点看）');
    userParts.push(actorLog);
    userParts.push('');
    userParts.push('请读一下 Actor 创建/修改的文件（如有），看看是否有问题。');
    userParts.push('');
  }

  // 累积 evidence 摘要（防止重复查）
  userParts.push('### 已有 evidence 摘要（避免重复查，但同一来源有新角度可重查）');
  userParts.push(evidenceBrief || '(尚无)');
  userParts.push('');

  userParts.push(`### 当前 iteration: ${iteration}`);
  userParts.push('');
  userParts.push('开始侦察。**记得：Planner 的子问题 + Aggregator 的 gaps 是强优先级，必须覆盖。**');

  return { system, user: userParts.join('\n') };
}

// ─────────────────────────────────────────────────────────────────────────
// Refs 角色类型（已有，整理在此）
// ─────────────────────────────────────────────────────────────────────────

/**
 * 单个 Ref 的输出（JSON 格式）。
 */
export interface RefOutput {
  /** Ref 自己的分析（3-5 bullets）。 */
  analysis: string;
  /** 新发现（结构化）。 */
  new_findings: Array<{
    source: string;
    snippet: string;
    confidence: 'high' | 'medium' | 'low';
  }>;
  /** Ref 自评信心度（0-1）。 */
  confidence: number;
  /** Ref 识别的 gaps。 */
  identified_gaps: string[];
}

/**
 * 构建 Ref 的 prompt。
 *
 * v0.15.0 改进：
 *   - 角色名从 worker 改为 ref（与 refModels 配置一致）
 *   - 增加"评估 Actor 产出"的引导（如果有 actor_findings）
 *   - 增加"识别 Refs 之间矛盾"的引导
 *
 * @param task           任务描述
 * @param iteration      当前 iteration
 * @param evidenceBlock  当前 evidence 池（含上轮 Recon + Actor 产出）
 * @param synthesis      上轮 Aggregator 的 synthesis（用于 critique）
 * @param gaps           上轮 Aggregator 标记的 gaps
 * @param label          本 ref 的 label（如 "advisor_1"）
 */
export function buildRefPrompt(params: {
  task: string;
  iteration: number;
  evidenceBlock: string;
  synthesis: string;
  gaps: string[];
  label: string;
}): { system: string; user: string } {
  const { task, iteration, evidenceBlock, synthesis, gaps, label } = params;

  const system = [
    `你是 MoA 流水线的 Ref（参考顾问，label: ${label}）。`,
    '',
    '你的职责：',
    '- 基于当前 evidence 给出独立的分析视角',
    '- 发现 Aggregator synthesis 中遗漏或错误的点',
    '- 评估上一轮 Actor 的产出（如果 evidence 中有 actor@* 来源）',
    '- 识别与其他 Refs 可能矛盾的观点',
    '- 指出还缺什么具体信息',
    '',
    '你 NOT 调用任何工具（纯分析角色）。',
    '',
    '严格按 JSON 格式输出（不要 markdown fence）：',
    '{',
    '  "analysis": "<3-5 bullets 的独立视角>",',
    '  "new_findings": [{"source": "...", "snippet": "...", "confidence": "high|medium|low"}],',
    '  "confidence": 「0-1, 你对当前 synthesis 的信心度」,',
    '  "identified_gaps": ["<具体缺失的信息>", ...]',
    '}',
    '',
    '匹配任务语言（中文任务 → 中文分析）。',
  ].join('\n');

  const user = [
    '### TASK',
    task,
    '',
    `### CURRENT EVIDENCE (iteration ${iteration})`,
    evidenceBlock || '(none yet)',
    '',
    '### CURRENT SYNTHESIS (for critique)',
    synthesis || '(none yet — first iteration)',
    '',
    '### REMAINING GAPS',
    gaps.length > 0 ? gaps.map((g) => `- ${g}`).join('\n') : '(none)',
  ].join('\n');

  return { system, user };
}

// ─────────────────────────────────────────────────────────────────────────
// Aggregator 角色类型
// ─────────────────────────────────────────────────────────────────────────

/**
 * v0.15.0: Aggregator 的 next_action（重构）。
 * - 去掉 `need_more_analysis`（合并进 recon_needed + recon_reason=need_deeper_analysis）
 * - 新增 `actor_needed`（信息够了，让 Actor 执行）
 */
export type AggregatorNextAction =
  | 'finalize'        // 收敛，结束 loop
  | 'actor_needed'    // 信息够了，让 Actor 执行 action_items
  | 'recon_needed';   // 信息不够，回 Recon（用 recon_reason 区分场景）

/**
 * Aggregator 输出（JSON 格式）。
 */
export interface AggregatorOutput {
  /** 融合 refs 输出的综合 synthesis。 */
  synthesis: string;
  /** Aggregator 自评 evidence 覆盖度（0-1）。 */
  evidence_coverage: number;
  /** 本轮决策。 */
  next_action: AggregatorNextAction;
  /** 仅 next_action=recon_needed 时填：指导下轮 Recon 的策略。 */
  recon_reason?: ReconReason;
  /** 仅 next_action=actor_needed 时填：要让 Actor 执行的动作列表。 */
  action_items?: Array<{
    type: 'write_file' | 'execute' | 'create_roadmap' | 'research_more' | 'inform_user';
    target: string;
    content: string;
    rationale: string;
  }>;
  /** 仅 next_action=recon_needed 时填：让 Recon 重点查的缺口。 */
  critical_gaps?: string[];
}

/**
 * 构建 Aggregator 的 prompt。
 *
 * v0.15.0 关键改进：
 *   - next_action 从 3 值改为 3 值（去掉 need_more_analysis，新增 actor_needed）
 *   - 强化"节约成本"原则：能不再 loop 就不再 loop
 *   - 加 actor_needed 的判断规则
 *
 * @param task           任务描述
 * @param iteration      当前 iteration
 * @param evidenceBlock  当前 evidence 池
 * @param refOutputs     本轮 refs 的输出
 * @param hasActorHistory 是否有上轮 Actor 的产出（影响 actor_needed 的判断）
 */
export function buildAggregatorPrompt(params: {
  task: string;
  iteration: number;
  evidenceBlock: string;
  refOutputs: Array<{ label: string; output: string }>;
  hasActorHistory: boolean;
}): { system: string; user: string } {
  const { task, iteration, evidenceBlock, refOutputs, hasActorHistory } = params;

  const system = [
    '你是 MoA 流水线的 Aggregator（聚合者 + Gate）。',
    '',
    '你的两个职责：',
    '1. 综合 N 个 Ref 的输出，产出 coherent synthesis',
    '2. **决策 next_action**（Gate 角色）——决定整个 loop 何时收敛',
    '',
    '严格按 JSON 格式输出（不要 markdown fence）：',
    '{',
    '  "synthesis": "<融合 refs 输出的综合分析>",',
    '  "evidence_coverage": 「0-1」,',
    '  "next_action": "finalize" | "actor_needed" | "recon_needed",',
    '  "recon_reason": "<仅 recon_needed 时填>: initial | missing_data | need_deeper_analysis | actor_failed | contradiction",',
    '  "action_items": [<仅 actor_needed 时填> { "type": "...", "target": "...", "content": "...", "rationale": "..." }],',
    '  "critical_gaps": [<仅 recon_needed 时填> "<具体缺口>"]',
    '}',
    '',
    '## next_action 决策规则（重要）',
    '',
    '**"finalize"**：任务已完成，无需更多动作',
    '  - 所有 refs 没有指出新缺失',
    `  - evidence_coverage >= 0.8（COMPLETENESS_THRESHOLD）`,
    '  - 上一轮 Actor（如有）已成功执行且 refs 评价正面',
    '',
    '**"actor_needed"**：信息够了，需要执行',
    '  - evidence_coverage >= 0.6（信息基本够）',
    '  - refs 分析指向具体的执行动作（write_file / execute）',
    `  - ${hasActorHistory ? '当前轮 Actor 还没执行过（即上一轮 Actor 之后还没新 Actor）' : '本任务还没执行过任何 Actor'}`,
    '',
    '**"recon_needed"**：信息不够，回 Recon',
    '  - evidence_coverage < 0.6',
    '  - OR refs 指出新的缺失',
    '  - OR 有 research_more 类的 action_item（本质就是请求 recon）',
    '  - 配合 recon_reason 指导 Recon 策略：',
    '    - missing_data: 缺具体事实/数据',
    '    - need_deeper_analysis: 信息够了但需要换视角（不一定要调工具）',
    '    - actor_failed: Actor 失败了',
    '    - contradiction: refs 之间矛盾',
    '',
    '## 节约成本原则',
    '',
    '**不要为了让流程"看起来完整"而强行多轮。**',
    '简单任务应该 1-2 轮就 finalize。复杂任务控制在 5 轮以内。',
    'Recon 调工具是有成本的（时间 + token），只有在真正缺信息时才触发。',
    '',
    '匹配任务语言。',
  ].join('\n');

  const user = [
    '### TASK',
    task,
    '',
    `### CURRENT EVIDENCE (iteration ${iteration})`,
    evidenceBlock || '(none yet)',
    '',
    `### REF OUTPUTS (iteration ${iteration})`,
    ...refOutputs.map((r) => `--- ${r.label} ---\n${r.output}`),
    '',
    `### ACTOR HISTORY: ${hasActorHistory ? '有上轮 Actor 产出（在 evidence 中以 actor@iterN 标注）' : '无'}`,
  ].join('\n');

  return { system, user };
}

// ─────────────────────────────────────────────────────────────────────────
// Actor 角色类型
// ─────────────────────────────────────────────────────────────────────────

/**
 * Actor 单个 action_item 的执行结果。
 */
export interface ActorActionResult {
  action: {
    type: 'write_file' | 'execute' | 'create_roadmap' | 'research_more' | 'inform_user';
    target: string;
    content: string;
    rationale: string;
  };
  // v0.19.0 §1.2: 新增 'partial' 状态，用于兜底分支（LLM 撞 cap 但保留了
  // capturedToolCalls 时构造的 minimal executed_action）。
  // 语义：执行未完成但有可审计的部分产出（区别于 failed=完全失败、skipped=未尝试）
  // v0.20.0: 新增 'rejected_by_user'——用户通过 Approval Gate（Gate-A 批量未选 / Gate-B 单次拒）明确拒绝。
  status: 'success' | 'failed' | 'skipped' | 'partial' | 'rejected_by_user';
  /** 实际产出字符数（文件大小 / 命令输出长度）。 */
  output_chars: number;
  /** 失败原因（status=failed 时填）。 */
  error_message?: string;
  /** 产出的文件路径或命令输出位置。 */
  artifacts: string[];
}

/**
 * Actor 完整一轮执行的结果。
 */
export interface ActorResult {
  /** 每个 action_item 的执行结果。 */
  executed_actions: ActorActionResult[];
  /** Actor 自评。 */
  self_assessment: {
    all_succeeded: boolean;
    missing_dependencies: string[];
    /** Actor 自己判断是否需要回 Recon。 */
    should_recon: boolean;
    reason: string;
  };
  /** Actor 执行的 wall-clock 耗时（秒）。 */
  elapsed_sec: number;
  /** 内部工具调用次数。 */
  tool_calls: number;
  /** 如果整个 Actor 失败（LLM 崩溃等），error 非空。 */
  error?: string;
}

/**
 * 构建 Actor 的 prompt。
 *
 * v0.15.0 关键设计：
 *   - 全工具权限（readFile/writeFile/run_in_terminal/fetch_webpage/grep/...）
 *   - 严格按 action_items 列表执行，不自作主张
 *   - 失败就如实记录，不自己修复（修复留给下轮 Recon + Refs）
 *   - research_more 类型的 action_item 直接跳过（标记 skipped，让下轮 Recon 处理）
 *
 * @param task          任务描述
 * @param actionItems   Aggregator 给出的 action_items
 * @param iteration     当前 iteration
 */
export function buildActorPrompt(params: {
  task: string;
  actionItems: NonNullable<AggregatorOutput['action_items']>;
  iteration: number;
  /**
   * v0.22.0 P0-5: 基础设施层注入文本(与 buildReconPrompt 同源)。
   * 由调用方(moaOrchestrator.ts)缓存并透传。
   */
  systemContextText?: string;
  /**
   * v0.22.0 P0-5: 角色身份层注入文本(Planner 给的 role_setup.actor 渲染)。
   */
  roleSetupText?: string;
}): { system: string; user: string } {
  const { task, actionItems, iteration, systemContextText, roleSetupText } = params;

  // v0.22.0 P0-5: 拼装 prefix(基础设施层 + 角色身份层)
  //   Actor 看: ENV + TOOL_EFFICIENCY + CUSTOM + RUNTIME + ROLE_SETUP
  //   (与 Recon 同源,但 ROLE_SETUP 内容由 Planner 分别给)
  const prefixParts: string[] = [];
  if (roleSetupText && roleSetupText.trim().length > 0) {
    prefixParts.push('=== ROLE SETUP (Planner 定制) ===');
    prefixParts.push(roleSetupText.trim());
    prefixParts.push('=== END ROLE SETUP ===');
    prefixParts.push('');
  }
  if (systemContextText && systemContextText.trim().length > 0) {
    prefixParts.push(systemContextText.trim());
    prefixParts.push('');
  }
  const prefix = prefixParts.length > 0 ? prefixParts.join('\n') + '\n' : '';

  const system = [
    prefix + '你是 MoA 流水线的 Actor（执行者）。',
    '',
    '你的职责：执行 Aggregator 给出的 action_items。',
    '',
    '## 执行规则',
    '',
    '1. **严格按 action_items 列表顺序执行**——不要自己加任务、不要跳过',
    '2. 对每个 action_item：',
    '   - write_file: 用 copilot_applyPatch 或 copilot_insertEdit 创建文件',
    '   - execute: 用 run_in_terminal 跑命令，记录 stdout/stderr',
    '   - research_more: **跳过**（标记 skipped，留给下轮 Recon 处理）',
    '   - create_roadmap: 用 copilot_insertEdit 创建 Markdown 文档',
    '   - inform_user: 仅在最终输出中记录消息',
    '3. **失败就如实记录 error_message**——不要自己尝试修复',
    '4. 工具权限：全开（readFile/writeFile/run_in_terminal/fetch_webpage/grep/...）',
    '',
    '## 输出格式（JSON，不要 markdown fence）',
    '',
    '{',
    '  "executed_actions": [',
    '    {',
    '      "action": {<原 action_item 的 type/target/content/rationale>},',
    '      "status": "success | failed | skipped | partial",',
    '      "output_chars": 「数字」,',
    '      "error_message": "<失败原因，仅 failed 时填>",',
    '      "artifacts": ["<产出的文件路径或命令输出位置>"]',
    '    }',
    '  ],',
    '  "self_assessment": {',
    '    "all_succeeded": 「bool」,',
    '    "missing_dependencies": ["<自己识别的缺失项>"],',
    '    "should_recon": 「bool,  // 例如 execute 失败提示缺 dependency 时填 true」,',
    '    "reason": "<理由>"',
    '  }',
    '}',
    '',
    '## 重要：诚实',
    '',
    '执行结果必须诚实。**不要为了"看起来完成"而撒谎**。',
    '如果 write_file 失败，就标 failed + error_message。',
    '如果 execute 报错，就如实记录 stderr。',
    '',
    '匹配任务语言。',
  ].join('\n');

  const user = [
    '### TASK',
    task,
    '',
    `### ACTION ITEMS (iteration ${iteration})`,
    '',
    ...actionItems.map((a, i) => {
      const contentPreview = a.content.length > 500
        ? a.content.substring(0, 500) + '...(truncated)'
        : a.content;
      return [
        `#### ${i + 1}. [${a.type}] ${a.target}`,
        `**Rationale:** ${a.rationale}`,
        '**Content:**',
        '```',
        contentPreview,
        '```',
        '',
      ].join('\n');
    }),
    '',
    '开始执行。',
  ].join('\n');

  return { system, user };
}

// ─────────────────────────────────────────────────────────────────────────
// Finalizer 角色（finalize 时调用）
// ─────────────────────────────────────────────────────────────────────────

/**
 * v0.15.0: 构建 finalizer prompt（把 synthesis 转成 action_items）。
 *
 * @param task       任务
 * @param synthesis  最终 synthesis
 * @param evidence   evidence 池（取末尾 20 条）
 * @param iterations 跑了几轮
 * @param completeness 最终 completeness
 */
export function buildFinalPrompt(params: {
  task: string;
  synthesis: string;
  evidence: Array<{ source: string; snippet: string; confidence: string }>;
  iterations: number;
  completeness: number;
}): { system: string; user: string } {
  const { task, synthesis, evidence, iterations, completeness } = params;

  const system = [
    'You are the MoA finalizer. Convert the accumulated synthesis into action items.',
    '',
    'Respond in JSON ONLY:',
    '{',
    '  "summary": "<1-paragraph final summary>",',
    '  "action_items": [',
    '    {',
    '      "type": "write_file" | "execute" | "create_roadmap" | "research_more" | "inform_user",',
    '      "target": "<file path / command / roadmap title / etc.>",',
    '      "content": "<specific content>",',
    '      "rationale": "<why this action>"',
    '    }',
    '  ],',
    '  "confidence": 「0-1」,',
    '  "unresolved": ["<open questions for the user>", ...]',
    '}',
    '',
    'Action item types:',
    '- write_file: concrete file to create/overwrite (target=path, content=full text)',
    '- execute: shell command to run (target=command)',
    '- create_roadmap: high-level plan document (target=title)',
    '- research_more: follow-up investigation needed (target=topic)',
    '- inform_user: just tell the user (target=subject, content=message)',
    '',
    'Match the language of the task.',
  ].join('\n');

  const evidenceStr = evidence.length === 0
    ? '(none)'
    : evidence.map((e, i) => `${i + 1}. [${e.confidence}] ${e.source}\n   ${e.snippet}`).join('\n');

  const user = [
    'TASK:',
    task,
    '',
    'FINAL SYNTHESIS:',
    synthesis,
    '',
    `EVIDENCE GATHERED (${evidence.length} items):`,
    evidenceStr,
    '',
    'ITERATIONS: ' + iterations,
    'FINAL COMPLETENESS: ' + completeness,
  ].join('\n');

  return { system, user };
}

// ─────────────────────────────────────────────────────────────────────────
// JSON 提取工具（共享）
// ─────────────────────────────────────────────────────────────────────────

/**
 * 从 LLM 输出中提取 JSON（容忍 markdown fence 和前后多余文字）。
 */
export function extractJson<T = unknown>(text: string): T {
  let t = text.trim();
  // 去掉 markdown fence
  if (t.startsWith('```')) {
    t = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  }
  // 找第一个 { 到最后一个 }
  const first = t.indexOf('{');
  const last = t.lastIndexOf('}');
  if (first === -1 || last === -1 || last <= first) {
    throw new Error('No JSON object found in LLM response');
  }
  return JSON.parse(t.substring(first, last + 1)) as T;
}
