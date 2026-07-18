# vscode-moa

**Mixture-of-Agents (MoA) for VSCode Copilot Chat** — a 4-layer Hermes-style pipeline that orchestrates multiple LLMs (recon → refs → aggregator → acting agent) entirely through the native `vscode.lm` API.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![VSCode](https://img.shields.io/badge/VSCode-1.95+-blue.svg)](https://code.visualstudio.com)
[![Release](https://img.shields.io/badge/release-v0.14.1-blue.svg)](https://github.com/DDL095/vscode-moa/releases/tag/v0.14.1)

## What it does

`@moa <your question>` runs a multi-model fan-out directly in Copilot Chat:

```
user prompt
   │
   ▼
[Phase 0] Recon agent (read-only tools) ── collects relevant files / symbols
   │
   ▼
[Phase 1] N reference advisors (parallel) ── each produces {sufficient, missing, analysis}
   │                ↺ sufficiency loop (maxReconRounds, default 3)
   ▼
[Phase 2] Aggregator ── fuses ref outputs into guidance + completeness score
   │
   ▼
[Phase 3] Acting agent (tool-calling) ── executes the plan (read_file / apply_patch / run_in_terminal / …) and produces the final Markdown answer
```

Each layer is independently configurable and can be toggled. See [Architecture](#architecture) below.

## Install

### Option A — from GitHub Release (recommended)

1. Download `moa-bridge-0.14.1.vsix` from the [latest release](https://github.com/DDL095/vscode-moa/releases/tag/v0.14.1).
2. `code --install-extension moa-bridge-0.14.1.vsix`
3. Reload VSCode.

### Option B — from source

```powershell
git clone https://github.com/DDL095/vscode-moa.git
cd vscode-moa
npm install
npm run compile      # dev bundle with source maps
# or: npm run package  # production bundle
code --extensionDevelopmentPath .
```

## First-run configuration

Run **`Moa: Configure Models`** from the command palette — a 4-step flow:

| Step | What | UI |
|---|---|---|
| 1/4 | Reference advisors (2-8 models) | multi-select checkbox |
| 2/4 | Aggregator | single-select checkbox |
| 3/4 | Recon model *(optional, default = aggregator)* | single-select checkbox |
| 4/4 | L3 summarizer *(optional, default = disabled)* | single-select checkbox |

Configuration is persisted to **both** User (Global) and Workspace tiers, so it works across windows without manual duplication.

## Usage

### As a chat participant (simplest)

```
@moa refactor src/moaRunner.ts to extract the sufficiency loop into its own module
@moa 多视角分析这个 PR 的设计权衡
@moa review the auth flow in src/services/auth/
```

### As VSCode LM tools (composable)

MoA registers three LM tools that any agent (Copilot Chat, other extensions, MCP servers) can invoke:

| Tool | Purpose |
|---|---|
| `moa_recon` | Standalone read-only file collection — returns structured Markdown summary of relevant files. |
| `moa_analyze` | One-shot MoA analysis — N refs + 1 aggregator in a single call. |
| `moa_orchestrate` / `moa_continue` / `moa_finalize` | Hermes-style iterative loop with disk-persisted state. Supports `deferredResultId` for resume across compaction. |

Example workflow:

```
#moaRecon "gather everything related to the recon pipeline"
#moaAnalyze prompt="..." reconContext=<result from above>
```

Or drive the iterative loop manually:

```
#moaOrchestrate prompt="..." → returns task_id
#moaContinue task_id=<id> reconResult=<subagent output>
#moaFinalize task_id=<id> → action_items
```

## Architecture

### 4-layer pipeline (v0.8.0+)

| Layer | Role | Default model source | Tools? |
|---|---|---|---|
| **Phase 0 — Recon** | Read files / grep / list symbols; produce a context summary | `moa.reconModel` (falls back to aggregator) | Read-only whitelist (24-pattern hard blacklist + 3-pattern soft blacklist) |
| **Phase 1 — Refs** | N parallel advisors; each emits `{sufficient, missing, analysis}` JSON | `moa.refModels` (multi-select) | None (pure reasoning) |
| **Phase 2 — Aggregator** | Fuse ref outputs into guidance + `completeness` score | `moa.aggregator` | None |
| **Phase 3 — Acting** | Execute the plan with full tool access; produce final Markdown answer | `moa.aggregator` (shared) | All `vscode.lm.tools` (filtered through read/write split) |

Toggle layers:

- `moa.enableRecon` (default `true`) — skip Phase 0 entirely (v0.7.x behavior).
- `moa.enableActingAgent` (default `true`) — aggregator output becomes the final answer when `false` (v0.7.x 2-layer behavior).
- `moa.forceDirect` (default `false`) — bypass everything; acting agent runs with just the user prompt + workspace context.

### Recon safeguards (v0.13.0+)

- **Tool blacklist**: 24 hard-blocked patterns (write/edit/delete/run/exec/terminal/git/…) + 3 soft-blocked (`run_in_terminal`, `get_terminal_output`, `exec`).
- **Early-stop**: stagnant (2 consecutive identical tool signatures) **or** saturated (<200 new chars per iteration for 2 iterations).
- **Max iterations**: 50 (hard cap 100). Most tasks converge in <15.
- **L3 grandchild agent**: when a single file exceeds `moa.reconL3Threshold` (default 30000 chars), a small model (default MiniMax-M3) digests it to ~5k chars. Cached at `<workspace>/.moa_cache/l3_summaries/<sha1>.txt`. Set `moa.l3Summarizer.model = ""` to disable.

### Local cache & workspace artifacts (v0.14.10+)

**MoA writes intermediate artifacts to `<workspace>/.moa_cache/`.** These are **safe to delete** — MoA regenerates them on demand. The directory is created on first use and ships with an auto-generated `README.md` (Chinese-primary, bilingual key terms) that documents:

- What each subdirectory is (`recon/`, `l3_summaries/`, `<task_id>/`) and whether it's a cache, audit trail, or resumable state
- How to diagnose `@moa` outputs (which file to open to see what refs actually said)
- How to clean up (whole directory, by subdirectory, or extract useful pieces first)
- How to disable writes via `moa.*` settings
- Privacy notes (local-only; what gets sent to LLM providers)

**Layout** (see `.moa_cache/README.md` for the authoritative version after first run):

```
.moa_cache/
├── README.md                  # auto-generated v1 (not overwritten once user edits it)
├── recon/<task_sha>/          # end-to-end @moa trace (v0.14.3+)
│   ├── meta.json              #   task metadata (prompt, timing, char counts)
│   ├── 00_full_recon.md       #   full recon summary injected into refs
│   ├── 01_captured/           #   each recon tool call as its own .md
│   ├── 02_ref_outputs/        #   each ref's raw output (round-suffixed)
│   ├── 03_aggregator.md       #   aggregator synthesis (acting agent input)
│   └── 04_final.md            #   final user-facing output
├── l3_summaries/<sha1>.txt    # L3 large-file digest cache (v0.13.0+)
└── <task_id>/                 # moa_orchestrate iterative-loop state (v0.12.0+)
    ├── state.json             #   current MoaState (atomically overwritten)
    ├── task.txt               #   original task description
    ├── iteration_NNN/         #   per-iteration recon_request / recon_result / workers / aggregator
    └── final.json             #   #moa_finalize output
```

**Recommended `.gitignore` entry**:

```gitignore
# MoA Bridge cache (auto-generated by vscode-moa extension)
.moa_cache/
```

If you want to force-regenerate the cache README (e.g. after upgrading to a newer template version), delete `.moa_cache/README.md` and run any `@moa` command — it'll be rewritten on next cache directory creation. See [Local cache & workspace artifacts](#local-cache--workspace-artifacts-v01410) discussion in the CHANGELOG for the full motivation.

### Tokenizer

**None.** MoA has no tokenizer dependency — no `tiktoken`, no `js-tiktoken`, no `@vscode/*-tokenizer`. All budgets (`reconContextChars`, `reconL3Threshold`, `reconEarlyStopSaturated`, …) are **character-level approximations**. This keeps the bundle small (~125 KB vsix), avoids native bindings, and behaves consistently across Chinese / English / code. The trade-off is that "30k chars" is not "30k tokens" — for code-heavy prompts assume ~1.5-3× ratio.

## Relationship with GCMP

**MoA is vendor-agnostic** — it only calls `vscode.lm.selectChatModels({})` and uses whatever models VSCode exposes. It does not import, configure, or depend on [GCMP](https://marketplace.visualstudio.com/items?itemName=vicanent.gcmp) (or any other model-provider extension).

**But MoA is much more useful with GCMP installed.** The whole point of mixture-of-agents is *diverse* perspectives:

| Setup | Visible models | MoA behavior |
|---|---|---|
| Official Copilot only | GPT-5, Claude Sonnet, … (3-5) | Limited diversity — fan-out mostly hits same family |
| Official Copilot + **GCMP** | + DeepSeek-V4-Pro/Flash, GLM-5.2, MiniMax-M3, Qwen3, … (10-30+) | **True heterogeneous MoA** — different labs, different training data, different reasoning styles |

Recommended pairing:

| Layer | Recommended vendor |
|---|---|
| Refs (Phase 1) | DeepSeek-V4-Pro + GLM-5.2 + MiniMax-M3 (or any 3 different labs) |
| Aggregator (Phase 2) | GLM-5.2 (CodingPlan) — strong fusion reasoning |
| Recon (Phase 0) | = aggregator (default) or DeepSeek-V4-Flash for speed |
| L3 Summarizer | MiniMax-M3 (TokenPlan) — cheap, good at compression |

MoA is fully vendor-agnostic — there are **no hardcoded model IDs** in the codebase. Every layer reads its model from the `moa.*` configuration namespace; empty values disable the layer (or fall back to aggregator, in the case of `moa.reconModel`).

## Configuration reference

All settings live under the `moa.*` namespace. Edit via `settings.json` or use **`Moa: Configure Models`** for the 4-step guided flow.

### Models

| Key | Type | Default | Description |
|---|---|---|---|
| `moa.refModels` | `Array<{role, model}>` | `[]` | Reference advisors. `model` is matched as a substring against `LanguageModelChat.id`. |
| `moa.aggregator` | `{model, temperature?}` | `{}` | Aggregator model (substring match). |
| `moa.reconModel` | `{model}` | `{model: ""}` | Recon model. Empty = reuse aggregator. |
| `moa.l3Summarizer` | `{model}` | `{model: ""}` | L3 grandchild model. Empty = disable L3. |

### Pipeline behavior

| Key | Type | Default | Description |
|---|---|---|---|
| `moa.parallelRefs` | boolean | `false` | Fan out refs in parallel (faster but may trigger 429s). |
| `moa.sharedRefPrompt` | string | `""` | Override the shared ref system prompt. Empty = built-in Hermes prompt. |
| `moa.refDisplayMode` | `"thinking"` \| `"verbose"` | `"thinking"` | `thinking` keeps refs out of chat history (Hermes-style); `verbose` streams inline. |
| `moa.enableRecon` | boolean | `true` | Toggle Phase 0. |
| `moa.enableActingAgent` | boolean | `true` | Toggle Phase 3. |
| `moa.forceDirect` | boolean | `false` | Skip the whole pipeline — direct acting agent. |
| `moa.maxReconRounds` | number (1-5) | `3` | Sufficiency-loop cap. |

### Recon tuning (v0.13.0+)

| Key | Default | Description |
|---|---|---|
| `moa.maxReconIterations` | `50` | Hard cap on tool calls per recon task. |
| `moa.reconContextChars` | `30000` | Character budget for the recon summary injected into ref prompts. |
| `moa.reconAllowTerminal` | `false` | Allow terminal tools in recon (off by default for safety). |
| `moa.reconEarlyStopStagnant` | `2` | Stop after N consecutive identical tool signatures. |
| `moa.reconEarlyStopSaturated` | `200` | Stop after N iterations adding <200 chars each (post-iter-5). |
| `moa.reconL3Threshold` | `30000` | Single-file size (chars) that triggers L3 summarization. |
| `moa.reconL3MaxCalls` | `5` | Max L3 grandchild calls per MoA task. `0` disables. |

## File layout

```
vscode-moa/
├── package.json                # manifest, chatParticipants, languageModelTools, configuration
├── src/
│   ├── extension.ts            # activate() — registers @moa + LM tools + commands
│   ├── moaHandler.ts           # ChatRequestHandler — dispatches @moa invocations
│   ├── moaRunner.ts            # core 4-layer pipeline (recon → refs → aggregator → acting)
│   ├── moaConfig.ts            # Configure Models 4-step flow + singlePickWithCheckbox
│   ├── actingAgent.ts          # Phase 3 tool-calling agent + read-only tool filter
│   ├── workspaceContext.ts     # active editor / open docs / project tree snapshot
│   ├── l3Summarizer.ts         # L3 grandchild agent (large-file digest) + cache
│   ├── cacheReadme.ts          # auto-write `.moa_cache/README.md` on first creation (v0.14.10+)
│   ├── moaReconTool.ts         # moa_recon LM tool impl
│   ├── moaTool.ts              # moa_analyze LM tool impl
│   ├── moaOrchestrator.ts      # iterative MoA loop state machine
│   ├── moaOrchestrateTools.ts  # moa_orchestrate / continue / finalize LM tools
│   ├── probeTools.ts           # debug command — list vscode.lm.tools
│   └── types.ts                # shared TS types
├── CHANGELOG.md
└── README.md
```

## Debugging

- **`Moa: Probe Available Tools`** — lists every tool registered in `vscode.lm.tools`. Use this to verify Copilot / other extensions are exposing the tools MoA's acting agent can call.
- Set `"moa.refDisplayMode": "verbose"` to see raw ref outputs inline (useful when debugging aggregator fusion issues).
- Recon state for iterative runs persists to `<workspace>/.moa_cache/<task_id>/`.
- **End-to-end audit**: every `@moa` invocation writes a complete trace to `<workspace>/.moa_cache/recon/<task_sha>/` — see [Local cache & workspace artifacts](#local-cache--workspace-artifacts-v01410) for how to navigate it. The auto-generated `.moa_cache/README.md` (written on first cache creation) has a dedicated "Diagnostics" section.

## Build & release

```powershell
npm install
npm run compile          # dev bundle
npm run package          # production bundle
npx vsce package         # build .vsix
```

Releases are published to [GitHub Releases](https://github.com/DDL095/vscode-moa/releases) — each release has the corresponding `.vsix` attached.

## License

MIT — see [LICENSE](./LICENSE).
