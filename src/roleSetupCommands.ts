/**
 * v0.22.0 P0-7 + P0-8: Role Setup 命令注册 + Plan Mode 报告命令
 *
 * 注册到 extension.ts 的 6 + 1 个 Role Setup 命令 + 1 个 togglePlanModeReport：
 *   - moa.createRolePreset
 *   - moa.switchRolePreset
 *   - moa.editRolePreset
 *   - moa.deleteRolePreset
 *   - moa.exportRolePreset
 *   - moa.importRolePreset
 *   - moa.toggleAIGeneration
 *   - moa.togglePlanModeReport
 *
 * 设计决策（用户原话 v3 修订）：
 *   - "8+2 个 VSCode 命令：create/switch/edit/delete/export/import/
 *     toggleAIGeneration/togglePlanModeReport + diagnoseEnvironment +
 *     toggleFinalMdInlineDisplay"
 *   - "默认 preset 只有 1 个，用户自行修改"
 *   - "JSON schema 校验失败时显示具体错误 + 保留编辑不强制保存"
 */

import * as vscode from 'vscode';
import {
  createPreset,
  switchPreset,
  deletePreset,
  exportPreset,
  importPreset,
  openPresetForEdit,
  listPresets,
  createDefaultPreset,
  type RoleSetupPreset,
} from './roleSetupPreset';
import { getAIGenerationConfig } from './roleSetupPreset';
import {
  showPlanModeReport,
  togglePlanModeReport as togglePlanModeReportSetting,
} from './planModeReport';

/**
 * 注册所有 v0.22 P0-7 + P0-8 命令到 ExtensionContext。
 */
