/**
 * MoA Runner — bridges the chat participant to PowerShell MoA scripts.
 *
 * Two execution strategies are wired up here:
 *
 * 1. P2b — Call `MoaWrapper.ps1` via `pwsh`. Hermes handles the actual
 *    fan-out / aggregation, so this extension just pipes stdout into the
 *    chat response stream.
 *
 * 2. P1 — Native subagent simulation. We pick 3 chat models available via
 *    `vscode.lm.selectChatModels`, run them in parallel, then call an
 *    aggregator model to fuse the perspectives.
 *
 * P2a (ACP protocol) is detected but not implemented in this skeleton —
 * it requires a separate "ACP client" extension to be running.
 */

import { spawn } from 'child_process';
import * as path from 'path';
import * as vscode from 'vscode';
import type { MoaPath, MoaRunResult, PathDetection, ParsedPrompt } from './types';

/** Default preset name when none is specified. */
export const DEFAULT_PRESET = 'default';

/**
 * Find the moa-bridge root directory by walking up from the extension location
 * until a directory containing both `scripts/MoaWrapper.ps1` and `presets/`
 * is found. Falls back to a sibling `moa-bridge` directory next to the
 * extension's parent.
 */
export async function detectPath(): Promise<PathDetection> {
  // Prefer the first opened workspace folder (typical layout in dev).
  const wsFolders = vscode.workspace.workspaceFolders;
  let candidateRoot: string | undefined;

  if (wsFolders && wsFolders.length > 0) {
    candidateRoot = wsFolders[0].uri.fsPath;
  } else {
    // Fallback: derive from extension location (`<root>/vscode-extension/dist`).
    const extPath = vscode.extensions.getExtension('moa-bridge.moa-bridge')?.extensionPath;
    if (extPath) {
      candidateRoot = path.resolve(extPath, '..', '..');
    }
  }

  if (!candidateRoot) {
    return {
      path: 'unknown',
      workspaceRoot: '',
      scriptsDir: '',
      presetsDir: '',
      capabilities: {},
    };
  }

  const scriptsDir = path.join(candidateRoot, 'moa-bridge', 'scripts');
  const presetsDir = path.join(candidateRoot, 'moa-bridge', 'presets');

  // Naive capability check: does MoaWrapper.ps1 exist?
  const wrapperExists = await pathExists(path.join(scriptsDir, 'MoaWrapper.ps1'));
  const simExists = await pathExists(path.join(scriptsDir, 'MoaSim.ps1'));
  const acpExists = await pathExists(path.join(scriptsDir, 'MoaAcp.ps1'));

  let detected: MoaPath = 'unknown';
  if (wrapperExists) {
    detected = 'P2b';
  } else if (simExists) {
    detected = 'P1';
  } else if (acpExists) {
    detected = 'P2a';
  }

  return {
    path: detected,
    workspaceRoot: candidateRoot,
    scriptsDir,
    presetsDir,
    capabilities: {
      hasMoaWrapper: wrapperExists,
      hasMoaSim: simExists,
      hasMoaAcp: acpExists,
    },
  };
}

/**
 * Strip `preset=<name> ` prefix and slash-command prefix from the user prompt.
 *
 * Supported forms:
 *   - "preset=academic 分析 xxx"
 *   - "preset=fast"
 *   - "@moa preset=default 分析 xxx"
 */
export function parsePrompt(rawPrompt: string, slashCommand: string): ParsedPrompt {
  let prompt = rawPrompt.trim();
  const command = slashCommand ?? '';

  let presetName = DEFAULT_PRESET;

  const presetMatch = prompt.match(/^preset\s*=\s*([a-zA-Z0-9_\-\.]+)\s*/i);
  if (presetMatch) {
    presetName = presetMatch[1];
    prompt = prompt.slice(presetMatch[0].length).trim();
  }

  return { presetName, userPrompt: prompt, command };
}

/**
 * Run MoA via the P2b wrapper script.
 *
 * Streams stdout lines into the chat response stream as Markdown so the user
 * sees progress incrementally. Errors from the script are surfaced verbatim.
 */
export function runMoaWrapper(
  prompt: string,
  preset: string,
  detection: PathDetection,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken
): Promise<MoaRunResult> {
  return new Promise((resolve, reject) => {
    if (detection.path !== 'P2b') {
      reject(new Error(`P2b requested but wrapper script not found at ${detection.scriptsDir}`));
      return;
    }

    const script = path.join(detection.scriptsDir, 'MoaWrapper.ps1');
    const args = [
      '-NoProfile',
      '-File',
      script,
      '-Prompt', prompt,
      '-Preset', preset,
    ];

    const start = Date.now();
    stream.progress(`🚀 spawn pwsh MoaWrapper.ps1 (preset=${preset})`);

    const child = spawn('pwsh', args, {
      cwd: detection.workspaceRoot,
      env: process.env,
      windowsHide: true,
    });

    let stdoutBuf = '';
    let stderrBuf = '';

    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      stdoutBuf += text;
      // Echo progress lines (anything before the final aggregated Markdown
      // ends with a sentinel like "__MOA_END__" — see MoaWrapper.ps1 contract).
      stream.markdown(text);
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString('utf8');
      stream.markdown(`\`\`\`\n${chunk.toString('utf8')}\n\`\`\`\n`);
    });

    token.onCancellationRequested(() => {
      child.kill();
      reject(new Error('MoA cancelled by user'));
    });

    child.on('error', (err) => reject(err));

    child.on('close', (code) => {
      const elapsed = (Date.now() - start) / 1000;
      if (code !== 0) {
        reject(new Error(`MoaWrapper.ps1 exited with code ${code}\nstderr: ${stderrBuf}`));
        return;
      }
      resolve({
        output: stdoutBuf,
        elapsed,
        path: 'P2b',
        preset,
      });
    });
  });
}

