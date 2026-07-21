# Copilot System Message Sections — 完整参考

> 调研日期:2026-07-21
> 调研目标:确认 Copilot 12 个 SystemMessageSection 的官方语义、默认内容来源、以及 MoA 扩展能否调用
> **关键结论**:Section ID 机制只对通过 `@github/copilot-sdk` 创建的 Session 有效。MoA 作为第三方 Chat Participant **完全用不上**——详见 §3。
>
> **本文档用途**(v2 增订):为 MoA v0.21.4 设计提供"自组装"决策依据——每个 section 的官方语义、功能、默认内容来源、Copilot 风味强度、**MoA 是否该自己拼一份等价物**、Planner/Recon 各自该看什么。详见 §1(增强版)、§3.3(增强版)、§6(重写)。

---

## §1. 12 个 Section ID 的官方语义 + 功能说明 + MoA 自组装建议

源码:[`copilot-sdk/nodejs/src/types.ts` L952-978](https://github.com/github/copilot-sdk/blob/main/nodejs/src/types.ts) 的 `SYSTEM_MESSAGE_SECTIONS` 常量,与 [`python/copilot/session.py` L285-307](https://github.com/github/copilot-sdk/blob/main/python/copilot/session.py) 的 `SYSTEM_MESSAGE_SECTIONS` dict 一致。

**字段说明**:

- **官方语义**:SDK 源码注释/文档对 section 的描述(直译)
- **实际功能**:这个 section 在 Copilot 系统中**实际承担什么职责**(基于 VSCode Copilot 扩展 prompt-tsx 源码推断)
- **默认内容来源**:这个 section 的文本是 cloud 渲染 / VSCode 扩展拼装 / 用户文件
- **Copilot 风味**:强 = 含"Microsoft/Copilot/VS Code Editor"等专属措辞;弱 = 中性最佳实践;无 = 纯用户内容
- **MoA 自组装建议**:MoA 不调用 SDK API,而是按 section 语义**自己拼一份等价 prompt**。✅ = 建议自组装;❌ = 不需要;🟡 = 选择性

| #  | Section ID                 | 官方语义(直译)                                                                                                                                             | 实际功能                                                                              | 默认内容来源                         | Copilot 风味                           | MoA 自组装                                |
| -- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------ | -------------------------------------- | ----------------------------------------- |
| 1  | `preamble`               | "Agent identity preamble and mode statement"                                                                                                               | **开篇身份陈述**:告诉模型"你是谁、你在什么模式下工作"(agent/edit/ask)           | Copilot backend cloud 渲染           | 🟢 弱(可替换为任意身份陈述)            | ✅**自组装**(见 §6.3)              |
| 2  | `identity` ⚙️          | "Section group covering the identity preamble and its sibling sub-sections (tone, tool efficiency, etc.)"                                                  | **分组操作符**:同时覆盖 `preamble` + `tone` + `tool_efficiency` 三个子节  | —(纯分组语义)                       | 🟡 中                                  | ✅ 分别自组装三个子节                     |
| 3  | `tone`                   | "Response style, conciseness rules, output formatting preferences"                                                                                         | **响应风格**:Markdown 格式、代码块使用、emoji、简洁度                           | VSCode 扩展 prompt-tsx(各模型族不同) | 🟡 中(有"Do NOT use emojis"等通用规则) | ✅**自组装**(Recon 专用 tone)       |
| 4  | `tool_efficiency`        | "Tool usage patterns, parallel calling, batching guidelines"                                                                                               | **工具调用纪律**:并行调用、批处理、何时不用工具、ReadFile 策略                  | VSCode 扩展 prompt-tsx               | 🟢 弱(中性最佳实践)                    | 🟡 可借鉴,MoA Recon 已有类似章节          |
| 5  | `environment_context`    | "CWD, OS, git root, directory listing, available tools"                                                                                                    | **运行时事实**:工作目录、操作系统、git 仓库根、目录树、**可用工具列表**   | Copilot backend + VSCode 扩展混合    | 🟢 弱(纯事实)                          | ✅**自组装**(部分已实现)            |
| 6  | `code_change_rules`      | "Coding rules, linting/testing, ecosystem tools, style"                                                                                                    | **代码修改纪律**:EditFile 用法、ApplyPatch 格式、group by file、测试要求        | VSCode 扩展 prompt-tsx               | 🔴 强(强 Coding Agent 风味)            | ❌ MoA Recon 是 read-only,不需要          |
| 7  | `guidelines`             | "Tips, behavioral best practices, behavioral guidelines"                                                                                                   | **行为准则**:默认执行而非建议、阻塞时换路径、不给时间预估                       | VSCode 扩展 prompt-tsx(各模型族不同) | 🟡 中                                  | 🟡 选择性(见 §6.3)                       |
| 8  | `safety`                 | "Environment limitations, prohibited actions, security policies"                                                                                           | **安全策略**:Microsoft content policies、版权保护、拒绝有害内容、不泄露 secrets | VSCode 扩展`base/safetyRules.tsx`  | 🔴 强(微软条款)                        | 🟡 改造后自组装(研究场景版)               |
| 9  | `tool_instructions` ⚙️ | "Per-tool usage instructions"                                                                                                                              | **每个工具的用法说明**:从 `vscode.lm.tools[].description` 拼装                | Copilot backend 从工具注册表读       | 🟢 弱(工具文档)                        | ❌ Recon 已能读 tool.description,无需重复 |
| 10 | `custom_instructions`    | "Repository and organization custom instructions"                                                                                                          | **用户的指令文件**:CLAUDE.md / AGENTS.md / copilot-instructions.md 全文         | VSCode 扩展发现 + 读取本地文件       | ⚪ 无(纯用户内容)                      | ✅**必须自组装**                    |
| 11 | `runtime_instructions`   | "Runtime-provided context and instructions (e.g. system notifications, memories, workspace context, mode-specific instructions, content-exclusion policy)" | **运行时上下文**:skill 清单、memories、mode-specific 指令、workspace 上下文     | VSCode 扩展运行时拼装                | ⚪ 无(纯用户内容)                      | ✅**必须自组装**(skill 清单部分)    |
| 12 | `last_instructions`      | "End-of-prompt instructions: parallel tool calling, persistence, task completion"                                                                          | **prompt 尾部**:并行工具调用、持久化、任务完成                                  | Copilot backend cloud 渲染           | 🟢 弱                                  | ❌ MoA Recon 自己控制迭代终止             |

⚙️ = section **group**(会扩散到子节点的集合),用 `preamble` 单独打前言,用 `identity` 打整个身份组。

---

## §2. ⚠️ 关键澄清:Section 内容不在客户端,在 Server 端

### 2.1 SDK 只定义 Section ID,**不存默认内容**

通读 [copilot-sdk 全部源码](https://github.com/github/copilot-sdk),SDK 只提供:

- Section ID 常量(`preamble` / `identity` / `tone` / ... 12 个字符串)
- `SectionOverrideAction` 枚举(`replace` / `remove` / `append` / `prepend` / `preserve` + transform 回调)
- `SystemMessageConfig` 三种 mode:`append` / `replace` / `customize`

**SDK 本身不包含任何默认 prompt 文本**。Section 的实际内容是 **Copilot 后端在 cloud 渲染**的,客户端通过 `createSession({systemMessage})` 告诉后端"我对哪些 section 做什么 override",后端按 override 后的内容组装 system message 发给 LLM。

证据:[`copilot-sdk/nodejs/src/client.ts` L1342-1370](https://github.com/github/copilot-sdk/blob/main/nodejs/src/client.ts) 的 `getSystemMessageConfigForMode` 只做"补充 environment_context: remove"这种客户端侧的预处理,然后把 config 通过 RPC 传给 Copilot CLI/SDK runtime。

### 2.2 `transform` 回调能拿到内容(运行时)

SDK 的 `SectionOverride.action` 可以传一个回调:

```ts
sections: {
  identity: {
    action: (currentContent: string) => {
      console.log("identity section 实际内容:", currentContent);
      return currentContent;  // 原样返回
    }
  }
}
```

Copilot 后端渲染完 section 后,通过 `systemMessage.transform` RPC 把内容回调给客户端,客户端修改后返回。这是**唯一能看到默认内容的方式**——但它是运行时的,内容随 Copilot 服务端升级而变。

### 2.3 VSCode Copilot 扩展的 prompt-tsx 文件(部分内容可见)

VSCode Copilot 扩展([`microsoft/vscode/extensions/copilot/`](https://github.com/microsoft/vscode/tree/main/extensions/copilot))用 prompt-tsx 框架在客户端构建 prompt。这些 prompt **不是 section 内容本身**,而是 VSCode 扩展层自己的 prompt assembly(对应 `VSCode Agent` 等默认 agent)。

源码路径与内容对照:

| Section                  | VSCode Copilot 扩展源码文件                                                                                                                                                                                   | 内容片段(节选)                                                                                                                                                       |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `preamble`             | [`base/safetyRules.tsx` L7-L31](https://github.com/microsoft/vscode/blob/main/extensions/copilot/src/extension/prompts/node/base/safetyRules.tsx) + `CopilotIdentityRules`                                 | "You are an expert AI programming assistant, working with a user in the VS Code editor"                                                                              |
| `tone`                 | [`agent/anthropicPrompts.tsx` L269-L282](https://github.com/microsoft/vscode/blob/main/extensions/copilot/src/extension/prompts/node/agent/anthropicPrompts.tsx) Claude 4.6                                  | "Use proper Markdown formatting - Wrap symbol names in backticks - Do NOT use emojis unless explicitly requested"                                                    |
| `tool_efficiency`      | [`agent/defaultAgentInstructions.tsx` L131-L148](https://github.com/microsoft/vscode/blob/main/extensions/copilot/src/extension/prompts/node/agent/defaultAgentInstructions.tsx)                             | "When using ReadFile, prefer reading a large section over calling many times in sequence - Read in parallel"                                                         |
| `environment_context`  | 服务端渲染 + 客户端`environmentContext` prompt-tsx 组件                                                                                                                                                     | CWD / OS / git root / 可用工具列表                                                                                                                                   |
| `code_change_rules`    | [`agent/defaultAgentInstructions.tsx` L160-L205](https://github.com/microsoft/vscode/blob/main/extensions/copilot/src/extension/prompts/node/agent/defaultAgentInstructions.tsx)                             | "Before you edit an existing file, make sure you have it in context - Use the EditFile tool - group changes by file - NEVER show the changes, just call the tool"    |
| `guidelines`           | [`agent/anthropicPrompts.tsx` L326-L335](https://github.com/microsoft/vscode/blob/main/extensions/copilot/src/extension/prompts/node/agent/anthropicPrompts.tsx) Claude 4.6                                  | "By default, implement changes rather than only suggesting them - If your approach is blocked, consider alternatives - Avoid giving time estimates"                  |
| `safety`               | [`base/safetyRules.tsx` L7-L44](https://github.com/microsoft/vscode/blob/main/extensions/copilot/src/extension/prompts/node/base/safetyRules.tsx)                                                            | "Follow Microsoft content policies - Avoid content that violates copyrights - If asked to generate harmful content, respond with 'Sorry, I can't assist with that.'" |
| `tool_instructions`    | MCP 工具说明 + 内置工具说明                                                                                                                                                                                   | 每个 tool 的 description 字段                                                                                                                                        |
| `custom_instructions`  | [`platform/promptFiles/node/automaticInstructionsCollector.ts`](https://github.com/microsoft/vscode/blob/main/extensions/copilot/src/platform/promptFiles/node/automaticInstructionsCollector.ts) 发现的文件 | CLAUDE.md / AGENTS.md / copilot-instructions.md 的全文                                                                                                               |
| `runtime_instructions` | 运行时上下文                                                                                                                                                                                                  | memories / skill 清单 / workspace context / mode-specific instructions                                                                                               |
| `last_instructions`    | 服务端渲染                                                                                                                                                                                                    | 并行工具调用 / 持久化 / 任务完成提示                                                                                                                                 |

**注意**:不同模型族(OpenAI / Anthropic / Gemini / Z.AI / xAI)的 prompt-tsx 实现不同。例如 GLM 有专门的 [`agent/zaiPrompts.tsx`](https://github.com/microsoft/vscode/blob/main/extensions/copilot/src/extension/prompts/node/agent/zaiPrompts.tsx),强调"MUST / STRICTLY / REQUIRED"等强约束措辞(适应 GLM 的注意力机制)。

---

## §3. ⚠️ MoA 扩展能不能调用 Section 机制?

**答案:不能**。这是架构限制,不是 API 缺失。

### 3.1 MoA 与 Copilot SDK 的架构差异

```
┌─────────────────────────────────────────────────────────┐
│ Copilot SDK 用户(能用 Section)                       │
│ ─────────────────────────────────────────────────────── │
│ 1. 应用代码: client.createSession({systemMessage})    │
│ 2. Copilot SDK runtime: 通过 RPC 调 Copilot CLI       │
│ 3. Copilot CLI: 连接 Copilot backend(cloud)         │
│ 4. Copilot backend: 渲染 12 个 section → system msg   │
│ 5. backend 发给 LLM(Anthropic/OpenAI 等)            │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│ MoA 扩展(用不上 Section)                             │
│ ─────────────────────────────────────────────────────── │
│ 1. MoA 注册为 vscode.ChatRequestHandler                │
│ 2. Recon 通过 vscode.lm.selectChatModels() 拿模型     │
│ 3. Recon 直接调 model.sendRequest(messages, {tools})  │
│    ↑ 完全跳过 Copilot session 体系                     │
│ 4. LLM provider(GCMP/DeepSeek/GLM 等)直接处理       │
└─────────────────────────────────────────────────────────┘
```

**根本原因**:MoA 用的是 VSCode Language Model API(`vscode.lm`),这个 API 只提供**裸模型调用**——`model.sendRequest(messages)` 发什么 LLM 就看什么。它**没有 system message 概念**,只有 `vscode.LanguageModelChatMessage.User()` 和 `.Assistant()` 两种消息类型,system 提示必须自己拼到第一条 User message 里。

对比 Copilot SDK:它是一个**完整的 agent runtime**,封装了 Copilot backend 的整个 session 生命周期,所以才能"override section"。

### 3.2 MoA 想注入系统上下文的正确做法

MoA 没有 Section 机制,只能**自己读文件 + 自己拼 prompt**:

| 想注入的 Copilot 等价物                        | MoA 实现方式                                                                                                                       |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `custom_instructions`(CLAUDE.md / AGENTS.md) | 读工作区与 home 目录的这些文件,把内容塞进 Recon 的 system prompt                                                                   |
| `runtime_instructions`(skill 清单)           | 扫`~/.copilot/skills/` 和工作区 `.claude/skills/` 目录,把 skill name + description 列表塞进 Recon system prompt                |
| `environment_context`(CWD/OS/git/可用工具)   | 已有`workspaceContext.ts` 实现一部分(active file/open docs/project tree),扩展加上 `toolInventory`(对 `vscode.lm.tools` 分类) |
| `tone` / `safety` / `code_change_rules`  | 不注入(MoA 是研究/分析场景,Copilot 风味 prompt 对 Recon 反而是噪声)                                                                |

### 3.3 Section ID 在 MoA 语境下的"自组装"决策矩阵

MoA 用不上 Section API,但按 §1 的"MoA 自组装"列,可以自己拼一份等价 prompt。下表进一步细化 **Planner vs Recon 各自该看什么**——基于职责分层:

- **Planner**(单次调用,语义层):需要**摘要级**信息判断任务难度、决定子问题方向
- **Recon**(agent 化 loop,执行层):需要**全文级**信息真正调用工具、按规则操作

| Section ID                  | Planner 该看?                                      | Recon 该看?                                                           | MoA 自组装策略                                                                                                                                      |
| --------------------------- | -------------------------------------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `preamble`                | ✅ 摘要                                            | ✅ 全文                                                               | **自组装 Recon 专用身份**:"你是 MoA Recon,read-only 侦察员,职责是收集证据"——见 [roles.ts buildReconPrompt L82](../src/moaCore/roles.ts) 已有 |
| `identity` ⚙️           | —                                                 | —                                                                    | 分别处理三个子节(下面三行)                                                                                                                          |
| `tone`                    | ❌ Planner 是 JSON 输出,不需要 tone                | ✅ 全文                                                               | **自组装 Recon tone**:已有"匹配任务语言(中文任务 → 中文输出)"等(roles.ts L120)                                                               |
| `tool_efficiency`         | ❌                                                 | 🟡 部分                                                               | **已有等价物**:Recon system prompt 已有"工具使用(agent 化,灵活调用)"章节(roles.ts L70-105)                                                    |
| `environment_context`     | ✅**摘要**(active file 路径 + workspace 根)  | ✅ 全文(active file 内容 + open docs + project tree + tool inventory) | **部分已实现**:`workspaceContext.ts`;需扩展 `toolInventory`(对 `vscode.lm.tools` 分类)                                                  |
| `code_change_rules`       | ❌                                                 | ❌                                                                    | Recon read-only,不需要                                                                                                                              |
| `guidelines`              | 🟡 仅"任务难度判断"相关条目                        | 🟡 选择性                                                             | **改造后自组装**:从 Copilot guidelines 借鉴"如被阻塞换路径""不给时间预估"等通用条目,丢弃 Coding Agent 专属条目                                |
| `safety`                  | ❌                                                 | 🟡 改造后                                                             | **自组装研究场景版 safety**:"避免版权侵犯(直接复制大段论文)""拒绝生成有害内容""不绕过安全控制"——去掉"Microsoft content policies"微软味      |
| `tool_instructions`       | ❌                                                 | ❌                                                                    | Recon 已能读`vscode.lm.tools[].description`,无需重复                                                                                              |
| `custom_instructions` ⭐  | ✅**摘要**(CLAUDE.md frontmatter + 一级标题) | ✅**全文**(CLAUDE.md / AGENTS.md / copilot-instructions.md)     | **必须自组装**:扫 §4.1 的 7 个路径                                                                                                           |
| `runtime_instructions` ⭐ | ✅**摘要**(skill name + description)         | ✅**摘要 + 按需展开**(skill 清单 + memories 索引)               | **必须自组装**:扫 §4.2 的 4 个 skill 目录;memories 部分暂不实现(用户级私密)                                                                  |
| `last_instructions`       | ❌                                                 | ❌                                                                    | MoA Recon 自己控制迭代终止(`maxReconIterations`)                                                                                                  |

### 3.4 Planner / Recon / Refs / Aggregator / Actor 五角色 × Section 注入矩阵

把 §3.3 扩展到 5 个角色,形成完整注入矩阵。这是 v0.21.4 设计的核心决策依据:

| Section 自组装                          | Planner                              | Recon                                | Refs                                      | Aggregator           | Actor                                        |
| --------------------------------------- | ------------------------------------ | ------------------------------------ | ----------------------------------------- | -------------------- | -------------------------------------------- |
| `preamble`(角色身份)                  | ✅ "你是 Planner"                    | ✅ "你是 Recon"                      | ✅ "你是 Ref"                             | ✅ "你是 Aggregator" | ✅ "你是 Actor"                              |
| `tone`                                | ❌(JSON 输出)                        | ✅(语言匹配 + Markdown 格式)         | ❌(JSON 输出)                             | ❌(JSON 输出)        | ✅(执行风格)                                 |
| `tool_efficiency`                     | ❌(不调工具)                         | ✅(工具调用纪律)                     | ❌(不调工具)                              | ❌(不调工具)         | ✅(工具调用纪律)                             |
| `environment_context`(workspace)      | 🟡 摘要                              | ✅ 全文                              | ❌(v0.12.5 设计:Refs 只看 Recon evidence) | ❌                   | ❌                                           |
| `environment_context`(tool inventory) | ✅ 摘要(知道有哪些能力可用)          | ✅ 全文                              | ❌                                        | ❌                   | ✅(Actor 也要调工具)                         |
| `custom_instructions`(CLAUDE.md)      | 🟡**仅一级标题摘要**           | ✅**全文**                     | ❌                                        | ❌                   | ✅**全文**(Actor 执行文件操作必须遵守) |
| `runtime_instructions`(skill 清单)    | ✅**摘要**(name + description) | ✅**摘要**(name + description) | ❌                                        | ❌                   | 🟡(Actor 一般不调 skill)                     |
| `guidelines`(改造版)                  | ❌                                   | ✅                                   | ❌                                        | ❌                   | ✅                                           |
| `safety`(研究版)                      | ❌                                   | ✅                                   | ❌                                        | ❌                   | ✅                                           |
| `code_change_rules`                   | ❌                                   | ❌(read-only)                        | ❌                                        | ❌                   | ✅(Actor 专门用)                             |

**设计原则**:

- **Planner 看"摘要级"环境 + skill 清单**:让 Planner 知道"有哪些能力可用",但不看全文——避免 Planner 过度介入战术层(见上一轮讨论的方案 C)
- **Recon 看"全文级"一切**:Recon 是 agent 化执行者,需要 CLAUDE.md 全文约束行为(如本机 CLAUDE.md 含 PowerShell 约束、R vs WSL2 决策表)
- **Refs 纯推理层**(v0.12.5 设计不变):Refs 只看 Recon 的 evidence + 任务,不看 workspace/skill/CLAUDE.md
- **Aggregator 是 Gate**:只看 evidence + refs 输出,不看环境
- **Actor 看 CLAUDE.md 全文**:Actor 执行文件操作/终端命令,必须遵守 CLAUDE.md 的 IRON RULE(批量文件安全协议、PowerShell 约束等)

---

## §4. VSCode Copilot 的 Instruction 文件发现规则(源码事实)

源码:[`extensions/copilot/src/platform/promptFiles/vscode-node/agentInstructionsLocator.ts`](https://github.com/microsoft/vscode/blob/main/extensions/copilot/src/platform/promptFiles/vscode-node/agentInstructionsLocator.ts) L98-L103 + [`promptTypes.ts`](https://github.com/microsoft/vscode/blob/main/extensions/copilot/src/platform/customInstructions/common/promptTypes.ts)

### 4.1 Instruction 文件路径(workspace + user home)

```
Workspace(当前工作区):
  ./CLAUDE.md                              # Claude Code 风格
  ./CLAUDE.local.md                        # Claude 本地覆盖
  ./AGENTS.md                              # agents.md 标准
  ./.claude/CLAUDE.md                      # Claude 子目录
  ./.github/copilot-instructions.md        # Copilot 官方位置

User home(用户级,所有工作区共享):
  ~/.claude/CLAUDE.md
  ~/.copilot/copilot-instructions.md
```

### 4.2 Skill 文件夹

源码:[`promptTypes.ts` L18-L24](https://github.com/microsoft/vscode/blob/main/extensions/copilot/src/platform/customInstructions/common/promptTypes.ts)

```ts
export const WORKSPACE_SKILL_FOLDERS = ['.github/skills', '.claude/skills'];
export const PERSONAL_SKILL_FOLDERS = ['.copilot/skills', '.claude/skills'];
```

即:

- 工作区:`.github/skills/` 和 `.claude/skills/`
- 用户级:`~/.copilot/skills/` 和 `~/.claude/skills/`

### 4.3 相关配置开关

源码:[`src/vs/workbench/contrib/chat/common/promptSyntax/config/config.ts`](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/chat/common/promptSyntax/config/config.ts) L80-L114

| 配置键                                                     | 默认                                                                            | 说明                             |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------- | -------------------------------- |
| `chat.useClaudeMdFile`                                   | `true`                                                                        | 是否加载 CLAUDE.md               |
| `chat.useAgentsMdFile`                                   | `true`                                                                        | 是否加载 AGENTS.md               |
| `chat.useNestedAgentsMdFiles`                            | `false`                                                                       | 是否递归加载嵌套 AGENTS.md       |
| `chat.useAgentSkills`                                    | `true`                                                                        | 是否加载 Skill                   |
| `github.copilot.chat.codeGeneration.useInstructionFiles` | `true`                                                                        | 是否加载 copilot-instructions.md |
| `chat.agentSkillsLocations`                              | `{'.github/skills': true, '.claude/skills': true, '~/.copilot/skills': true}` | Skill 文件夹位置                 |

### 4.4 Custom Agent(`.agent.md`)与 Skill(`SKILL.md`)的区别

- `.agent.md`:Claude 风格 subagent 定义,有 `name` / `description` / `tools` / `model` / `systemPrompt` 字段 → 整个 agent 委托
- `SKILL.md`:Copilot Skill,有 `name` / `description` frontmatter + 正文指令 → 按需加载的领域知识包
- `.instructions.md`:applyTo 模式匹配的指令文件 → 文件类型相关规则

源码:[`promptFileAttributes.ts` L331-L354](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/chat/common/promptSyntax/languageProviders/promptFileAttributes.ts) 的 `claudeAgentAttributes` 字段定义。

---

## §5. Copilot SDK 的三种 System Message Mode

源码:[`copilot-sdk/nodejs/src/types.ts` L1048-L1082](https://github.com/github/copilot-sdk/blob/main/nodejs/src/types.ts)

### 5.1 `append`(默认)

```ts
{
  mode?: "append",
  content?: string,   // 附加在 SDK-managed sections 之后
}
```

保留所有 SDK 默认 sections,**只追加**。SDK 文档原文:"The default CLI persona is preserved, and your `content` is appended after SDK-managed sections."

### 5.2 `replace`(慎用)

```ts
{
  mode: "replace",
  content: string,    // 完全替换 SDK 默认 system message
}
```

**⚠️ 危险**:替换掉所有 SDK guardrails(含安全策略)。SDK 文档:"Removes all SDK guardrails including security restrictions. Use with caution."

### 5.3 `customize`(精细控制)

```ts
{
  mode: "customize",
  sections?: {
    [sectionId: string]: {
      action: "replace" | "remove" | "append" | "prepend" | "preserve"
            | ((currentContent: string) => string | Promise<string>);  // transform
      content?: string,
    }
  },
  content?: string,  // 追加在所有 sections 之后
}
```

**preserve** 的特殊用途:当用 `identity` 组级 `remove` 时,可以用 `tone: {action: "preserve"}` 把 tone 子节单独保留。

**Unknown section ID** 的容错:`replace/append/prepend` 的内容会被附加到 additional instructions;`remove` 被静默忽略。

### 5.4 Empty mode 的特殊行为

[`copilot-sdk/nodejs/src/client.ts` L1342-1370](https://github.com/github/copilot-sdk/blob/main/nodejs/src/client.ts):当 SDK `mode = "empty"`(没有工作区的临时 chat),会自动把 `environment_context` section 设为 `remove`——因为 workspace 都没有,环境信息无意义。

---

## §6. 对 MoA v0.21.4 设计的指导意义

### 6.1 不要试图"调用 Section API"

经过 §3 论证,MoA 作为 Chat Participant,无法通过 Copilot SDK 的 `systemMessage.sections` 机制注入。**正确的做法是 MoA 自己读文件 + 自己拼 prompt**。

### 6.2 按 Section 语义设计 MoA 的 systemContext

基于 §3.4 的注入矩阵,v0.21.4 的 `systemContext.ts` 应包含:

```ts
interface SystemContext {
  // ← 对应 custom_instructions section
  instructionFiles: Array<{
    type: 'claude.md' | 'agents.md' | 'copilot-instructions.md' | 'claude.local.md';
    path: string;
    sizeKb: number;
    content: string;     // 全文,Recon 按需引用
    summary: string;     // 一级标题 + frontmatter,给 Planner
  }>;
  
  // ← 对应 runtime_instructions section 的 skill 部分
  skills: Array<{
    name: string;
    description: string;  // frontmatter description 截断 200 字
    path: string;
    source: 'workspace' | 'user';
  }>;
  
  // ← 对应 environment_context section 的可用工具部分
  toolInventory: {
    total: number;
    categories: Array<{name: string; count: number; examples: string[]}>;
  };
  
  // ← 对应 environment_context section 的 CWD/工作区部分(已有)
  activeFile?: {path, languageId, visibleRange, selection};
  openDocuments: Array<{relativePath, languageId, isActive}>;
  workspaceFolders: string[];
  projectTree?: string;
}
```

### 6.3 Planner / Recon / Actor 的 preamble + tone + guidelines 自组装建议

按 §3.4 矩阵,MoA 各角色的 system prompt 应该这样自组装(对应 Copilot 的 preamble/tone/guidelines section):

#### Planner(任务语义层)

```text
# Preamble(身份)
你是 MoA 流水线的 Planner(规划者)。

# Tone(风格)
不适用——你输出 JSON,不需要 Markdown 格式规则。

# Guidelines(行为准则)
- 严格按 JSON 格式输出,不要 markdown fence,不要前后多余文字
- sub_questions 必须是 Recon 能用工具回答的具体问题
- recon_hints 要给出具体的搜索词、文件路径、URL
- 判断准则:simple / moderate / complex / research
- 匹配任务语言(中文任务 → 中文输出)

# Environment Context(摘要级)
[workspaceFolders + activeFile.path + skill 清单 name+description]

# Task
用户原始任务:[userPrompt]
```

注:Planner **不看 CLAUDE.md 全文**(避免过度介入战术层),只看 skill name+description 清单(知道有哪些领域能力存在)。Planner 的 `recon_hints` 应该写"需要学术搜索能力",而不是"必须调 mcp_unified-acade_smart_search"——具体工具选择交给 Recon。

#### Recon(执行层,read-only 侦察员)

```text
# Preamble(身份)
你是 MoA 流水线的 Recon(侦察)角色 —— 一个 agent 化的证据收集器。
你的唯一任务是调用工具收集证据,为下游 Refs/Aggregator 提供 grounded analysis 的原料。
你 NOT 负责最终回答用户问题(那是 Refs 和 Aggregator 的事)。

# Tone(风格)
- 匹配任务语言(中文任务 → 中文输出,但搜索可用英文扩大覆盖面)
- 摘要保留实质内容(数字、引用、关键句子),不要只列"找到了 X 篇论文"

# Tool Efficiency(工具调用纪律)
- 不硬编码工具名——读 tool.description 决定用哪个
- 网络搜索 agent 化:多角度搜、链式深入、中英文结合
- 饱和即停(但不要过早停):连续 2-3 次重复才停;研究性问题通常需要 5-10 次工具调用

# Safety(研究场景版)
- 不直接复制大段受版权保护的论文全文(可引用关键句子)
- 拒绝生成有害/欺骗性内容
- 不绕过网站反爬机制(如 Cloudflare)
- 涉及人类受试者数据时遵循 IRB 规则

# Guidelines(通用行为准则,从 Copilot 改造)
- 不要因为"搜了一次就够了"就停——研究性问题需要多次搜索
- 如被阻塞(工具报错/网站挡),换路径而不是 brute force
- 避免给"时间预估"

# Custom Instructions(全文) ⭐
[CLAUDE.md / AGENTS.md / copilot-instructions.md 全文]
注:本机 CLAUDE.md 含 4 章 IRON RULE(PowerShell 约束、R vs WSL2、批量文件安全等),
Recon 必须遵守——调 run_in_terminal 时用 pwsh 不用 powershell、读文件路径含中文要用 \u4e00-\u9fa5 正则等。

# Runtime Instructions(skill 清单) ⭐
[60+ 个 skill 的 name + description 清单]
注:Recon 看到这份清单后,知道有 bgee-skill / civic-skill / deep-research 可调,
但具体调哪个由 Recon 自己判断(不是 Planner 强制)。

# Environment Context(全文)
[activeFile + openDocuments + projectTree + toolInventory 分类摘要]

# Task
[planner.sub_questions + planner.recon_hints + Aggregator.gaps + actorLog + evidenceBrief]
```

#### Actor(执行层,read-write 执行者)

```text
# Preamble(身份)
你是 MoA 流水线的 Actor(执行者)。
你的职责:执行 Aggregator 给出的 action_items。

# Tone(风格)
- 严格按 action_items 列表顺序执行,不自作主张
- 失败如实记录,不自己修复(修复留给下轮 Recon + Refs)

# Code Change Rules(Actor 专用,改造自 Copilot)
- write_file: 用 copilot_applyPatch 或 copilot_insertEdit
- execute: 用 run_in_terminal(遵守 CLAUDE.md PowerShell 约束)
- research_more: 跳过(标记 skipped,留给下轮 Recon)

# Safety(执行场景版)
- **必须遵守 CLAUDE.md IRON RULE**(批量文件安全协议、PowerShell 约束)
- 不执行破坏性操作(rm -rf / git push --force)未经用户确认
- OWASP Top 10 安全检查

# Custom Instructions(全文) ⭐
[CLAUDE.md / AGENTS.md 全文] —— Actor 执行文件操作必须遵守

# Action Items
[Aggregator.action_items 列表]
```

### 6.4 当前 MoA 已实现的 Section 等价物清单(v0.21.3 现状)

源码事实(非推断),为 v0.21.4 改造提供基线:

| Section 语义                           | MoA 当前实现位置                                                                                                                                                                                                                                                                                                                                                                                                                           | 实现程度               | v0.21.4 改造                               |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------- | ------------------------------------------ |
| `preamble`(身份)                     | [roles.ts buildPlannerPrompt L48](../src/moaCore/roles.ts) "你是 MoA 流水线的 Planner"  [roles.ts buildReconPrompt L82](../src/moaCore/roles.ts) "你是 MoA 流水线的 Recon"  [roles.ts buildRefPrompt L320](../src/moaCore/roles.ts) "你是 MoA 流水线的 Ref"  [roles.ts buildAggregatorPrompt L420](../src/moaCore/roles.ts) "你是 MoA 流水线的 Aggregator"  [roles.ts buildActorPrompt L520](../src/moaCore/roles.ts) "你是 MoA 流水线的 Actor" | ✅ 5 角色都有          | 保持                                       |
| `tone`                               | Recon:"匹配任务语言"(roles.ts L120)其他角色无显式 tone                                                                                                                                                                                                                                                                                                                                                                                     | 🟡 Recon 有,其他无     | 按 §6.3 补齐                              |
| `tool_efficiency`                    | [roles.ts L70-105](../src/moaCore/roles.ts) Recon 的"工具使用"章节:"不硬编码工具名"、"agent 化,灵活调用"、"饱和即停"                                                                                                                                                                                                                                                                                                                        | ✅ Recon 完整          | 保持                                       |
| `environment_context` workspace 部分 | [workspaceContext.ts buildWorkspaceContext](../src/workspaceContext.ts):active file + open docs + workspace folders + project tree                                                                                                                                                                                                                                                                                                          | ✅ 已实现              | **加 toolInventory 字段**            |
| `environment_context` tool inventory | ❌ 无                                                                                                                                                                                                                                                                                                                                                                                                                                      | ❌ 未实现              | **新增**:对 `vscode.lm.tools` 分类 |
| `environment_context` 注入到 prompt  | ❌[moaRunner.ts L320-325](../src/moaRunner.ts) 有 `wsContext` 变量但**从未传给 runReconAgent**(死代码)                                                                                                                                                                                                                                                                                                                              | 🔴**死代码 bug** | **修复**:真传下去                    |
| `code_change_rules`                  | [roles.ts buildActorPrompt](../src/moaCore/roles.ts) Actor 章节有 write_file/execute 规则                                                                                                                                                                                                                                                                                                                                                   | ✅ Actor 有            | 保持                                       |
| `guidelines`                         | Recon prompt 零散有"研究性问题需要 5-10 次工具调用"等(roles.ts L100-105)                                                                                                                                                                                                                                                                                                                                                                   | 🟡 Recon 零散          | 按 §6.3 系统化                            |
| `safety`                             | ❌ 无显式 safety 章节                                                                                                                                                                                                                                                                                                                                                                                                                      | ❌ 未实现              | **新增研究场景版 safety**            |
| `tool_instructions`                  | [actingAgent.ts getActingTools L192](../src/actingAgent.ts) 把 `vscode.lm.tools` 拼进每次 sendRequest                                                                                                                                                                                                                                                                                                                                     | ✅ 自动                | 保持                                       |
| `custom_instructions`(CLAUDE.md)     | ❌**完全未实现**                                                                                                                                                                                                                                                                                                                                                                                                                     | 🔴**关键缺失**   | **新增**:扫 §4.1 的 7 个路径        |
| `runtime_instructions`(skill 清单)   | ❌**完全未实现**                                                                                                                                                                                                                                                                                                                                                                                                                     | 🔴**关键缺失**   | **新增**:扫 §4.2 的 4 个目录        |
| `last_instructions`                  | ❌ 无                                                                                                                                                                                                                                                                                                                                                                                                                                      | ❌ 未实现              | 不需要(Recon 自己控制迭代)                 |

**关键缺口 3 个**(🔴):

1. `custom_instructions` 完全未实现——Recon 看不到 CLAUDE.md/AGENTS.md
2. `runtime_instructions` 的 skill 清单未实现——Recon 看不到 skill 列表
3. `environment_context` 的 wsContext 是死代码——即使构建了也没传给 Recon

v0.21.4 的核心工作量就是补齐这 3 个缺口 + 扩展 toolInventory + 新增 safety 章节。

### 6.5 v0.21.4 改造的边界(避免过度工程)

基于 §3.4 矩阵和 §6.4 现状,v0.21.4 **只改 4 个文件,新增 1 个文件**:

| 文件                                                 | 改动类型                                                                                                                 | 工作量  |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------- |
| 新建`src/systemContext.ts`                         | 新增`buildSystemContext()` + `renderForPlanner()` + `renderForRecon()`                                             | ~150 行 |
| [src/moaCore/roles.ts](../src/moaCore/roles.ts)       | `buildPlannerPrompt` 加 `systemContextSummary` 参数;`buildReconPrompt` 加 `systemContextFull` 参数 + safety 章节 | ~30 行  |
| [src/moaCore/runRecon.ts](../src/moaCore/runRecon.ts) | `callRecon` 接收 systemContext,传给 `buildReconPrompt`                                                               | ~10 行  |
| [src/moaOrchestrator.ts](../src/moaOrchestrator.ts)   | iter 1 调一次`buildSystemContext()` 缓存到 state,后续轮复用                                                            | ~15 行  |
| [src/moaRunner.ts](../src/moaRunner.ts)               | 删 L320-325 死代码注释,真传 systemContext                                                                                | -5 行   |

**不改的部分**(避免 scope creep):

- ❌ 不改 Planner 的 JSON schema(保持 sub_questions/recon_hints 结构)
- ❌ 不改 Refs/Aggregator 的 prompt(v0.12.5 设计:Refs 纯推理层)
- ❌ 不实现 memories 索引(用户级私密,暂不触碰)
- ❌ 不实现 `chat.useClaudeMdFile` 等配置开关的读取(默认全扫,用户有需要再加)

---

## §7. 参考链接

### copilot-sdk

- 主仓库:https://github.com/github/copilot-sdk
- Node.js 类型定义:[`nodejs/src/types.ts`](https://github.com/github/copilot-sdk/blob/main/nodejs/src/types.ts)(含 `SYSTEM_MESSAGE_SECTIONS` 常量)
- Node.js README "System Message Customization" 章节:https://github.com/github/copilot-sdk/blob/main/nodejs/README.md#advanced-usage
- Getting Started "Customize the system message" 章节:https://github.com/github/copilot-sdk/blob/main/docs/getting-started.md
- CHANGELOG(Section 机制首次发布):https://github.com/github/copilot-sdk/blob/main/CHANGELOG.md

### VSCode Copilot 扩展

- 主仓库:https://github.com/microsoft/vscode/tree/main/extensions/copilot
- Agent 模式 prompt-tsx 实现:[`extensions/copilot/src/extension/prompts/node/agent/`](https://github.com/microsoft/vscode/tree/main/extensions/copilot/src/extension/prompts/node/agent)
  - 通用:[`defaultAgentInstructions.tsx`](https://github.com/microsoft/vscode/blob/main/extensions/copilot/src/extension/prompts/node/agent/defaultAgentInstructions.tsx)
  - Claude 4.5/4.6:[`anthropicPrompts.tsx`](https://github.com/microsoft/vscode/blob/main/extensions/copilot/src/extension/prompts/node/agent/anthropicPrompts.tsx)
  - GLM 4.6/4.7:[`zaiPrompts.tsx`](https://github.com/microsoft/vscode/blob/main/extensions/copilot/src/extension/prompts/node/agent/zaiPrompts.tsx)
  - OpenAI/GPT-5:[`openai/defaultOpenAIPrompt.tsx`](https://github.com/microsoft/vscode/blob/main/extensions/copilot/src/extension/prompts/node/agent/openai/defaultOpenAIPrompt.tsx) + [`gpt5Prompt.tsx`](https://github.com/microsoft/vscode/blob/main/extensions/copilot/src/extension/prompts/node/agent/openai/gpt5Prompt.tsx)
  - Gemini:[`geminiPrompts.tsx`](https://github.com/microsoft/vscode/blob/main/extensions/copilot/src/extension/prompts/node/agent/geminiPrompts.tsx)
  - xAI/Grok:[`xAIPrompts.tsx`](https://github.com/microsoft/vscode/blob/main/extensions/copilot/src/extension/prompts/node/agent/xAIPrompts.tsx)
- Instruction 发现逻辑:[`platform/promptFiles/vscode-node/agentInstructionsLocator.ts`](https://github.com/microsoft/vscode/blob/main/extensions/copilot/src/platform/promptFiles/vscode-node/agentInstructionsLocator.ts)
- Skill/Agent 类型定义:[`platform/customInstructions/common/promptTypes.ts`](https://github.com/microsoft/vscode/blob/main/extensions/copilot/src/platform/customInstructions/common/promptTypes.ts)
- 配置项定义:[`src/vs/workbench/contrib/chat/common/promptSyntax/config/config.ts`](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/chat/common/promptSyntax/config/config.ts)
- proposed API `chat.getCustomAgents` / `chat.getInstructions`:[`src/vscode-dts/vscode.proposed.chatPromptFiles.d.ts` L390-417](https://github.com/microsoft/vscode/blob/main/src/vscode-dts/vscode.proposed.chatPromptFiles.d.ts)
- Agent host(CLI 后端)系统消息:[`src/vs/platform/agentHost/node/copilot/prompts/systemMessage.ts`](https://github.com/microsoft/vscode/blob/main/src/vs/platform/agentHost/node/copilot/prompts/systemMessage.ts)
- Agent host 自定义 spec:[`src/vs/sessions/copilot-customizations-spec.md`](https://github.com/microsoft/vscode/blob/main/src/vs/sessions/copilot-customizations-spec.md)

### MoA 现状(改造对象)

- workspaceContext(死代码):[`src/workspaceContext.ts`](../src/workspaceContext.ts)
- Recon prompt 构建:[`src/moaCore/roles.ts` buildReconPrompt](../src/moaCore/roles.ts)
- Planner prompt 构建:[`src/moaCore/roles.ts` buildPlannerPrompt](../src/moaCore/roles.ts)
- 工具过滤:[`src/actingAgent.ts` getActingTools](../src/actingAgent.ts)
