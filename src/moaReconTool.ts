/**
 * MoA Recon Tool (v0.11.0) — Hermes-style recon subagent.
 *
 * Registers a `vscode.lm` tool called `moa_recon` so any LLM (including the
 * main Copilot Chat session) can delegate a recon task and receive structured
 * file contents back as a tool result.
 *
 * Why this exists (subagent split):
 *   - v0.9.0-v0.10.1: recon was Phase 0 INSIDE moa_analyze (run by our small
 *     model). Refs had to trust whatever recon found.
 *   - v0.10.2: added reconContext parameter — main LLM could pre-gather files
 *     via copilot_readFile and pass them in.
 *   - v0.11.0: this file — recon becomes a standalone subagent tool that the
 *     main LLM can call BEFORE moa_analyze. The main LLM gets back structured
 *     file contents and decides whether to feed them to moa_analyze or not.
 *
 * Hermes alignment:
 *   - In Hermes, recon is the "first loop" of the acting agent. We split it
 *     out as a separate tool so the orchestrator (main LLM) has explicit
 *     control over WHAT to gather, and the multi-model MoA only sees curated
 *     recon output.
 *
 * Tool input schema:
 *   {
 *     "prompt": string,                  // The task description (required)
 *     "scopeHint"?: string,              // Optional: what files/symbols to look at
 *     "includeWorkspaceTree"?: boolean,  // Include project tree (default true)
 *     "maxFiles"?: number                // Cap on files to read (default 8)
 *   }
 *
 * Tool result:
 *   {
 *     "files": Array<{path: string, content: string}>,
 *     "errors": string[],
 *     "summary": string
 *   }
 *   — encoded as a Markdown text block the calling LLM can parse / feed forward.
 */

import * as vscode from 'vscode';
import { buildWorkspaceContext, renderWorkspaceContext } from './workspaceContext';

interface ReconToolInput {
  prompt: string;
  scopeHint?: string;
  includeWorkspaceTree?: boolean;
  maxFiles?: number;
}

interface ReconFile {
  path: string;
  content: string;
}

