/**
 * Workspace context builder for reference advisors (v0.8.0 Step 1).
 *
 * Hermes' `_reference_messages()` serializes the conversation state (including
 * tool calls + results) and feeds it to reference advisors. We can't access
 * the Copilot Chat conversation state from a third-party participant, but we
 * CAN read the workspace state via stable VSCode APIs:
 *
 *   - Active text editor (file path, visible range, selection)
 *   - Open documents (recent files the user is working on)
 *   - Workspace folder structure (lightweight, just top-level)
 *
 * This is not as rich as Hermes' tool-call history, but it gives refs the
 * context they need to give grounded advice ("I see you have src/moaRunner.ts
 * open at the sendRequest call — here's what I'd consider...").
 */

import * as vscode from 'vscode';
import * as path from 'path';

/** Cap each file's preview to keep the ref prompt bounded. */
const SELECTION_MAX_CHARS = 4000;
const VISIBLE_RANGE_MAX_CHARS = 2000;
const OPEN_DOCS_MAX = 8;

/**
 * v0.9.0 hotfix1: Project tree depth / breadth lifted from
 * (depth=2, maxEntries=50, slice=15) to (depth=6, maxEntries=2000, slice=50).
 * Required so refs see the full project structure — without it they can't
 * even name the files they want recon to collect on the next round.
 */
const WORKSPACE_TREE_MAX_DEPTH = 6;
const WORKSPACE_TREE_MAX_ENTRIES = 2000;

/** Skip files larger than this in the tree (don't list them as candidates). */
const TREE_FILE_MAX_BYTES = 1024 * 1024;  // 1MB

export interface WorkspaceContext {
  activeFile?: {
    path: string;
    relativePath?: string;
    languageId: string;
    visibleRange?: string;       // First N lines of visible range
    selection?: string;           // Selected text (if any)
  };
  openDocuments: Array<{
    relativePath: string;
    languageId: string;
    isActive: boolean;
  }>;
  workspaceFolders: string[];
  /** Top-level project tree (depth-limited). */
  projectTree?: string;
}

/**
 * Build the workspace context snapshot to inject into ref prompts.
 *
 * Best-effort: silently skips parts that can't be read (e.g. no open editor,
 * large file, untitled document). Never throws.
 */
export async function buildWorkspaceContext(): Promise<WorkspaceContext> {
  const ctx: WorkspaceContext = {
    openDocuments: [],
    workspaceFolders: [],
  };

  // ---------- Active editor ----------
  const editor = vscode.window.activeTextEditor;
  if (editor && editor.document.uri.scheme === 'file') {
    const doc = editor.document;
    const relativePath = toRelativePath(doc.uri.fsPath);

    // Visible range preview (capped)
    const visibleRange = editor.visibleRanges[0];
    let visibleText: string | undefined;
    if (visibleRange) {
      visibleText = doc.getText(visibleRange);
      if (visibleText.length > VISIBLE_RANGE_MAX_CHARS) {
        visibleText = visibleText.substring(0, VISIBLE_RANGE_MAX_CHARS) + '\n... (truncated)';
      }
    }

    // Selection (capped)
    let selectionText: string | undefined;
    if (!editor.selection.isEmpty) {
      selectionText = doc.getText(editor.selection);
      if (selectionText.length > SELECTION_MAX_CHARS) {
        selectionText = selectionText.substring(0, SELECTION_MAX_CHARS) + '\n... (truncated)';
      }
    }

    ctx.activeFile = {
      path: doc.uri.fsPath,
      relativePath,
      languageId: doc.languageId,
      visibleRange: visibleText,
      selection: selectionText,
    };
  }

  // ---------- Open documents ----------
  for (const doc of vscode.workspace.textDocuments) {
    if (doc.uri.scheme !== 'file') continue;
    const relativePath = toRelativePath(doc.uri.fsPath);
    if (!relativePath) continue;
    ctx.openDocuments.push({
      relativePath,
      languageId: doc.languageId,
      isActive: editor?.document === doc,
    });
    if (ctx.openDocuments.length >= OPEN_DOCS_MAX) break;
  }

  // ---------- Workspace folders ----------
  if (vscode.workspace.workspaceFolders) {
    ctx.workspaceFolders = vscode.workspace.workspaceFolders.map((f) => f.uri.fsPath);
  }

  // ---------- Project tree (lightweight) ----------
  if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
    try {
      ctx.projectTree = await buildProjectTree(vscode.workspace.workspaceFolders[0].uri.fsPath);
    } catch {
      // Silent skip — tree is best-effort
    }
  }

  return ctx;
}

