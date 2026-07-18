/**
 * Interactive configuration commands for MoA Bridge.
 *
 * Provides three commands accessible via Command Palette:
 *   - moa.configureModels  : QuickPick UI to assign models to ref roles
 *   - moa.listModels       : Show all available vscode.lm models
 *   - moa.testModels       : Probe each registered model with a tiny ping
 *
 * Settings written to `moa.refModels` (array of {role, model, systemHint}).
 */

import * as vscode from 'vscode';
import type { RefModelConfig, AggregatorConfig } from './types';

/** Default role labels offered when the user has no config yet. */
const DEFAULT_ROLE_SUGGESTIONS = [
  'Technical',
  'Logical',
  'Creative',
  'Academic',
  'Practical',
  'Skeptical',
];

/**
 * List all available chat models in the current VSCode instance.
 * Returns a formatted string list (for the `moa.listModels` command output).
 */
export async function listAvailableModels(): Promise<void> {
  const models = await vscode.lm.selectChatModels({});

  if (models.length === 0) {
    showOutput(
      'No chat models available',
      'No models are registered with vscode.lm.\n\n' +
        'Install/activate at least one LLM provider extension (GCMP, Copilot, etc.).'
    );
    return;
  }

  const lines = models.map((m, i) => {
    const id = m.id ?? '(no id)';
    const vendor = m.vendor ?? '(unknown vendor)';
    return `${i + 1}. **${m.name}**  —  vendor: \`${vendor}\`, id: \`${id}\`, max tokens: ${m.maxInputTokens}`;
  });

  showOutput(
    `Available chat models (${models.length})`,
    lines.join('\n') +
      '\n\n---\n\nUse these **name substrings** when configuring `moa.refModels` or `moa.preferredModels`.'
  );
}

/**
 * Interactive QuickPick flow for assigning models to advisor roles.
 *
 * Flow:
 *   1. Ask how many refs (1-5)
 *   2. For each ref: ask for role label + pick model
 *   3. Pick aggregator model
 *   4. Save to workspace/user settings
 */
export async function configureModels(): Promise<void> {
  // ---------- Step 1: how many refs ----------
  const refCountPick = await vscode.window.showQuickPick(
    [
      { label: '2', description: 'Fast — 2 reference advisors', value: 2 },
      { label: '3', description: 'Default — 3 reference advisors', value: 3, picked: true },
      { label: '4', description: 'Thorough — 4 reference advisors', value: 4 },
      { label: '5', description: 'Maximum — 5 reference advisors', value: 5 },
    ],
    { placeHolder: 'How many reference advisors (ref roles)?' }
  );
  if (!refCountPick) return;
  const refCount = (refCountPick as any).value as number;

  // ---------- Enumerate models once ----------
  const allModels = await vscode.lm.selectChatModels({});
  if (allModels.length === 0) {
    vscode.window.showErrorMessage(
      'No chat models available. Install/activate an LLM provider extension first.'
    );
    return;
  }
  const modelItems = allModels.map((m) => ({
    label: m.name,
    description: m.vendor ?? '',
    detail: m.id ?? '',
    model: m,
  }));

  // ---------- Step 2: configure each ref ----------
  const existingRefs = vscode.workspace.getConfiguration('moa').get<RefModelConfig[]>('refModels') ?? [];
  const newRefs: RefModelConfig[] = [];

  for (let i = 0; i < refCount; i++) {
    // Role label
    const existingRole = existingRefs[i]?.role;
    const roleInput = await vscode.window.showInputBox({
      prompt: `Ref ${i + 1}/${refCount} — role label`,
      value: existingRole ?? DEFAULT_ROLE_SUGGESTIONS[i] ?? `Advisor ${i + 1}`,
      placeHolder: 'e.g. Technical, Logical, Creative',
      validateInput: (v) => (v.trim().length === 0 ? 'Role cannot be empty' : undefined),
    });
    if (!roleInput) return; // cancelled
    const role = roleInput.trim();

    // Model pick
    const modelPick = await vscode.window.showQuickPick(modelItems, {
      placeHolder: `Ref ${i + 1} (${role}) — pick a model`,
      title: `Reference Advisor ${i + 1}/${refCount}: ${role}`,
    });
    if (!modelPick) return;
    const modelName = (modelPick as any).label as string;

    // Optional system hint
    const existingHint = existingRefs[i]?.systemHint;
    const hintInput = await vscode.window.showInputBox({
      prompt: `Ref ${i + 1} (${role}, ${modelName}) — optional system hint`,
      value: existingHint ?? '',
      placeHolder: 'e.g. "Focus on implementation details" (leave empty for default)',
    });

    newRefs.push({
      role,
      model: modelName,
      ...(hintInput && hintInput.trim() ? { systemHint: hintInput.trim() } : {}),
    });
  }

  // ---------- Step 3: aggregator ----------
  const existingAgg = vscode.workspace.getConfiguration('moa').get<AggregatorConfig>('aggregator');
  const aggPick = await vscode.window.showQuickPick(modelItems, {
    placeHolder: 'Pick the aggregator (synthesizer) model',
    title: 'Aggregator Model',
  });
  if (!aggPick) return;
  const aggModel = (aggPick as any).label as string;

  // ---------- Step 4: save ----------
  const targetPick = await vscode.window.showQuickPick(
    [
      { label: 'Workspace', description: '.vscode/settings.json (this project only)', target: vscode.ConfigurationTarget.Workspace, picked: true },
      { label: 'User', description: 'Global settings (all projects)', target: vscode.ConfigurationTarget.Global },
    ],
    { placeHolder: 'Save configuration to?' }
  );
  if (!targetPick) return;
  const target = (targetPick as any).target as vscode.ConfigurationTarget;

  const cfg = vscode.workspace.getConfiguration('moa');
  await cfg.update('refModels', newRefs, target);
  await cfg.update('aggregator', { model: aggModel, temperature: existingAgg?.temperature ?? 0.4 }, target);
  // Clear preferredModels since refModels is more specific.
  await cfg.update('preferredModels', undefined, target);

  vscode.window.showInformationMessage(
    `MoA configured: ${newRefs.length} refs (${newRefs.map((r) => r.role).join(', ')}) + aggregator ${aggModel}`
  );
}