export class MoaReconTool implements vscode.LanguageModelTool<ReconToolInput> {
  async prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<ReconToolInput>,
    _token: vscode.CancellationToken
  ): Promise<vscode.PreparedToolInvocation> {
    const promptPreview = options.input.prompt.length > 80
      ? options.input.prompt.substring(0, 77) + '...'
      : options.input.prompt;
    const parts: string[] = [
      `Running MoA recon subagent for: "${promptPreview}"`,
    ];
    if (options.input.scopeHint) parts.push(`(scope: ${options.input.scopeHint})`);
    if (options.input.maxFiles) parts.push(`(max ${options.input.maxFiles} files)`);
    return {
      invocationMessage: parts.join(' '),
      confirmationMessages: {
        title: 'MoA recon subagent',
        // TODO v0.13.0: switch message to MarkdownString once @types/vscode 1.128+ available
        message:
          `Run recon subagent to gather files relevant to: "${promptPreview}"?\n\n` +
          `Reads files only (no edits). May take 5-20 seconds.`,
      },
    };
  }

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<ReconToolInput>,
    token: vscode.CancellationToken
  ): Promise<vscode.LanguageModelToolResult> {
    const { prompt, scopeHint, includeWorkspaceTree, maxFiles } = options.input;
    const fileCap = Math.max(1, Math.min(20, maxFiles ?? 8));

    const files: ReconFile[] = [];
    const errors: string[] = [];

    // Step 1: Build workspace context (tree + active file).
    let wsContextText = '';
    if (includeWorkspaceTree !== false) {
      try {
        const ctx = await buildWorkspaceContext();
        wsContextText = renderWorkspaceContext(ctx);
      } catch (err) {
        errors.push(`buildWorkspaceContext failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Step 2: Determine candidate paths.
    // Strategy (v0.11.0 simple): use the active editor's file if any, plus
    // any files mentioned verbatim in scopeHint (e.g. "src/moaRunner.ts:120-200").
    // Future v0.11.1: invoke recon agent for fuzzy search via search_codebase.
    const candidatePaths: string[] = [];

    // From scopeHint — extract path:line-line patterns.
    // v0.19.1 §6: 扩展 regex 支持中文字符（\u4e00-\u9fa5）——Windows 中文路径
    // 如 "D:\BaiduYunDrive\OneDrive\实验相关文档\AI\src\foo.ts" 原本无法匹配。
    if (scopeHint) {
      const pathRegex = /([\w./\\\u4e00-\u9fa5-]+\.\w+)(?::(\d+)(?:-(\d+))?)?/g;
      let m: RegExpExecArray | null;
      while ((m = pathRegex.exec(scopeHint)) !== null) {
        candidatePaths.push(m[1]);
      }
    }

    // From active editor.
    if (candidatePaths.length === 0) {
      const editor = vscode.window.activeTextEditor;
      if (editor && editor.document.uri.scheme === 'file') {
        candidatePaths.push(editor.document.uri.fsPath);
      }
    }

    // Fallback: if still no paths, try the workspace folder's first .ts file.
    if (candidatePaths.length === 0 && vscode.workspace.workspaceFolders) {
      const root = vscode.workspace.workspaceFolders[0].uri.fsPath;
      // Use fs to find a small .ts file at the root or one level deep.
      try {
        const fs = await import('fs/promises');
        const path = await import('path');
        const candidates = await fs.readdir(root);
        for (const entry of candidates) {
          if (entry.endsWith('.ts') && !entry.startsWith('.')) {
            candidatePaths.push(path.join(root, entry));
            break;
          }
        }
      } catch {
        // ignore
      }
    }

    // Step 3: Read each candidate file (using fs directly — bypassing
    // copilot_readFile tool since this IS a tool itself).
    try {
      const fs = await import('fs/promises');
      const path = await import('path');
      for (const absPath of candidatePaths.slice(0, fileCap)) {
        if (token.isCancellationRequested) break;
        try {
          // Apply line-range if scopeHint had one.
          const rangeMatch = scopeHint?.match(
            new RegExp(`${path.basename(absPath).replace(/\./g, '\\.')}:(\\d+)(?:-(\\d+))?`)
          );
          const content = await fs.readFile(absPath, 'utf8');
          let trimmed = content;
          if (rangeMatch) {
            const start = parseInt(rangeMatch[1], 10);
            const end = rangeMatch[2] ? parseInt(rangeMatch[2], 10) : start + 200;
            const lines = content.split('\n');
            trimmed = lines.slice(Math.max(0, start - 1), Math.min(lines.length, end)).join('\n');
          }
          // Per-file cap (avoid blowing up reconContext).
          if (trimmed.length > 30000) {
            trimmed = trimmed.substring(0, 30000) + '\n... (truncated to 30000 chars)';
          }
          files.push({
            path: vscode.workspace.asRelativePath(absPath) || absPath,
            content: trimmed,
          });
        } catch (err) {
          errors.push(`${absPath}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } catch (err) {
      errors.push(`fs read failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Step 4: Format result as Markdown the calling LLM can parse.
    let resultMd = `# MoA Recon Result\n\n`;
    resultMd += `**Task**: ${prompt}\n\n`;
    if (scopeHint) resultMd += `**Scope**: ${scopeHint}\n\n`;
    resultMd += `**Files gathered**: ${files.length} / ${fileCap} cap\n\n`;

    if (wsContextText) {
      resultMd += `## Workspace Context\n\n${wsContextText}\n\n`;
    }

    if (files.length > 0) {
      resultMd += `## Files\n\n`;
      for (const f of files) {
        resultMd += `### ${f.path}\n\n\`\`\`\n${f.content}\n\`\`\`\n\n`;
      }
    }

    if (errors.length > 0) {
      resultMd += `## Errors\n\n${errors.map((e) => `- ${e}`).join('\n')}\n\n`;
    }

    resultMd += `---\n\n`;
    resultMd += `> **Next step**: Pass the contents above to \`moa_analyze\` via the ` +
      `\`reconContext\` parameter for multi-model analysis.\n`;

    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(resultMd),
    ]);
  }
}

/**
 * Register the moa_recon tool. Should be called from extension.activate.
 */
export function registerMoaReconTool(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.lm.registerTool('moa_recon', new MoaReconTool())
  );
  console.log('[moa-bridge] tool registered: moa_recon');
}