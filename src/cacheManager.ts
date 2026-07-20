/**
 * cacheManager.ts — v0.19.1 §4 缓存生命周期管理
 *
 * 职责：
 *   1. TTL 清理：扫描 .moa_cache/，按 mtime 删除超过 moa.cacheTtlDays 天的任务
 *   2. task_id 工作区隔离：基于 workspaceFolder.fsPath 的 sha1 前 6 位
 *   3. 手动清理命令：MoA: Cleanup Old Tasks (>N days)
 *
 * 设计哲学：
 *   - 默认 TTL=30 天（保守，不误删活跃任务）
 *   - 删除前在 OutputChannel 打 manifest（记录删除了什么、总大小、释放空间）
 *   - 多工作区场景：task_id 含 workspace hash 前缀，可按工作区批量清理
 *
 * v0.19.1 范围：
 *   ✅ TTL 清理命令（手动触发）
 *   ✅ task_id 工作区 hash（向后兼容旧 task_id）
 *   ✅ 按工作区清理命令
 *   ❌ 启动时自动清理（推到 v0.20.0，避免启动慢）
 *   ❌ 容量 LRU 淘汰（推到 v0.20.0）
 */

import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';  // for Dirent 类型
import * as path from 'path';
import * as crypto from 'crypto';

/**
 * 清理结果。
 */
export interface CleanupResult {
  /** 扫描的 task 数 */
  scanned: number;
  /** 删除的 task 数 */
  removed: number;
  /** 保留的 task 数 */
  kept: number;
  /** 删除的 task 名称列表 */
  removed_tasks: string[];
  /** 释放的总字节数 */
  bytes_freed: number;
  /** 错误信息（部分失败时） */
  errors: string[];
}

/**
 * 计算工作区指纹（6 位 sha1 hash）。
 *
 * 用于 task_id 前缀，让多工作区任务的缓存自然隔离。
 * 示例：
 *   workspacePath = "d:/BaiduYunDrive/.../vscode-moa"
 *   → hash = "a3f29b"
 *   → taskId = "moa_a3f29b_<base36_timestamp>_<random>"
 *
 * @param workspacePath workspace folder 的 fsPath
 * @returns 6 位 hex 字符串
 */
export function computeWorkspaceFingerprint(workspacePath: string): string {
  return crypto.createHash('sha1')
    .update(workspacePath)
    .digest('hex')
    .substring(0, 6);
}

/**
 * 获取 cache 根目录。
 *
 * 优先级：
 *   1. moa.cacheRootDir 配置（如设置）
 *   2. workspaceFolder/.moa_cache/（默认）
 *   3. globalStorageUri/.moa_cache/（无 workspace 时）
 */
export async function getCacheRoot(): Promise<string> {
  const config = vscode.workspace.getConfiguration('moa');
  const configured = config.get<string>('cacheRootDir');
  if (configured && configured.length > 0) {
    return configured;
  }

  // 默认：workspace folder 下
  const folders = vscode.workspace.workspaceFolders;
  if (folders && folders.length > 0) {
    return path.join(folders[0].uri.fsPath, '.moa_cache');
  }

  // 兜底：globalStorage
  const ext = vscode.extensions.getExtension('dudali095.moa-bridge');
  if (ext) {
    return path.join(ext.extensionUri.fsPath, '.moa_cache');
  }

  // 最终兜底
  return path.join(require('os').tmpdir(), 'moa_cache');
}

/**
 * 列出 cache 根目录下所有 task 目录（不含 _trash / manifest 等文件）。
 *
 * @param cacheRoot cache 根目录
 * @returns task 目录路径数组（绝对路径）
 */
export async function listTaskDirs(cacheRoot: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(cacheRoot);
  } catch {
    return [];  // 目录不存在
  }

  const taskDirs: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(cacheRoot, entry);
    try {
      const stat = await fs.stat(fullPath);
      if (stat.isDirectory() && entry.startsWith('moa_')) {
        taskDirs.push(fullPath);
      }
    } catch {
      // stat 失败（可能是权限/符号链接），跳过
    }
  }
  return taskDirs;
}

/**
 * 计算目录总大小（递归）。
 *
 * @param dirPath 目录路径
 * @returns 字节数
 */