/**
 * Run MoA via the P1 native subagent simulation.
 *
 * This is a *skeleton* — it picks the first 3 available chat models and asks
 * each for an opinion, then forwards them to an aggregator model. Real
 * implementation would parse MoaSim.ps1 output or replicate its fan-out logic.
 */
export async function runP1Fanout(
  prompt: string,
  preset: string,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken
): Promise<MoaRunResult> {
  const start = Date.now();

  // Pick any models the user has available.
  const allCandidates = await vscode.lm.selectChatModels({});

  // Filter out placeholder/pseudo models (e.g. VSCode's "Auto" selector).
  const PLACEHOLDER_NAMES = new Set(['auto', 'automatic', 'default', '']);
  let candidates = allCandidates.filter(
    (m) => !PLACEHOLDER_NAMES.has(m.name.toLowerCase().trim())
  );

  // Honor user preference: if `moa.preferredModels` is configured,
  // try to use those first (by substring match on name).
  const config = vscode.workspace.getConfiguration('moa');
  const preferred: string[] = config.get<string[]>('preferredModels') ?? [];
  if (preferred.length > 0) {
    const preferredMatches = candidates.filter((m) =>
      preferred.some((p) => m.name.toLowerCase().includes(p.toLowerCase()))
    );
    if (preferredMatches.length > 0) {
      candidates = preferredMatches;
      stream.progress(`[MoA] using preferred models filter: ${preferred.join(', ')}`);
    }
  }

  if (candidates.length === 0) {
    throw new Error(
      'No usable chat models available (all candidates are placeholders). ' +
        'Install/activate at least one real LLM provider extension (e.g. GCMP, Copilot), ' +
        'or set "moa.preferredModels" in settings.json.'
    );
  }

  // Try up to 5 candidates — we keep the first 3 that actually succeed.
  // This handles the case where some registered models fail (e.g. expired subscription).
  const maxRefs = 3;
  const probePool = candidates.slice(0, Math.min(5, candidates.length));
  stream.progress(
    `[MoA] probing ${probePool.length} model(s): ${probePool.map((m) => m.name).join(', ')}`
  );

  const refPrompts: vscode.LanguageModelChatMessage[] = [
    vscode.LanguageModelChatMessage.User(
      `You are one of several reference advisors. Provide a concise (<=200 word) perspective on:\n\n${prompt}`
    ),
  ];

  type RefResult = { model: vscode.LanguageModelChat; name: string; text: string };
  const successes: RefResult[] = [];
  const failures: { name: string; msg: string }[] = [];

  // Sequential probing (parallel is risky when many will fail — cascading 4xx/5xx).
  for (const model of probePool) {
    if (successes.length >= maxRefs) break;
    try {
      const response = await model.sendRequest(refPrompts, {}, token);
      let text = '';
      for await (const frag of response.text) {
        text += frag;
      }
      stream.markdown(`**Ref [${model.name}]**:\n\n${text}\n\n---\n\n`);
      successes.push({ model, name: model.name, text });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Truncate long API error JSON to first 150 chars for readability.
      const shortMsg = msg.length > 150 ? msg.substring(0, 150) + '...' : msg;
      stream.markdown(`**Ref [${model.name}]**: [skipped] ${shortMsg}\n\n---\n\n`);
      failures.push({ name: model.name, msg });
    }
  }

  // All refs failed — graceful degradation.
  if (successes.length === 0) {
    stream.markdown(
      `**[MoA degraded]** All ${failures.length} candidate model(s) failed. ` +
        `This usually means expired/invalid subscriptions or unsupported models.\n\n` +
        `**Troubleshooting**:\n` +
        `- Open Command Palette → "GCMP: 设置辅助工具模型" to pick a valid model\n` +
        `- Or set \`"moa.preferredModels": ["GLM-5.2", "DeepSeek-V4-Pro", "MiniMax-M3"]\` in settings.json\n` +
        `- Failed models: ${failures.map((f) => f.name).join(', ')}\n\n`
    );
    return {
      output: '[all refs failed]',
      elapsed: (Date.now() - start) / 1000,
      path: 'P1-degraded',
      preset,
    };
  }

  // Aggregator: pick from successful refs (prefer the first one that worked).
  const aggregator = successes[0].model;
  stream.progress(
    `[MoA] aggregator: ${aggregator.name} (using ${successes.length}/${successes.length + failures.length} successful refs)`
  );

  const aggMessages: vscode.LanguageModelChatMessage[] = [
    vscode.LanguageModelChatMessage.User(
      `You are an aggregator. Synthesize the following advisor perspectives into a single coherent answer (Markdown). Keep the strongest points from each, resolve conflicts explicitly, and end with a one-line recommendation.\n\nUser question:\n${prompt}\n\nAdvisor responses:\n${successes.map((r, i) => `[${i + 1}] ${r.name}:\n${r.text}`).join('\n\n')}`
    ),
  ];

  let aggregated = '';
  try {
    const aggResponse = await aggregator.sendRequest(aggMessages, {}, token);
    for await (const frag of aggResponse.text) {
      aggregated += frag;
    }
    stream.markdown(aggregated);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    stream.markdown(
      `**[Aggregator error]**: ${msg}\n\n` +
        `---\n\n**Fallback** — showing the first ref response verbatim:\n\n${successes[0].text}`
    );
    aggregated = successes[0].text;
  }

  return {
    output: aggregated,
    elapsed: (Date.now() - start) / 1000,
    path: successes.length >= 2 ? 'P1' : 'P1-partial',
    preset,
  };
}

/**
 * Tiny helper — promisified fs.access.
 */
async function pathExists(p: string): Promise<boolean> {
  try {
    const fs = await import('fs/promises');
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}