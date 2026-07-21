# vscode-moa

> 🌐 **Languages / 语言**: **English (current)** | [中文](./README.md)

**Mixture-of-Agents (MoA) for VSCode Copilot Chat** — a streamlined 5-role pipeline (Planner → Recon → Refs → Aggregator → Actor) that orchestrates multiple LLMs entirely through the native `vscode.lm` API.
>
> *中文用户请查看 [README.md](./README.md)（中文版，含英文对照）。Chinese-speaking users please see [README.md](./README.md) for the bilingual Chinese-English version.*

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![VSCode](https://img.shields.io/badge/VSCode-1.95+-blue.svg)](https://code.visualstudio.com)
[![Marketplace](https://img.shields.io/badge/Marketplace-dudali095.moa--bridge-green.svg)](https://marketplace.visualstudio.com/items?itemName=dudali095.moa-bridge)
[![GitHub Release](https://img.shields.io/github/v/release/DDL095/vscode-moa?color=blue&label=release)](https://github.com/DDL095/vscode-moa/releases/latest)

## What it does

`@moa <your question>` runs a multi-model fan-out directly in Copilot Chat. Three entry points, two loop shapes:

| Entry point | When to use | Loop shape |
|---|---|---|
| `@moa` (default) | Most cases — iterative refinement until Aggregator converges | Hermes loop, up to `MAX_ITER=12` |
| `@moaloop` | Same as `@moa` — explicit loop mode | Hermes loop |
| `@moasingle` | Fast single-shot — 1 iteration, forced finalize | No loop |
| `#moa_orchestrate` / `#moa_continue` / `#moa_finalize` | LM tools — drive the loop from another agent or chat | Hermes loop, disk-persisted state |
| `#moa_analyze` | LM tool — one-shot N refs + 1 aggregator, no loop | No loop |
| `#moa_recon` | LM tool — standalone read-only file collection | N/A |

The pipeline diagram and full architecture description are in [README.md (Chinese, bilingual)](./README.md#the-5-role-pipeline-v0150-redesigned-in-v017v018) — the diagram itself uses bilingual labels.

## Install

### Option A — from VSCode Marketplace (recommended)

1. Open the Extensions panel (`Ctrl+Shift+X`)
2. Search **"MoA Bridge"**
3. Click Install

### Option B — from GitHub Release

1. Go to [Releases](https://github.com/DDL095/vscode-moa/releases/latest)
2. Download `moa-bridge-X.Y.Z.vsix`
3. Run: `code --install-extension moa-bridge-X.Y.Z.vsix`

### Option C — from source

```bash
git clone https://github.com/DDL095/vscode-moa.git
cd vscode-moa
npm install
npm run package      # produces dist/extension.js
npx vsce package     # produces .vsix
code --install-extension moa-bridge-X.Y.Z.vsix
```

## First-run configuration

Out of the box, MoA has no models configured — you must tell it which LLMs to use. Two ways:

### Quick start — use the 8-step guided flow

1. Open Command Palette (`Ctrl+Shift+P`)
2. Run **`Moa: Configure Models`**
3. The wizard walks you through 8 steps: Ref models (3+ recommended) → Aggregator → Recon model → L3 summarizer → done

### Manual — edit `settings.json`

```json
{
  "moa.refModels": [
    { "role": "advisor_1", "model": "DeepSeek-V4-Flash" },
    { "role": "advisor_2", "model": "MiniMax-M3" },
    { "role": "advisor_3", "model": "GLM-5.2" }
  ],
  "moa.aggregator": { "model": "GLM-5.2" }
}
```

`model` is matched as a **substring** against `LanguageModelChat.id` (e.g. `"GLM-5.2"` matches `gcmp.zhipu:::GLM-5.2-CodingPlan`). All models must be registered via `vscode.lm` (GCMP, Copilot, Ollama, etc.).

### Preset groups (v0.14.14+)

Save multiple configurations as named presets and switch between them:

```json
{
  "moa.presets": {
    "default": {
      "name": "Daily coding",
      "refModels": [...],
      "aggregator": {...},
      "reconModel": {...}
    },
    "research": {
      "name": "Deep research",
      "refModels": [...],
      "aggregator": {...}
    }
  },
  "moa.activePreset": "default"
}
```

Switch via **`Moa: Switch Preset`** command.

## Usage

### As a chat participant (simplest)

Just type `@moa` followed by your question in Copilot Chat:

```
@moa Why is my React component re-rendering on every keystroke?
```

Three participants available:

- `@moa` — default loop mode (Planner → Recon → Refs → Aggregator → Actor, up to 12 iterations)
- `@moaloop` — explicit loop mode (same as `@moa`)
- `@moasingle` — single-shot mode (1 iteration, forced finalize — fastest)

### As VSCode LM tools (composable)

For driving MoA from another agent or chat context, use the LM tools:

- **`#moa_orchestrate`** — start a new MoA task; returns `task_id`
- **`#moa_continue`** — advance the loop by one iteration (use when state is `awaiting_recon` or `running`)
- **`#moa_finalize`** — force-finalize a task; returns `action_items[]`
- **`#moa_analyze`** — one-shot analysis (1 Recon + N Refs + 1 Aggregator, no loop)
- **`#moa_recon`** — standalone read-only file collection
- **`#moa_execute`** (v0.20.0+) — execute finalized `action_items` via SafeExecutor (subject to approval gates)

Example flow:
```
#moa_orchestrate("analyze this codebase for security issues")  → task_id
#moa_continue(task_id)  → state.status = "running"
#moa_continue(task_id)  → state.status = "running"
#moa_finalize(task_id)  → action_items[]
```

## Pipeline visibility — 5 OutputChannels (v0.17.0+)

Each role streams detailed output to its own VSCode OutputChannel:

| Channel | Content |
|---|---|
| `MoA Bridge — Planner` | Planner prompts and outputs (iter 1 only) |
| `MoA Bridge — Recon` | Recon agent tool calls and summaries |
| `MoA Bridge — Ref Output` | Raw ref advisor outputs (thinking mode) |
| `MoA Bridge — Aggregator` | Aggregator synthesis + completeness + next_action |
| `MoA Bridge — Actor` | Actor tool calls + executed actions |

View via `Output` panel (`Ctrl+Shift+U`) → select channel from dropdown.

## Architecture

### 5 roles (v0.15.0+, redesigned v0.17–v0.18)

| Role | Order | Purpose | Tools | Default model |
|---|---|---|---|---|
| **Planner** | 1 (iter 1 only) | Clarify task, emit `sub_questions[]` + `recon_hints[]` | read-only | (aggregator model) |
| **Recon** | 2 | Gather file contents relevant to the task (1 agent per recon model) | read/grep/fetch (terminal opt-in) | DeepSeek-V4-Pro + MiniMax-M3 |
| **Refs** | 3 | N parallel advisors analyze evidence + emit structured JSON | pure LLM (no tools) | 3+ different models |
| **Aggregator** | 4 | Fuse N ref outputs, score completeness, decide next_action | pure LLM | GLM-5.2 (CodingPlan) |
| **Actor** | 5 | Execute `action_items` (write_file / execute / inform_user) | full tool access | GLM-5.2 (CodingPlan) |
| **Recon Aggregator** | (after Recon) | Merge N parallel Recon outputs into single evidence stream | verify-only | GLM-5.2 (CodingPlan) |
| **L3 Summarizer** | (grandchild) | Digest huge files (>200k chars) before they hit Recon | none | MiniMax-M3 (TokenPlan) |

MoA is fully vendor-agnostic — there are **no hardcoded model IDs** in the codebase. Every layer reads its model from the `moa.*` configuration namespace; empty values disable the layer (or fall back to aggregator, in the case of `moa.reconModel`).

### Recon safeguards (v0.13.0+)

- `moa.maxReconIterations` (default 50, max 500) — hard cap on tool calls per recon task
- `moa.reconEarlyStopStagnant` (default 2) — stop after N consecutive identical tool signatures
- `moa.reconEarlyStopSaturated` (default 200) — stop after N iterations adding <200 chars each (post-iter-5)
- `moa.reconL3Threshold` (default 200000) — single-file size triggering L3 summarization
- `moa.reconAllowTerminal` (default false) — gate terminal tools in recon

### Local cache & workspace artifacts (v0.14.10+, updated v0.18.0)

All task state persists to `<workspace>/.moa_cache/<task_id>/`:

```
.moa_cache/<task_id>/
├── state.json              # live MoA state (updated every iteration)
├── meta.json               # aggregated metadata (models, timings, role breakdown)
├── timeline.md             # human-readable per-iteration table
├── task.txt                # original user prompt
├── final.md                # Aggregator's final synthesis (markdown)
├── final.json              # structured action_items[]
├── manifest.json           # SafeExecutor audit log (v0.19.1+)
├── autopilot.log           # v0.20.0+ autopilot execution summary
└── iteration_001/
    ├── planner.json
    ├── recon/
    │   ├── advisor_1__DeepSeek-V4-Pro.json
    │   └── advisor_2__MiniMax-M3.json
    ├── recon_aggregator.json
    ├── refs/
    │   ├── advisor_1__DeepSeek-V4-Flash.json
    │   ├── advisor_2__MiniMax-M3.json
    │   └── advisor_3__GLM-5.2.json
    ├── aggregator.json
    └── actor.json (if Actor ran)
```

### Tokenizer

**None.** MoA has no tokenizer dependency — no `tiktoken`, no `js-tiktoken`, no `@vscode/*-tokenizer`. All budgets (`reconContextChars`, `reconL3Threshold`, `reconEarlyStopSaturated`, …) are **character-level approximations**. This keeps the bundle small (~370 KB vsix), avoids native bindings, and behaves consistently across Chinese / English / code. The trade-off is that "30k chars" is not "30k tokens" — for code-heavy prompts assume ~1.5-3× ratio.

## Relationship with GCMP

This extension works alongside [GCMP](https://marketplace.visualstudio.com/items?itemName=vicanent.gcmp) but is **independent**. GCMP registers model providers; MoA consumes them via `vscode.lm`. You can use MoA with any provider source (GCMP, Copilot, Ollama, LM Studio, etc.).

## Actor execution control (v0.20.0+)

The Actor role actually *executes* the Aggregator's `action_items` — it can write files, run terminal commands, and produce side effects. v0.20.0 introduces a layered control system to gate this power.

**At a glance — the 4+1 `executionPreset` modes**:

| Preset | Auto-execute after finalize? | Approval popups | Backup `.bak.<ts>` | Use case |
|---|---|---|---|---|
| `manual` (default) | ❌ returns markdown; user calls `#moa_execute` | `batch` (Gate-A QuickPick) | ✅ | First-time use, exploratory tasks |
| `supervised` | ✅ | `batch` (Gate-A QuickPick multi-select per round) | ✅ | Trusted but human-monitored workflows |
| `autopilot` | ✅ | `none` (zero human-in-the-loop) | ✅ (only safety net) | Trusted CI / repeated retry pipelines |
| `yolo` | ✅ | `none` | ❌ (irreversible) | Sandboxed / throwaway runs |
| `custom` | controlled by `autoExecuteAfterFinalize` | controlled by `approvalMode` | controlled by `safeExecutionMode` | Manual fine-grained control |

**Execution flow under each preset**:

```
finalize completes
   │
   ├─ manual:        return markdown → user/main session calls #moa_execute → Gate-A QuickPick → execute
   ├─ supervised:    auto-call Actor → Gate-A QuickPick multi-select → execute (safeMode on)
   ├─ autopilot:     auto-call Actor → execute immediately (safeMode on, no popups)
   ├─ yolo:          auto-call Actor → execute immediately (safeMode off, no popups, no backup)
   └─ custom:        behavior driven by 3 fine-grained configs below
```

**The 3 fine-grained configs** (only effective when `executionPreset='custom'`; otherwise preset overrides):

| Key | Type | Default | Description |
|---|---|---|---|
| `moa.autoExecuteAfterFinalize` | boolean | `false` | When `true`, `finalizeTask()` auto-invokes Actor. When `false`, returns markdown for manual `#moa_execute`. |
| `moa.approvalMode` | `none` \| `batch` \| `per_call` \| `batch_plus_per_call` | `batch` | Approval gate before destructive tool calls. `batch` = Gate-A QuickPick at Actor entry; `per_call` = Gate-B Yes/No dialog before each destructive call; `batch_plus_per_call` = both gates. |
| `moa.safeExecutionMode` | boolean | `true` | When `true`, SafeExecutor backs up every `write_file` to `<target>.bak.<timestamp>` and records all actions to `manifest.json`. When `false`, no backup (irreversible). |

**Approval gates — two flavors**:

- **Gate-A (batch)**: QuickPick multi-select dialog at the entry of each Actor call. Lists all `action_items` with type + target + rationale. User can deselect unwanted items. Rejected items are recorded as `status: rejected_by_user` in `manifest.json` for auditability.
- **Gate-B (per-call)**: Yes/No/Yes to All/Reject All dialog before each destructive tool call (`write_file` / `delete` / `execute`). `Yes to All` skips subsequent Gate-B prompts in the same task. `Reject All` throws `ApprovalRejectedError` and aborts the Actor.

**Auditing & recovery**:

- Every side-effecting action (in any preset) is logged to `.moa_cache/<task_id>/manifest.json` with `iter` / `seq` / `type` / `target` / `tool_name` / `input_summary` / `status` / `backup_path` / `output_chars` / `timestamp`.
- Backups go to `<target>.bak.<timestamp>` next to the original file. To roll back, delete the new file and rename `.bak.<ts>` back.
- `autopilot.log` (v0.20.0) in the task dir is a human-readable summary: `started_at` / `elapsed_sec` / `tool_calls` / per-action status. Useful for CI logs.

> 📖 For the full bilingual (Chinese + English) configuration reference including all `moa.*` settings, see [README.md → Configuration reference](./README.md#configuration-reference).

## Configuration reference

All settings live under the `moa.*` namespace. Edit via `settings.json` or use **`Moa: Configure Models`** for the 8-step guided flow. The in-VSCode settings UI shows bilingual descriptions (Chinese + English) for every config item as of v0.20.2+.

For the full reference tables (Models / Pipeline behavior / Recon tuning / Actor execution control / Cache & lifecycle), see the [bilingual README.md → Configuration reference](./README.md#configuration-reference) section — the tables are language-neutral.

## Debugging

- Set `"moa.refDisplayMode": "verbose"` to see raw ref outputs inline (useful when debugging aggregator fusion issues). ⚠️ Warning: pollutes Copilot context — see setting description.
- Run **`Moa: Probe Tools`** to list all registered `vscode.lm.tools` (verifies tool availability).
- Check `.moa_cache/<task_id>/meta.json` for per-role timings, model invocations, and convergence timeline.
- Check `.moa_cache/<task_id>/manifest.json` for SafeExecutor audit trail.

## Build & release

```bash
npm run compile       # webpack dev build
npm run package       # webpack production build
npx tsc --noEmit      # type-check only
npm test              # run all tests (node --test)
npx vsce package      # produce .vsix
```

Release flow:

1. Bump version in `package.json`
2. `npx vsce package` → produces `moa-bridge-X.Y.Z.vsix`
3. `git tag vX.Y.Z && git push origin main && git push origin vX.Y.Z`
4. Create GitHub Release with release notes from `CHANGELOG.md`
5. `npx vsce publish` (requires Marketplace PAT — currently manual)

## License

[MIT](./LICENSE)
