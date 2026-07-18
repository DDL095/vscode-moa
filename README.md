# vscode-moa

**Mixture-of-Agents chat participant for VSCode Copilot** — Trigger multi-LLM fan-out (3 reference advisors + 1 aggregator) directly from `@moa` in Copilot Chat.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![VSCode](https://img.shields.io/badge/VSCode-1.95+-blue.svg)](https://code.visualstudio.com)

## Status

**v0.1.0 — skeleton**. Provides:
- ✅ `@moa` participant registration with `isSticky`, slash commands (`preset`, `help`), and disambiguation examples
- ✅ Auto path detection (P1 / P2a / P2b) by scanning for `scripts/MoaWrapper.ps1`, `scripts/MoaSim.ps1`, `scripts/MoaAcp.ps1`
- ✅ P2b runner — spawns `pwsh -File MoaWrapper.ps1 -Prompt ... -Preset ...`, streams stdout into the chat
- ✅ P1 runner — picks up to 3 chat models via `vscode.lm.selectChatModels`, runs them in parallel, forwards to an aggregator model
- ⛔ P2a (ACP) — detected but **not implemented** in skeleton
- ⛔ No token-level streaming from `vscode.lm` (per-turn only)
- ⛔ No preset hot-reload

## Build & Run

```powershell
cd D:\BaiduYunDrive\OneDrive\实验相关文档\AI\moa-bridge\vscode-extension

# 1. Install deps
npm install

# 2. Bundle to dist/extension.js (dev mode, source maps)
npm run compile

# 3. (optional) Production bundle, hides source maps
npm run package

# 4. Launch Extension Development Host
code --extensionDevelopmentPath .
```

In the Extension Development Host, open Copilot Chat and type:

```
@moa ping
```

If the workspace contains `../moa-bridge/scripts/MoaWrapper.ps1`, you'll see P2b dispatch. Otherwise it falls back to P1 native fan-out.

## Configuration

No settings yet — paths are derived from the workspace root (`moa-bridge/scripts/`, `moa-bridge/presets/`).

For production packaging:

```powershell
npm install -g @vscode/vsce
vsce package
code --install-extension moa-bridge-0.1.0.vsix
```

## File layout

```
vscode-extension/
├── package.json           # Extension manifest + chatParticipants contribution
├── tsconfig.json          # TypeScript strict mode
├── webpack.config.js      # Bundles src/extension.ts → dist/extension.js
├── .vscodeignore
├── README.md              # This file
├── src/
│   ├── extension.ts       # activate() — registers @moa
│   ├── moaHandler.ts      # ChatRequestHandler — parse prompt → dispatch runner
│   ├── moaRunner.ts       # P2b (pwsh spawn) + P1 (vscode.lm fan-out) + path detection
│   └── types.ts           # Shared TS types
└── media/
    └── moa-icon.png       # ⚠️ PLACEHOLDER — replace with a real icon
```

## Presets

The participant expects presets at `<workspace>/moa-bridge/presets/`. v0.1.0 passes the preset name through to `MoaWrapper.ps1 -Preset <name>` but does not validate the JSON schema itself.

## Next steps

1. **Implement P2a (ACP)** — bridge to `MoaAcp.ps1` via the `formulahendry.acp-client` extension.
2. **Token-level streaming** — replace per-model `for await` loop with a `MarkdownString` chunked push.
3. **Preset schema validation** — read `presets/<name>.json` in `detectPath()` and validate before dispatch.
4. **Real icon** — drop a 64×64 PNG into `media/moa-icon.png` (currently absent — VSCode will use a default glyph).
5. **Settings contribution** — expose `moa-bridge.preset`, `moa-bridge.defaultPath`, etc.