export function registerRoleSetupCommands(context: vscode.ExtensionContext): void {
  // ── P0-7: Role Setup 命令 ──

  // 1. createRolePreset
  context.subscriptions.push(
    vscode.commands.registerCommand('moa.createRolePreset', async () => {
      const name = await vscode.window.showInputBox({
        prompt: '新 Role Preset 的名称',
        placeHolder: 'e.g. research-strict / coding-fast / code-review',
        validateInput: (v) => (v.trim() ? null : '名称不能为空'),
      });
      if (!name) return;
      const trimmed = name.trim();
      const existing = listPresets().find((p) => p.name === trimmed);
      if (existing) {
        vscode.window.showErrorMessage(`Preset "${trimmed}" 已存在。请用 moa.editRolePreset 编辑。`);
        return;
      }
      // 基于 default 创建副本（用户再修改）
      const defaultP = createDefaultPreset();
      const newPreset: RoleSetupPreset = {
        ...defaultP,
        name: trimmed,
        description: `用户创建于 ${new Date().toLocaleString()}`,
        meta: { ...defaultP.meta, created_at: new Date().toISOString() },
      };
      const res = createPreset(newPreset);
      if (!res.ok) {
        vscode.window.showErrorMessage(`创建失败：${res.error}`);
        return;
      }
      vscode.window.showInformationMessage(`已创建 preset "${trimmed}"。打开编辑器修改…`);
      await openPresetForEdit(trimmed);
    })
  );

  // 2. switchRolePreset
  context.subscriptions.push(
    vscode.commands.registerCommand('moa.switchRolePreset', async () => {
      const presets = listPresets();
      if (presets.length === 0) {
        vscode.window.showInformationMessage('无 Role Preset。请先 moa.createRolePreset。');
        return;
      }
      const picked = await vscode.window.showQuickPick(
        presets.map((p) => ({
          label: p.isActive ? `$(check) ${p.name}` : p.name,
          description: p.description,
          detail: p.isActive ? '当前激活' : undefined,
          name: p.name,
        })),
        { title: '切换 Role Preset' }
      );
      if (!picked) return;
      const res = await switchPreset(picked.name);
      if (!res.ok) {
        vscode.window.showErrorMessage(`切换失败：${res.error}`);
      } else {
        vscode.window.showInformationMessage(`已切换到 preset "${picked.name}"`);
      }
    })
  );

  // 3. editRolePreset
  context.subscriptions.push(
    vscode.commands.registerCommand('moa.editRolePreset', async () => {
      const presets = listPresets();
      if (presets.length === 0) {
        vscode.window.showInformationMessage('无 Role Preset。请先 moa.createRolePreset。');
        return;
      }
      const picked = await vscode.window.showQuickPick(
        presets.map((p) => ({ label: p.name, description: p.description, name: p.name })),
        { title: '选择要编辑的 Role Preset' }
      );
      if (!picked) return;
      const res = await openPresetForEdit(picked.name);
      if (!res.opened) {
        vscode.window.showErrorMessage(`打开失败：${res.error}`);
      }
    })
  );

  // 4. deleteRolePreset
  context.subscriptions.push(
    vscode.commands.registerCommand('moa.deleteRolePreset', async () => {
      const presets = listPresets().filter((p) => p.name !== 'default');
      if (presets.length === 0) {
        vscode.window.showInformationMessage('没有可删除的 preset（default 不可删除）。');
        return;
      }
      const picked = await vscode.window.showQuickPick(
        presets.map((p) => ({ label: p.name, description: p.description, name: p.name })),
        { title: '选择要删除的 Role Preset（不可恢复！）' }
      );
      if (!picked) return;
      const confirm = await vscode.window.showWarningMessage(
        `确认删除 preset "${picked.name}"？此操作不可恢复。`,
        { modal: true },
        '删除'
      );
      if (confirm !== '删除') return;
      const res = deletePreset(picked.name);
      if (!res.ok) {
        vscode.window.showErrorMessage(`删除失败：${res.error}`);
      } else {
        vscode.window.showInformationMessage(`已删除 preset "${picked.name}"`);
      }
    })
  );

  // 5. exportRolePreset
  context.subscriptions.push(
    vscode.commands.registerCommand('moa.exportRolePreset', async () => {
      const presets = listPresets();
      const picked = await vscode.window.showQuickPick(
        [
          { label: '导出全部 presets', description: `共 ${presets.length} 个`, name: '' },
          ...presets.map((p) => ({
            label: p.name,
            description: p.description,
            name: p.name,
          })),
        ],
        { title: '选择要导出的 Role Preset' }
      );
      if (!picked) return;
      const targetUri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(
          picked.name
            ? `${picked.name}-role-preset.json`
            : 'role-setup-presets.json'
        ),
        filters: { JSON: ['json'] },
      });
      if (!targetUri) return;
      const res = await exportPreset(picked.name || null, targetUri);
      if (!res.ok) {
        vscode.window.showErrorMessage(`导出失败：${res.error}`);
      } else {
        vscode.window.showInformationMessage(
          `已导出 ${res.count} 个 preset 到 ${targetUri.fsPath}`
        );
      }
    })
  );

  // 6. importRolePreset
  context.subscriptions.push(
    vscode.commands.registerCommand('moa.importRolePreset', async () => {
      const sourceUri = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        filters: { JSON: ['json'] },
        title: '选择要导入的 Role Preset JSON 文件',
      });
      if (!sourceUri || sourceUri.length === 0) return;
      const res = await importPreset(sourceUri[0]);
      if (!res.ok) {
        vscode.window.showErrorMessage(`导入失败：${res.error}`);
        return;
      }
      const importedCount = res.imported?.length ?? 0;
      const skippedCount = res.skipped?.length ?? 0;
      const lines: string[] = [];
      if (importedCount > 0) lines.push(`已导入 ${importedCount} 个：${res.imported!.join(', ')}`);
      if (skippedCount > 0) lines.push(`跳过 ${skippedCount} 个：${res.skipped!.join(', ')}`);
      vscode.window.showInformationMessage(
        lines.length > 0 ? lines.join('\n') : '无变化'
      );
    })
  );

  // 7. toggleAIGeneration
  context.subscriptions.push(
    vscode.commands.registerCommand('moa.toggleAIGeneration', async () => {
      const cur = getAIGenerationConfig();
      const choice = await vscode.window.showQuickPick(
        [
          {
            label: cur.enabled ? '$(check) AI 生成启用（点击关闭）' : 'AI 生成已关闭（点击启用）',
            description: cur.enabled ? '当前：enabled' : '当前：disabled',
            key: 'enabled',
          },
          {
            label: cur.autoAccept ? '$(check) 自动接受 AI 输出（点击关闭）' : '手动确认 AI 输出（点击启用）',
            description: cur.autoAccept ? '⚠️ 危险：跳过 plan-mode 确认' : '当前：手动',
            key: 'autoAccept',
          },
          {
            label: `确认 UI：${cur.confirmationUI}`,
            description: 'plan-mode / inline-preview / none',
            key: 'confirmationUI',
          },
        ],
        { title: 'MoA AI 生成开关' }
      );
      if (!choice) return;
      const cfg = vscode.workspace.getConfiguration('moa');
      if (choice.key === 'enabled') {
        await cfg.update('roleSetup.aiGeneration.enabled', !cur.enabled, vscode.ConfigurationTarget.Global);
      } else if (choice.key === 'autoAccept') {
        await cfg.update('roleSetup.aiGeneration.autoAccept', !cur.autoAccept, vscode.ConfigurationTarget.Global);
      } else if (choice.key === 'confirmationUI') {
        const opts: Array<'plan-mode' | 'inline-preview' | 'none'> = ['plan-mode', 'inline-preview', 'none'];
        const idx = opts.indexOf(cur.confirmationUI);
        const next = opts[(idx + 1) % opts.length];
        await cfg.update('roleSetup.aiGeneration.confirmationUI', next, vscode.ConfigurationTarget.Global);
      }
      const updated = getAIGenerationConfig();
      vscode.window.showInformationMessage(
        `AI 生成开关：enabled=${updated.enabled}, autoAccept=${updated.autoAccept}, confirmationUI=${updated.confirmationUI}`
      );
    })
  );

  // ── P0-8: Plan Mode 报告 ──

  context.subscriptions.push(
    vscode.commands.registerCommand('moa.togglePlanModeReport', async () => {
      const newVal = await togglePlanModeReportSetting();
      vscode.window.showInformationMessage(`Plan Mode 报告：${newVal ? '启用' : '关闭'}`);
    })
  );

  // 显示当前 Plan Mode 报告（从上次任务读取）
  context.subscriptions.push(
    vscode.commands.registerCommand('moa.showPlanModeReport', async () => {
      await showPlanModeReport();
    })
  );

  // ── P0-10: final.md 分级展示 toggle ──

  context.subscriptions.push(
    vscode.commands.registerCommand('moa.toggleFinalMdInlineDisplay', async () => {
      const cfg = vscode.workspace.getConfiguration('moa');
      const cur = cfg.get<string>('finalMdInlineDisplay') ?? 'structured-summary';
      const opts: Array<{ label: string; value: string; description: string }> = [
        { label: 'Structured Summary', value: 'structured-summary', description: 'TL;DR + 关键发现 top 5 + action_items 表（默认）' },
        { label: 'Summary', value: 'summary', description: '2000-8000 字符：摘要 + 关键信息' },
        { label: 'Full', value: 'full', description: '<2000 字符：完整内嵌' },
        { label: 'Off', value: 'off', description: '不内嵌（仅落盘路径提示）' },
      ];
      const idx = opts.findIndex((o) => o.value === cur);
      const next = opts[(idx + 1) % opts.length];
      await cfg.update('finalMdInlineDisplay', next.value, vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage(`final.md 内嵌展示模式：${next.label}`);
    })
  );
}
