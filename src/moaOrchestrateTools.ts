/**
 * MoA Orchestration LM Tools (v0.12.0).
 *
 * Three LM tools that expose the iterative MoA loop to the main Copilot session.
 * The main LLM orchestrates the loop; vscode-moa provides the persistent state
 * + worker/aggregator LLM calls.
 *
 * Typical loop:
 *   1. LLM calls #moa_orchestrate(task) → gets task_id
 *   2. Iteration loop:
 *      a. If state.status == "awaiting_recon": LLM reads recon prompt from
 *         result, calls #runSubagent(prompt), then #moa_continue(task_id,
 *         subagent_result=<runSubagent output>)
 *      b. If state.status == "running": LLM calls #moa_continue(task_id)
 *         (no subagent_result) to advance another iteration
 *      c. If state.status == "finalized" or max iterations: break
 *   3. LLM calls #moa_finalize(task_id) → gets action_items
 *   4. LLM executes action_items using its own tools (writeFile, execute, etc.)
 *
 * The orchestrator never invokes #runSubagent itself — only the main LLM can.
 * This keeps recon as an explicit, observable step the user can see in chat.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { promises as fsPromises } from 'fs';
import {
  createOrchestration,
  runIteration,
  finalizeTask,
  executeFinalActions,
  loadState,
  formatStatusMarkdown,
  type MoaFinalOutput,
} from './moaOrchestrator';

// ─────────────────────────────────────────────────────────────────────────
// #moa_orchestrate — start a new MoA loop
// ─────────────────────────────────────────────────────────────────────────

interface OrchestrateInput {
  task: string;
}

export class MoaOrchestrateTool implements vscode.LanguageModelTool<OrchestrateInput> {
  async prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<OrchestrateInput>,
    _token: vscode.CancellationToken
  ): Promise<vscode.PreparedToolInvocation> {
    const preview = options.input.task.length > 80
      ? options.input.task.substring(0, 77) + '...'
      : options.input.task;
    return {
      invocationMessage: `Starting MoA orchestration for: "${preview}"`,
      confirmationMessages: {
        title: 'Start MoA orchestration',
        message:
          `Start a new MoA iterative loop (refs + aggregator) for:\n\n"${preview}"\n\n` +
          `State will persist to .moa_cache/. You will need to drive iterations via #moa_continue.`,
      },
    };
  }

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<OrchestrateInput>,
    token: vscode.CancellationToken
  ): Promise<vscode.LanguageModelToolResult> {
    if (!options.input.task || options.input.task.trim().length === 0) {
      return errorResult('Input "task" is required.');
    }

    try {
      const state = await createOrchestration(options.input.task);

      // Immediately run the first iteration (no subagent_result yet —
      // workers analyze the bare task to surface initial gaps).
      // v0.15.0: 传入 toolInvocationToken，让内置 Recon/Actor 能调内置工具
      const updated = await runIteration(
        state.task_id, undefined, token,
        undefined,
        options.toolInvocationToken
      );

      const md = [
        formatStatusMarkdown(updated),
        '',
        '---',
        '',
        '**Next step:** ',
        updated.status === 'awaiting_recon'
          ? 'Call `#runSubagent` with the recon prompt above, then `#moa_continue` with the result.'
          : updated.status === 'finalized'
            ? 'Call `#moa_finalize` to produce action items.'
            : 'Call `#moa_continue` to advance the next iteration.',
      ].join('\n');

      return okResult(md);
    } catch (err) {
      return errorResult(`Failed to start orchestration: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────
// #moa_continue — advance one iteration
// ─────────────────────────────────────────────────────────────────────────

interface ContinueInput {
  task_id: string;
  subagent_result?: {
    content: string;
    source?: string;
  };
}

export class MoaContinueTool implements vscode.LanguageModelTool<ContinueInput> {
  async prepareInvocation(
    options: vscode.LanguageModelToolInvocationOptions<ContinueInput>,
    _token: vscode.CancellationToken
  ): Promise<vscode.PreparedToolInvocation> {
    const tid = options.input.task_id;
    const hasResult = !!options.input.subagent_result;
    return {
      invocationMessage: `MoA continue ${tid}${hasResult ? ' (with subagent result)' : ' (next iteration)'}`,
      confirmationMessages: {
        title: 'Advance MoA iteration',
        message: `Run next MoA iteration for task ${tid}${hasResult ? ' with provided subagent result' : ''}?`,
      },
    };
  }

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<ContinueInput>,
    token: vscode.CancellationToken
  ): Promise<vscode.LanguageModelToolResult> {
    const { task_id, subagent_result } = options.input;
    if (!task_id) return errorResult('Input "task_id" is required.');

    const existing = await loadState(task_id);
    if (!existing) return errorResult(`Task not found: ${task_id}`);
    if (existing.status === 'finalized') {
      return okResult(`Task ${task_id} already finalized. Call \`#moa_finalize\` to get action items.`);
    }
    if (existing.status === 'error') {
      return errorResult(`Task ${task_id} is in error state: ${existing.error ?? 'unknown'}`);
    }

    try {
      const result = subagent_result
        ? { content: subagent_result.content, source: subagent_result.source || '#runSubagent' }
        : undefined;

      const updated = await runIteration(task_id, result, token, (msg) => {
        // Progress is best-effort — no telemetry hook here.
        void msg;
      }, options.toolInvocationToken);

      const md = [
        formatStatusMarkdown(updated),
        '',
        '---',
        '',
        '**Next step:** ',
        updated.status === 'awaiting_recon'
          ? 'Call `#runSubagent` with the recon prompt above, then `#moa_continue` with the result.'
          : updated.status === 'finalized'
            ? 'Call `#moa_finalize` to produce action items.'
            : 'Call `#moa_continue` to advance the next iteration.',
      ].join('\n');

      return okResult(md);
    } catch (err) {
      return errorResult(`Iteration failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────
// #moa_finalize — produce action items
// ─────────────────────────────────────────────────────────────────────────

interface FinalizeInput {
  task_id: string;
}

export class MoaFinalizeTool implements vscode.LanguageModelTool<FinalizeInput> {
  async prepareInvocation(
    options: vscode.LanguageModelToolInvocationOptions<FinalizeInput>,
    _token: vscode.CancellationToken
  ): Promise<vscode.PreparedToolInvocation> {
    return {
      invocationMessage: `MoA finalize ${options.input.task_id}`,
      confirmationMessages: {
        title: 'Finalize MoA task',
        message: `Produce action items for MoA task ${options.input.task_id}?`,
      },
    };
  }

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<FinalizeInput>,
    token: vscode.CancellationToken
  ): Promise<vscode.LanguageModelToolResult> {
    const { task_id } = options.input;
    if (!task_id) return errorResult('Input "task_id" is required.');

    const existing = await loadState(task_id);
    if (!existing) return errorResult(`Task not found: ${task_id}`);

    try {
      const output: MoaFinalOutput = await finalizeTask(task_id, token);

      const md = formatFinalMarkdown(output);
      return okResult(md);
    } catch (err) {
      return errorResult(`Finalize failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Output formatting helpers
// ─────────────────────────────────────────────────────────────────────────

function formatFinalMarkdown(o: MoaFinalOutput): string {
  const lines: string[] = [
    `### MoA Final Output — \`${o.task_id}\``,
    '',
    `**Confidence:** ${(o.confidence * 100).toFixed(0)}%  `,
    `**Iterations used:** ${o.iterations_used}`,
    '',
    '#### Summary',
    '',
    o.summary,
    '',
  ];

  if (o.action_items.length > 0) {
    lines.push('#### Action items');
    lines.push('');
    for (let i = 0; i < o.action_items.length; i++) {
      const a = o.action_items[i];
      lines.push(`**${i + 1}. [${a.type}]** ${a.target}`);
      lines.push(`   - ${a.rationale}`);
      if (a.content && a.content.length > 0) {
        lines.push('   ```');
        for (const ln of a.content.split('\n').slice(0, 30)) {
          lines.push('   ' + ln);
        }
        const total = a.content.split('\n').length;
        if (total > 30) lines.push(`   ... (${total - 30} more lines)`);
        lines.push('   ```');
      }
      lines.push('');
    }
  }

  if (o.unresolved.length > 0) {
    lines.push('#### Unresolved questions for user');
    lines.push('');
    for (const u of o.unresolved) lines.push(`- ${u}`);
    lines.push('');
  }

  lines.push('---');
  lines.push('');
  lines.push('Main session: execute action_items as needed (write_file / execute / etc.).');

  return lines.join('\n');
}

function okResult(markdown: string): vscode.LanguageModelToolResult {
  return new vscode.LanguageModelToolResult([
    new vscode.LanguageModelTextPart(markdown),
  ]);
}

function errorResult(message: string): vscode.LanguageModelToolResult {
  return new vscode.LanguageModelToolResult([
    new vscode.LanguageModelTextPart(`**MoA error:** ${message}`),
  ]);
}

// ─────────────────────────────────────────────────────────────────────────
// #moa_execute — execute finalized action_items via Actor (v0.20.0)
// ─────────────────────────────────────────────────────────────────────────

interface ExecuteInput {
  task_id: string;
}

export class MoaExecuteTool implements vscode.LanguageModelTool<ExecuteInput> {
  async prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<ExecuteInput>,
    _token: vscode.CancellationToken
  ): Promise<vscode.PreparedToolInvocation> {
    return {
      invocationMessage: `MoA execute ${options.input.task_id}`,
      confirmationMessages: {
        title: 'Execute MoA action items',
        message:
          `Run Actor on the finalized action_items of task ${options.input.task_id}?\n\n` +
          `Effect: write_file / execute / create_roadmap items will be executed. ` +
          `Backups will be created for any modified files.`,
      },
    };
  }

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<ExecuteInput>,
    token: vscode.CancellationToken
  ): Promise<vscode.LanguageModelToolResult> {
    const { task_id } = options.input;
    if (!task_id) return errorResult('Input "task_id" is required.');

    // 读 state 拿 task 文本（executeFinalActions 需要）
    const state = await loadState(task_id);
    if (!state) return errorResult(`Task not found: ${task_id}`);

    // 读 final.json 拿 action_items
    const moaDir = path.join(
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '',
      '.moa_cache',
      task_id
    );
    let actionItems: MoaFinalOutput['action_items'] = [];
    try {
      const raw = await fsPromises.readFile(path.join(moaDir, 'final.json'), 'utf8');
      const parsed = JSON.parse(raw) as MoaFinalOutput;
      actionItems = parsed.action_items ?? [];
    } catch {
      return errorResult(`Cannot read final.json for task ${task_id}. Run #moa_finalize first.`);
    }

    if (actionItems.length === 0) {
      return okResult('No action_items in final.json (nothing to execute).');
    }

    try {
      const result = await executeFinalActions(
        task_id,
        actionItems,
        state.task,
        token,
        {
          toolInvocationToken: options.toolInvocationToken,
          progress: (msg) => console.log(`[MoA Execute] ${msg}`),
        }
      );

      // 渲染执行摘要 markdown
      const lines: string[] = [
        `### MoA Execute Result — \`${task_id}\``,
        '',
        `**Elapsed:** ${result.elapsed_sec.toFixed(1)}s  `,
        `**Tool calls:** ${result.tool_calls}  `,
        `**Self-assessment:** ${result.self_assessment.reason}`,
        '',
        '#### Executed actions',
        '',
      ];
      if (result.executed_actions.length === 0) {
        lines.push('_(none)_');
      } else {
        for (let i = 0; i < result.executed_actions.length; i++) {
          const a = result.executed_actions[i];
          const icon = a.status === 'success' ? '✅'
                    : a.status === 'rejected_by_user' ? '🚫'
                    : a.status === 'partial' ? '⚠️'
                    : '❌';
          lines.push(`${icon} **${i + 1}. [${a.action.type}]** ${a.action.target} — \`${a.status}\``);
          if (a.error_message) lines.push(`   - ${a.error_message.substring(0, 200)}`);
          if (a.artifacts.length > 0) lines.push(`   - Artifacts: \`${a.artifacts.join('\`, \`')}\``);
        }
      }
      lines.push('');
      lines.push(`Full log: <taskDir>/autopilot.log`);
      return okResult(lines.join('\n'));
    } catch (err) {
      return errorResult(`Execute failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Registration
// ─────────────────────────────────────────────────────────────────────────

export function registerMoaOrchestrateTools(context: vscode.ExtensionContext): void {
  const tools = [
    { name: 'moa_orchestrate', instance: new MoaOrchestrateTool() },
    { name: 'moa_continue', instance: new MoaContinueTool() },
    { name: 'moa_finalize', instance: new MoaFinalizeTool() },
    { name: 'moa_execute', instance: new MoaExecuteTool() },   // v0.20.0
  ];

  for (const t of tools) {
    const disposable = vscode.lm.registerTool(
      t.name,
      t.instance as vscode.LanguageModelTool<unknown>
    );
    context.subscriptions.push(disposable);
    console.log(`[moa-bridge] tool registered: ${t.name}`);
  }
}
