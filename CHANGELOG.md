# Change Log

All notable changes to the **vscode-moa** extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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