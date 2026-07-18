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
  const candidates = await vscode.lm.selectChatModels({});
  if (candidates.length === 0) {
    throw new Error('No chat models available — install/activate at least one LLM provider extension.');
  }

  const refs = candidates.slice(0, Math.min(3, candidates.length));
  stream.progress(`🧠 Fan-out to ${refs.length} reference model(s)`);

  const refPrompts: vscode.LanguageModelChatMessage[] = [
    vscode.LanguageModelChatMessage.User(
      `You are one of several reference advisors. Provide a concise (≤200 word) perspective on:\n\n${prompt}`
    ),
  ];

  const refResponses = await Promise.all(
    refs.map(async (model) => {
      try {
        const response = await model.sendRequest(refPrompts, {}, token);
        let text = '';
        for await (const frag of response.text) {
          text += frag;
        }
        stream.markdown(`**Ref [${model.name}]**: ${text}\n\n---\n\n`);
        return { model: model.name, text };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        stream.markdown(`**Ref [${model.name}]**: ⚠️ ${msg}\n\n---\n\n`);
        return { model: model.name, text: `[error] ${msg}` };
      }
    })
  );

  // Aggregator: first model plays the synthesizer role.
  const aggregator = refs[0];
  stream.progress(`🎯 Aggregator: ${aggregator.name}`);

  const aggMessages: vscode.LanguageModelChatMessage[] = [
    vscode.LanguageModelChatMessage.User(
      `You are an aggregator. Synthesize the following advisor perspectives into a single coherent answer (Markdown). Keep the strongest points from each, resolve conflicts explicitly, and end with a one-line recommendation.\n\nUser question:\n${prompt}\n\nAdvisor responses:\n${refResponses.map((r, i) => `[${i + 1}] ${r.model}:\n${r.text}`).join('\n\n')}`
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
    stream.markdown(`⚠️ Aggregator failed: ${msg}`);
  }

  return {
    output: aggregated,
    elapsed: (Date.now() - start) / 1000,
    path: 'P1',
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