/**
 * Probe each registered model with a tiny ping, show which ones work.
 * Useful to catch "registered but subscription expired" models before MoA runs.
 */
export async function testModels(): Promise<void> {
  const models = await vscode.lm.selectChatModels({});
  if (models.length === 0) {
    showOutput('No models', 'No chat models registered.');
    return;
  }

  const results: { name: string; status: 'ok' | 'fail'; detail: string }[] = [];
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Probing ${models.length} model(s)...`,
      cancellable: false,
    },
    async (progress) => {
      for (let i = 0; i < models.length; i++) {
        const m = models[i];
        progress.report({ message: `${i + 1}/${models.length}: ${m.name}`, increment: 100 / models.length });
        try {
          const response = await m.sendRequest(
            [vscode.LanguageModelChatMessage.User('Reply with exactly: PONG')],
            {},
            new vscode.CancellationTokenSource().token
          );
          let text = '';
          for await (const frag of response.text) text += frag;
          results.push({ name: m.name, status: 'ok', detail: text.trim().substring(0, 60) });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          results.push({ name: m.name, status: 'fail', detail: msg.substring(0, 150) });
        }
      }
    }
  );

  const ok = results.filter((r) => r.status === 'ok');
  const fail = results.filter((r) => r.status === 'fail');
  const lines = [
    `**Models OK (${ok.length})**:`,
    ...ok.map((r) => `- ✅ ${r.name} — "${r.detail}"`),
    '',
    `**Models FAILED (${fail.length})**:`,
    ...fail.map((r) => `- ❌ ${r.name} — ${r.detail}`),
    '',
    '---',
    'Use the **working** models in `moa.refModels` via "Moa: Configure Models" command.',
  ];
  showOutput(`Model probe results (${ok.length}/${results.length} working)`, lines.join('\n'));
}

// ---------- helpers ----------

function showOutput(title: string, body: string): void {
  const channel = vscode.window.createOutputChannel('MoA Bridge');
  channel.clear();
  channel.appendLine(`=== ${title} ===`);
  channel.appendLine('');
  channel.appendLine(body);
  channel.show(true);
}
