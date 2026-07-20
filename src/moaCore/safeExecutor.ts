/**
 * moaCore/safeExecutor.ts — v0.19.1 §3 保守执行模式（SafeExecutor 最小版）
 *
 * 职责：
 *   拦截所有 actingAgent 的 tool calls，对副作用类操作（write_file / delete /
 *   execute）做预备份 + manifest 落盘，保证 Actor 行为可审计 / 可回滚。
 *
 * 设计哲学（用户原话）：
 *   "不管是内置开关让内置可用，还是到主会话再拉起，都必须保守性的执行，
 *    遇到删除就都进行 bak 备份，然后将清单落盘，保证信息传递准确度，
 *    最后汇总给用户，是否清理与删除要让用户进行操作"
 *
 * v0.19.1 范围（最小版）：
 *   ✅ write_file / apply_patch / insert_edit / replace_string → 预备份原文件
 *   ✅ delete / remove → 预备份 + 移到 _trash/（而非真删）
 *   ✅ execute（terminal 类）→ 不备份（无文件可备份），仅记 manifest
 *   ✅ read / grep / search → 仅记 manifest（只读操作）
 *   ✅ manifest.json 累积落盘（iter 内增量，不每条 flush）
 *   ❌ 用户确认弹窗（推到 v0.20.0，本版本自动执行 + 事后汇总）
 *
 * 使用方式（从 actingAgent.ts invokeTool 前后调用）：
 *   const executor = new SafeExecutor(taskDir, iterNum, progress);
 *   const result = await executor.wrapToolCall(toolName, input, () => invokeTool(...));
 *   // executor 末尾会自动 flushManifest
 */

import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';

/**
 * 工具动作分类（决定备份策略）。
 */
export type ToolActionType =
  | 'write_file'  // 修改/创建文件
  | 'delete'      // 删除文件
  | 'execute'     // 执行命令（terminal）
  | 'read'        // 只读
  | 'grep'        // 搜索只读
  | 'other';      // 其他（web search / fetch / mcp 调用）

/**
 * manifest.json 中的单条记录。
 */
export interface SafeActionRecord {
  /** iter 号（来自 SafeExecutor 构造参数） */
  iter: number;
  /** 工具调用序号（同 iter 内递增，从 1 开始） */
  seq: number;
  /** 动作分类 */
  type: ToolActionType;
  /** 目标路径（如能从 input 提取） */
  target: string;
  /** 工具名（如 copilot_create_file / mcp_gitkraken_commit） */
  tool_name: string;
  /** 输入摘要（截断到 200 字符） */
  input_summary: string;
  /** 备份文件路径（write_file / delete 类有，其他 undefined） */
  backup_path?: string;
  /** 执行状态 */
  status: 'success' | 'failed' | 'partial';
  /** 输出字符数（工具 result content 的字符串长度） */
  output_chars?: number;
  /** ISO8601 时间戳 */
  timestamp: string;
  /** 错误信息（status=failed 时填） */
  error?: string;
}

/**
 * 把工具名分类为动作类型。
 *
 * @param name 工具名
 * @returns 动作类型
 */
export function classifyTool(name: string): ToolActionType {
  // 顺序敏感：先匹配更具体的（如 delete_file 不能被 write 匹配）
  if (/delete|remove|unlink|rmdir/i.test(name)) return 'delete';
  if (/write.?file|create.?file|apply.?patch|insert.?edit|replace.?string|rename/i.test(name)) return 'write_file';
  if (/run.?in.?terminal|send.?to.?terminal|exec/i.test(name)) return 'execute';
  if (/grep|search|find|list.?dir|file.?search/i.test(name)) return 'grep';
  if (/read/i.test(name)) return 'read';
  return 'other';
}

/**
 * 从工具 input 中提取目标文件路径。
 *
 * @param input 工具 input 对象
 * @returns 目标路径字符串（如能提取，否则空串）
 */
