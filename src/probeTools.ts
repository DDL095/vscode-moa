// 临时探针：列出 vscode.lm.tools 的实际内容
// 通过 @moa /help 不会触发，需要单独触发
import * as vscode from 'vscode';

export async function probeTools(): Promise<void> {
  try {
    const channel = vscode.window.createOutputChannel('MoA Tool Probe');
    channel.clear();

    // v0.12.0 diagnostic: report extension activation state
    const ext = vscode.extensions.getExtension('moa-bridge.moa-bridge');
    channel.appendLine(`=== vscode.lm.tools probe @ ${new Date().toISOString()} ===`);
    channel.appendLine(`Extension moa-bridge.moa-bridge:`);
    channel.appendLine(`  active: ${ext?.isActive}`);
    channel.appendLine(`  activationReason: ${(ext as any)?.activationReason ?? '(n/a)'}`);
    channel.appendLine(`  version: ${ext?.packageJSON?.version}`);
    channel.appendLine('');

    // Report what vscode.lm exposes
    channel.appendLine(`vscode.lm API keys: ${Object.keys(vscode.lm).join(', ')}`);
    channel.appendLine(`vscode.lm.registerTool typeof: ${typeof (vscode.lm as any).registerTool}`);
    channel.appendLine(`vscode.lm.registerLanguageModelTool typeof: ${typeof (vscode.lm as any).registerLanguageModelTool}`);
    channel.appendLine('');

    // vscode.lm.tools is stable API (1.90+)
    const tools = vscode.lm.tools;
    channel.appendLine(`Total tools: ${tools.length}`);
    channel.appendLine('');

    // v0.12.0 hotfix: specifically check for runSubagent (VSCode native subagent tool)
    const runSubagent = tools.find((t) => t.name === 'runSubagent' || t.name === 'agent/runSubagent' || t.name.includes('runSubagent'));
    if (runSubagent) {
      channel.appendLine(`[runSubagent check] ✅ FOUND: name="${runSubagent.name}", tags=[${runSubagent.tags?.join(', ') || ''}]`);
      channel.appendLine(`    description: ${runSubagent.description?.substring(0, 300) || '(none)'}`);
    } else {
      channel.appendLine(`[runSubagent check] ❌ NOT FOUND`);
      channel.appendLine(`    This means github.copilot-chat is not installed/enabled.`);
      channel.appendLine(`    Our moa_recon / moa_analyze tools are the workaround.`);
    }
    channel.appendLine('');

    // v0.12.0 diagnostic: specifically check for our own tools
    const ourTools = tools.filter((t) => t.name.startsWith('moa_'));
    channel.appendLine(`[MoA own tools check] found ${ourTools.length} moa_* tool(s) in vscode.lm.tools:`);
    for (const t of ourTools) {
      channel.appendLine(`  ✅ ${t.name} (tags: ${t.tags?.join(', ') || 'none'})`);
    }
    if (ourTools.length === 0) {
      channel.appendLine(`  ❌ NONE FOUND — extension activation likely failed or registerTool silent fail.`);
      channel.appendLine(`     Check "MoA Bridge Diag" output channel for activation errors.`);
    }
    channel.appendLine('');

    tools.forEach((t, i) => {
      channel.appendLine(`[${i + 1}] name: ${t.name}`);
      channel.appendLine(`    tags: ${t.tags?.join(', ') || '(none)'}`);
      channel.appendLine(`    description: ${(t.description ?? '').substring(0, 200) || '(none)'}`);
      channel.appendLine('');
    });
    channel.show(true);

    // Also pop a quick pick so the user can see the result without scrolling
    const toolNames = tools.map((t) => t.name).join('\n');
    await vscode.window.showInformationMessage(
      `MoA probe: ${tools.length} tools. ${runSubagent ? 'runSubagent ✅' : 'no runSubagent ❌'}. ${ourTools.length} moa_* tools.`,
      'Show Output',
      'Copy Names'
    ).then(async (sel) => {
      if (sel === 'Copy Names') {
        await vscode.env.clipboard.writeText(toolNames);
      }
    });
  } catch (err) {
    vscode.window.showErrorMessage(`MoA probe failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