/**
 * Render the WorkspaceContext as a Markdown/text block suitable for injection
 * into a ref prompt.
 */
export function renderWorkspaceContext(ctx: WorkspaceContext): string {
  const parts: string[] = [];

  parts.push('=== WORKSPACE CONTEXT ===');

  if (ctx.activeFile) {
    parts.push(`Active file: ${ctx.activeFile.relativePath || ctx.activeFile.path} (${ctx.activeFile.languageId})`);
    if (ctx.activeFile.selection) {
      parts.push('Selected code:');
      parts.push('```');
      parts.push(ctx.activeFile.selection);
      parts.push('```');
    } else if (ctx.activeFile.visibleRange) {
      parts.push('Visible range (preview):');
      parts.push('```');
      parts.push(ctx.activeFile.visibleRange);
      parts.push('```');
    }
  } else {
    parts.push('Active file: (none — no editor open or untitled)');
  }

  if (ctx.openDocuments.length > 0) {
    parts.push('');
    parts.push(`Open documents (${ctx.openDocuments.length}):`);
    for (const d of ctx.openDocuments) {
      const marker = d.isActive ? ' [active]' : '';
      parts.push(`  - ${d.relativePath} (${d.languageId})${marker}`);
    }
  }

  if (ctx.workspaceFolders.length > 0) {
    parts.push('');
    parts.push(`Workspace folders: ${ctx.workspaceFolders.length}`);
    for (const f of ctx.workspaceFolders) {
      parts.push(`  - ${path.basename(f)}/`);
    }
  }

  if (ctx.projectTree) {
    parts.push('');
    parts.push('Project structure (depth-limited):');
    parts.push('```');
    parts.push(ctx.projectTree);
    parts.push('```');
  }

  parts.push('=== END WORKSPACE CONTEXT ===');

  return parts.join('\n');
}

/** Convert absolute path to workspace-relative if possible. */
function toRelativePath(fsPath: string): string | undefined {
  const wsFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(fsPath));
  if (!wsFolder) return undefined;
  const relative = path.relative(wsFolder.uri.fsPath, fsPath);
  return relative || path.basename(fsPath);
}

/**
 * Build a depth-limited tree of the project.
 *
 * v0.9.0 hotfix1: depth=6, maxEntries=2000, slice=50 (was 2/50/15).
 * Each file entry shows its size in KB so refs can prioritize small,
 * high-signal files when their missing hints list candidates.
 *
 * Heuristic: skip binary/oversized files (>1MB) in the tree listing —
 * refs don't need to know they exist as candidates for line-range reads.
 */
async function buildProjectTree(rootPath: string): Promise<string | undefined> {
  // Use a quick file-system walk with caps. Sync via fs.promises.
  const fs = await import('fs/promises');
  const lines: string[] = [];
  let entryCount = 0;

  async function walk(dir: string, depth: number, prefix: string): Promise<void> {
    if (depth > WORKSPACE_TREE_MAX_DEPTH) return;
    if (entryCount >= WORKSPACE_TREE_MAX_ENTRIES) return;

    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      return;
    }

    // Filter out noise (node_modules, .git, dist, build, etc.).
    const filtered = entries.filter((e) =>
      !['node_modules', '.git', 'dist', '.vscode-test', 'out', 'build', 'coverage'].includes(e)
      && !e.startsWith('.')
    );

    for (const entry of filtered.slice(0, 50)) {
      if (entryCount >= WORKSPACE_TREE_MAX_ENTRIES) return;
      entryCount++;
      const fullPath = path.join(dir, entry);
      let isDir = false;
      let sizeKb: number | undefined;
      try {
        const stat = await fs.stat(fullPath);
        isDir = stat.isDirectory();
        if (!isDir) {
          sizeKb = Math.round(stat.size / 1024);
          // Skip oversized files from listing entirely.
          if (stat.size > TREE_FILE_MAX_BYTES) continue;
        }
      } catch {
        continue;
      }
      const sizeNote = (sizeKb !== undefined && sizeKb > 0) ? `  (${sizeKb} KB)` : '';
      lines.push(`${prefix}${entry}${isDir ? '/' : ''}${sizeNote}`);
      if (isDir && depth < WORKSPACE_TREE_MAX_DEPTH) {
        await walk(fullPath, depth + 1, prefix + '  ');
      }
    }
  }

  await walk(rootPath, 0, '');
  return lines.length > 0 ? lines.join('\n') : undefined;
}