export async function computeDirSize(dirPath: string): Promise<number> {
  let total = 0;
  let entries: fsSync.Dirent[];
  try {
    entries = await fs.readdir(dirPath, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    try {
      if (entry.isDirectory()) {
        total += await computeDirSize(fullPath);
      } else if (entry.isFile()) {
        const stat = await fs.stat(fullPath);
        total += stat.size;
      }
    } catch {
      // 跳过
    }
  }
  return total;
}

/**
 * 清理过期的 task 目录。
 *
 * @param options 清理选项
 * @returns CleanupResult
 */
export async function cleanupExpiredTasks(options?: {
  cacheRoot?: string;
  ttlDays?: number;
  dryRun?: boolean;
  workspaceFilter?: string;  // 只清这个工作区指纹的 task
}): Promise<CleanupResult> {
  const cacheRoot = options?.cacheRoot ?? await getCacheRoot();
  const ttlDays = options?.ttlDays
    ?? vscode.workspace.getConfiguration('moa').get<number>('cacheTtlDays', 30);
  const dryRun = options?.dryRun ?? false;

  const result: CleanupResult = {
    scanned: 0,
    removed: 0,
    kept: 0,
    removed_tasks: [],
    bytes_freed: 0,
    errors: [],
  };

  const taskDirs = await listTaskDirs(cacheRoot);
  result.scanned = taskDirs.length;

  const now = Date.now();
  const cutoffMs = now - ttlDays * 24 * 60 * 60 * 1000;

  for (const taskDir of taskDirs) {
    try {
      const taskName = path.basename(taskDir);

      // 工作区过滤
      if (options?.workspaceFilter) {
        // task_id 格式：moa_<workspaceHash>_<timestamp>_<random>
        // 或旧格式：moa_<timestamp>_<random>（无 workspaceHash）
        const match = taskName.match(/^moa_([a-f0-9]{6})_/);
        if (!match || match[1] !== options.workspaceFilter) {
          continue;  // 跳过其他工作区的 task
        }
      }

      // mtime 检查（用目录本身的 mtime，而不是内部文件）
      const stat = await fs.stat(taskDir);
      if (stat.mtimeMs < cutoffMs) {
        // 超过 TTL，准备删除
        const sizeBytes = await computeDirSize(taskDir);
        if (!dryRun) {
          await fs.rm(taskDir, { recursive: true, force: true });
        }
        result.removed += 1;
        result.removed_tasks.push(taskName);
        result.bytes_freed += sizeBytes;
      } else {
        result.kept += 1;
      }
    } catch (err) {
      result.errors.push(
        `${path.basename(taskDir)}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  return result;
}

/**
 * 注册 CacheManager 相关的命令。
 *
 * 命令列表：
 *   - moa.cleanupOldTasks: 清理超过 TTL 的任务（手动触发）
 *   - moa.cleanupCurrentWorkspace: 清理当前工作区的所有 MoA 任务
 *   - moa.cleanupAllTasks: 清理所有 MoA 任务（高危，需确认）
 *
 * @param context ExtensionContext
 */
export function registerCacheManagerCommands(context: vscode.ExtensionContext): void {
  // 命令 1：MoA: Cleanup Old Tasks (>N days)
  context.subscriptions.push(
    vscode.commands.registerCommand('moa.cleanupOldTasks', async () => {
      const ttlDays = vscode.workspace.getConfiguration('moa').get<number>('cacheTtlDays', 30);

      const confirm = await vscode.window.showWarningMessage(
        `MoA: 即将清理 ${ttlDays} 天前的 MoA 任务缓存。此操作不可撤销。是否继续？`,
        { modal: true },
        '确认清理',
      );
      if (confirm !== '确认清理') {
        return;
      }

      const result = await cleanupExpiredTasks({ ttlDays });
      const mbFreed = (result.bytes_freed / 1024 / 1024).toFixed(2);
      const msg = `MoA: 清理完成 — 扫描 ${result.scanned}，删除 ${result.removed}，保留 ${result.kept}，释放 ${mbFreed} MB`;
      vscode.window.showInformationMessage(msg);
    }),
  );

  // 命令 2：MoA: Cleanup Current Workspace Tasks
  context.subscriptions.push(
    vscode.commands.registerCommand('moa.cleanupCurrentWorkspace', async () => {
      const folder = vscode.workspace.workspaceFolders?.[0];
      if (!folder) {
        vscode.window.showWarningMessage('MoA: 无活动工作区，无法清理');
        return;
      }
      const fingerprint = computeWorkspaceFingerprint(folder.uri.fsPath);

      const confirm = await vscode.window.showWarningMessage(
        `MoA: 即将清理当前工作区（指纹 ${fingerprint}）的所有 MoA 任务缓存。此操作不可撤销。是否继续？`,
        { modal: true },
        '确认清理',
      );
      if (confirm !== '确认清理') {
        return;
      }

      const result = await cleanupExpiredTasks({ workspaceFilter: fingerprint, ttlDays: 0 });
      const mbFreed = (result.bytes_freed / 1024 / 1024).toFixed(2);
      const msg = `MoA: 工作区清理完成 — 删除 ${result.removed}，释放 ${mbFreed} MB`;
      vscode.window.showInformationMessage(msg);
    }),
  );

  // 命令 3：MoA: Cleanup All Tasks（高危）
  context.subscriptions.push(
    vscode.commands.registerCommand('moa.cleanupAllTasks', async () => {
      const confirm = await vscode.window.showWarningMessage(
        `MoA: 即将清理所有 MoA 任务缓存（所有工作区）。此操作不可撤销。是否继续？`,
        { modal: true },
        '确认清理全部',
      );
      if (confirm !== '确认清理全部') {
        return;
      }

      const result = await cleanupExpiredTasks({ ttlDays: 0 });
      const mbFreed = (result.bytes_freed / 1024 / 1024).toFixed(2);
      const msg = `MoA: 全部清理完成 — 删除 ${result.removed}/${result.scanned}，释放 ${mbFreed} MB`;
      vscode.window.showInformationMessage(msg);
    }),
  );
}