export function extractTarget(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const obj = input as Record<string, unknown>;
  // 优先级：filePath > path > file > target > fileName > folder > directory
  for (const field of ['filePath', 'path', 'file', 'target', 'fileName', 'folder', 'directory']) {
    const v = obj[field];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return '';
}

/**
 * SafeExecutor 单例（per-iter）。
 *
 * 用法：
 *   const executor = new SafeExecutor(taskDir, 3, progress);
 *   // ... 在 invokeTool 前后：
 *   const result = await executor.wrapToolCall(name, input, () => invokeTool(...));
 *   // iter 末尾：
 *   await executor.flushManifest();
 */
export class SafeExecutor {
  private records: SafeActionRecord[] = [];
  private seqCounter = 0;
  private manifestPath: string;
  /** _trash 目录（强制非空，构造函数初始化） */
  private readonly trashDir: string;

  /**
   * @param taskDir 任务目录（.moa_cache/<task_id>/）
   * @param iterNum 当前 iter 号
   * @param progress 可选的 progress 回调（用于在 chat 显示备份提示）
   * @param trashDir 可选的 _trash 目录（默认 taskDir/_trash）
   */
  constructor(
    private readonly taskDir: string,
    private readonly iterNum: number,
    private readonly progress?: (msg: string) => void,
    trashDir?: string,
  ) {
    this.manifestPath = path.join(taskDir, 'manifest.json');
    // 显式赋值（trashDir 已在上方声明为 readonly 字段）
    this.trashDir = trashDir ?? path.join(taskDir, '_trash');
  }

  /**
   * trash 目录访问器（强制非空 string）。
   */
  private getTrashDir(): string {
    return this.trashDir;
  }

  /**
   * 包装一次工具调用。
   *
   * 执行流程：
   *   1. 分类工具
   *   2. 提取目标路径
   *   3. write_file / delete：如果目标存在，备份到 .bak.<timestamp>
   *   4. 执行工具（invoke 函数）
   *   5. 记录 manifest（同步累积到 this.records）
   *   6. 返回工具结果（不修改原结果）
   *
   * @param toolName 工具名
   * @param input 工具 input
   * @param invoke 实际的工具调用闭包（返回 LanguageModelToolResult）
   * @returns 工具调用结果（原样透传）
   */
  async wrapToolCall<T extends { content: unknown }>(
    toolName: string,
    input: unknown,
    invoke: () => Promise<T>,
  ): Promise<T> {
    this.seqCounter += 1;
    const record: SafeActionRecord = {
      iter: this.iterNum,
      seq: this.seqCounter,
      type: classifyTool(toolName),
      target: extractTarget(input),
      tool_name: toolName,
      input_summary: this.safeStringify(input, 200),
      status: 'success',
      timestamp: new Date().toISOString(),
    };

    // 预备份（write_file / delete 类）
    if ((record.type === 'write_file' || record.type === 'delete') && record.target) {
      try {
        const backupPath = await this.backupFile(record.target, record.type === 'delete');
        if (backupPath) {
          record.backup_path = backupPath;
          this.progress?.(
            `[SafeExecutor] backed up ${path.basename(record.target)} → ${path.basename(backupPath)}`
          );
        }
      } catch (err) {
        // 备份失败不阻塞工具调用，但记录到 manifest
        record.error = `backup_failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    // 执行工具
    try {
      const result = await invoke();
      // 估算输出字符数
      const content = (result as { content?: unknown }).content;
      if (content) {
        try {
          record.output_chars = JSON.stringify(content).length;
        } catch {
          record.output_chars = 0;
        }
      }
      return result;
    } catch (err) {
      record.status = 'failed';
      record.error = err instanceof Error ? err.message.substring(0, 300) : String(err).substring(0, 300);
      throw err;
    } finally {
      this.records.push(record);
    }
  }

  /**
   * 把当前累积的 records flush 到 manifest.json。
   *
   * 策略：读取现有 manifest（如有），追加新 records，写回。
   * 原子化：先写 .tmp 再 rename。
   *
   * 应在 iter 末尾调用，或 wrapToolCall 累计 N 条后调用。
   */
  async flushManifest(): Promise<void> {
    if (this.records.length === 0) return;

    // 读取现有 manifest
    let existing: SafeActionRecord[] = [];
    try {
      const raw = await fs.readFile(this.manifestPath, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) existing = parsed;
    } catch {
      // 文件不存在或解析失败，从零开始
    }

    // 追加并原子化写入
    const merged = [...existing, ...this.records];
    const tmp = `${this.manifestPath}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(merged, null, 2), 'utf8');
    await fs.rename(tmp, this.manifestPath);

    // 清空当前 buffer（避免重复 flush）
    this.records = [];
  }

  /**
   * 获取当前已累积的 records（用于 Actor 末尾汇总显示）。
   */
  getRecords(): readonly SafeActionRecord[] {
    return this.records;
  }

  /**
   * 备份单个文件。
   *
   * @param target 目标文件路径
   * @param isDelete 是否是 delete 操作（true → 移到 _trash/，false → 复制 .bak）
   * @returns 备份文件路径，如备份失败或原文件不存在则返回 null
   */
  private async backupFile(target: string, isDelete: boolean): Promise<string | null> {
    try {
      await fs.access(target);
    } catch {
      return null;  // 原文件不存在（新建场景），无需备份
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);

    if (isDelete) {
      // delete：移到 _trash/<basename>.<timestamp>
      const trashDir = this.getTrashDir();
      await fs.mkdir(trashDir, { recursive: true });
      const basename = path.basename(target);
      const trashPath = path.join(trashDir, `${basename}.${timestamp}`);
      await fs.rename(target, trashPath);
      return trashPath;
    } else {
      // write_file：复制到 <target>.bak.<timestamp>
      const backupPath = `${target}.bak.${timestamp}`;
      await fs.copyFile(target, backupPath);
      return backupPath;
    }
  }

  /**
   * 安全 stringify（截断 + 失败兜底）。
   */
  private safeStringify(obj: unknown, maxLen: number): string {
    try {
      const s = JSON.stringify(obj);
      return s.length > maxLen ? s.substring(0, maxLen) + '...' : s;
    } catch {
      return String(obj).substring(0, maxLen);
    }
  }
}

/**
 * 为 actingAgent 的单个 iter 创建一个 SafeExecutor。
 *
 * 工厂函数，简化调用方代码。
 *
 * @param taskDir 任务目录
 * @param iterNum iter 号
 * @param progress 可选 progress 回调
 */
export function createSafeExecutor(
  taskDir: string,
  iterNum: number,
  progress?: (msg: string) => void,
): SafeExecutor {
  return new SafeExecutor(taskDir, iterNum, progress);
}
