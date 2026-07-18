# Change Log

All notable changes to the **vscode-moa** extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Initial public release preparation
- `@moa` chat participant registration
- Three preset configurations: `default` / `fast` / `academic`
- Native VSCode MoA implementation (no external agent dependency)
- Multi-LLM fan-out (3 reference advisors) + 1 aggregator
- Streaming output to Copilot Chat panel via `vscode.chat.createChatParticipant`
- Slash command `/preset` for switching preset
- Tool registry mapping (Hermes-equivalent tools → VSCode API)

### Known Limitations
- MVP stage: aggregator tool calling not yet wired to full VSCode tool ecosystem
- No `per_iteration` fanout mode (single-turn only in v0.1)
- English-only UI in v0.1 (i18n scaffolding in place)
