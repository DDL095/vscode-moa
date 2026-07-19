# Change Log

All notable changes to the **vscode-moa** extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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