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

// v0.20.0: 改为 lazy require —— 让测试环境（无 vscode module）能跳过顶层解析。
// 使用方式：callers 调 getVscode().workspace.xxx；首次访问才解析。
//
// 注意：safeExecutor 仅在 requestCallApproval/requestBatchApproval 默认分支
// 与 resolveExecutionConfig 中访问 vscode API。所有构造代码 + wrapToolCall
// 的非审批路径都不依赖它。测试可通过构造参数注入 mock 完全跳过。
let _vscode: typeof import('vscode') | undefined;
function getVscode(): typeof import('vscode') {
  if (!_vscode) {
    _vscode = require('vscode') as typeof import('vscode');
  }
  return _vscode!;
}

// v0.20.0: 类型导入（type-only，不触发 require）
import type * as VscodeT from 'vscode';
type QuickPickOptions = VscodeT.QuickPickOptions;
type QuickPickItem = VscodeT.QuickPickItem;
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
  /** 执行状态。
   *  v0.20.0 新增 'rejected_by_user'：用户通过 Approval Gate 明确拒绝
   *  （Gate-A 批量勾选未选 / Gate-B 单次 YesNo 选 No）。区别于 'failed'（技术错误）。 */
  status: 'success' | 'failed' | 'partial' | 'rejected_by_user';
  /** 输出字符数（工具 result content 的字符串长度） */
  output_chars?: number;
  /** ISO8601 时间戳 */
  timestamp: string;
  /** 错误信息（status=failed 时填） */
  error?: string;
}

/**
 * v0.20.0: 用户拒绝触发的错误（Gate-B Reject All 或 YesNo 选 No）。
 * actingAgent 捕获后标 skipped，不抛错终止迭代。
 */
export class ApprovalRejectedError extends Error {
  constructor(
    public readonly source: 'gate_a' | 'gate_b' | 'reject_all',
    message?: string
  ) {
    super(message ?? `Approval rejected by user (source=${source})`);
    this.name = 'ApprovalRejectedError';
  }
}

/**
 * v0.20.0: 审批模式（用户在 moa.executionPreset / moa.approvalMode 配置）。
 * - none: 不弹任何审批（依赖 backup 兜底）
 * - batch: Gate-A 入口批量 QuickPick 一次
 * - per_call: Gate-B 每次破坏性工具调用都弹 Yes/No/YesToAll/RejectAll
 * - batch_plus_per_call: 双门，最保守
 */
export type ApprovalMode = 'none' | 'batch' | 'per_call' | 'batch_plus_per_call';

/**
 * v0.20.0: 执行预设（顶层快捷方式）。见 plan.md D1.5。
 * - manual:     v0.19.2 行为 + finalize 后显式 #moa_execute + batch 审批
 * - supervised: 全链路自动 + batch 审批
 * - autopilot:  全链路全自动 + 无审批（保留 backup）—— 推荐"完全自动化"模式
 * - yolo:       极速裸跑，无审批无 backup（仅供 CI）
 * - custom:     回退 3 个细粒度配置
 */
export type ExecutionPreset = 'manual' | 'supervised' | 'autopilot' | 'yolo' | 'custom';

/**
 * v0.20.0: 顶层执行预设 → 实际生效配置的解析函数。
 * 单一来源：所有读取配置的地方（callActor / finalizeTask / SafeExecutor）统一调此函数。
 */
export function resolveExecutionConfig(): {
  preset: ExecutionPreset;
  autoExecute: boolean;
  approvalMode: ApprovalMode;
  safeMode: boolean;
} {
  const cfg = getVscode().workspace.getConfiguration('moa');
  const preset = cfg.get<ExecutionPreset>('executionPreset', 'manual');

  if (preset === 'custom') {
    return {
      preset: 'custom',
      autoExecute: cfg.get<boolean>('autoExecuteAfterFinalize', false),
      approvalMode: cfg.get<ApprovalMode>('approvalMode', 'batch'),
      safeMode: cfg.get<boolean>('safeExecutionMode', true),
    };
  }

  // preset 非空 → 覆盖细粒度配置
  const map: Record<Exclude<ExecutionPreset, 'custom'>, {
    autoExecute: boolean;
    approvalMode: ApprovalMode;
    safeMode: boolean;
  }> = {
    manual:     { autoExecute: false, approvalMode: 'batch',             safeMode: true  },
    supervised: { autoExecute: true,  approvalMode: 'batch',             safeMode: true  },
    autopilot:  { autoExecute: true,  approvalMode: 'none',              safeMode: true  },
    yolo:       { autoExecute: true,  approvalMode: 'none',              safeMode: false },
  };
  return { preset, ...map[preset] };
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
  /** v0.20.0: 审批模式（来自 resolveExecutionConfig）。'none' 跳过所有审批。 */
  private readonly approvalMode: ApprovalMode = 'none';
  /** v0.20.0: Gate-B "Yes to All" 缓存（per-task，仅 per_call 模式有效）。 */
  private yesToAllActivated = false;
  /** v0.20.0: Gate-B "Reject All" 锁定（per-task，激活后所有后续 wrapToolCall 直接拒）。 */
  private rejectAllActivated = false;
  /** v0.20.0: Gate-B 自定义回调注入（用于测试和 mock）。默认用 vscode.window.showWarningMessage。 */
  private callApprovalImpl: ((record: SafeActionRecord) => Promise<'yes' | 'no' | 'yes_to_all' | 'reject_all'>) | undefined = undefined;
  /** v0.20.0: Gate-A 自定义回调注入（用于测试和 mock）。默认用 vscode.window.showQuickPick。 */
  private batchApprovalImpl: (<T>(items: readonly T[], options: QuickPickOptions & { canPickMany: true }) => Promise<T[] | undefined>) | undefined = undefined;

  /**
   * @param taskDir 任务目录（.moa_cache/<task_id>/）
   * @param iterNum 当前 iter 号
   * @param progress 可选的 progress 回调（用于在 chat 显示备份提示）
   * @param options v0.20.0: 可选 options。approvalMode 控制 Gate-B 行为；callApprovalImpl / batchApprovalImpl 注入 mock。
   * @param trashDir 可选的 _trash 目录（默认 taskDir/_trash）
   */
  constructor(
    private readonly taskDir: string,
    private readonly iterNum: number,
    private readonly progress?: (msg: string) => void,
    options?: {
      approvalMode?: ApprovalMode;
      callApprovalImpl?: (record: SafeActionRecord) => Promise<'yes' | 'no' | 'yes_to_all' | 'reject_all'>;
      batchApprovalImpl?: <T>(items: readonly T[], options: QuickPickOptions & { canPickMany: true }) => Promise<T[] | undefined>;
    },
    trashDir?: string,
  ) {
    this.manifestPath = path.join(taskDir, 'manifest.json');
    // 显式赋值（trashDir 已在上方声明为 readonly 字段）
    this.trashDir = trashDir ?? path.join(taskDir, '_trash');
    // v0.20.0: 显式赋值 readonly 字段（TypeScript 类字段初始化顺序）
    this.approvalMode = options?.approvalMode ?? 'none';
    this.callApprovalImpl = options?.callApprovalImpl;
    this.batchApprovalImpl = options?.batchApprovalImpl;
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

    // ── v0.20.0: Gate-B 审批拦截（per_call / batch_plus_per_call 模式）──────
    // 仅破坏性工具（write_file/delete/execute）触发审批，read/grep/other 直通。
    if ((this.approvalMode === 'per_call' || this.approvalMode === 'batch_plus_per_call')
        && (record.type === 'write_file' || record.type === 'delete' || record.type === 'execute')) {
      // 1. Reject All 已锁定 → 直接拒
      if (this.rejectAllActivated) {
        record.status = 'rejected_by_user';
        record.error = 'Reject All activated earlier in this task';
        this.records.push(record);
        throw new ApprovalRejectedError('reject_all',
          'Reject All was activated; subsequent calls blocked by SafeExecutor');
      }
      // 2. Yes to All 已激活 → 跳过弹窗
      if (!this.yesToAllActivated) {
        const decision = await this.requestCallApproval(record);
        if (decision === 'yes_to_all') {
          this.yesToAllActivated = true;
          this.progress?.(`[SafeExecutor] Gate-B: Yes to All activated for task ${path.basename(this.taskDir)}`);
        } else if (decision === 'reject_all') {
          this.rejectAllActivated = true;
          record.status = 'rejected_by_user';
          record.error = 'User chose Reject All';
          this.records.push(record);
          throw new ApprovalRejectedError('reject_all',
            `User rejected tool call: ${toolName}`);
        } else if (decision === 'no') {
          record.status = 'rejected_by_user';
          record.error = 'User declined in Gate-B';
          this.records.push(record);
          throw new ApprovalRejectedError('gate_b',
            `User declined tool call: ${toolName}`);
        }
        // decision === 'yes' → fall through to invoke
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

  /**
   * v0.20.0: Gate-B 单次审批（破坏性工具调用前弹窗）。
   * 默认用 `vscode.window.showWarningMessage(msg, 'Yes', 'No', 'Yes to All', 'Reject All')`。
   * 测试或外部 mock 可通过构造函数 `callApprovalImpl` 注入。
   */
  async requestCallApproval(record: SafeActionRecord): Promise<'yes' | 'no' | 'yes_to_all' | 'reject_all'> {
    if (this.callApprovalImpl) return this.callApprovalImpl(record);

    // 默认实现：showWarningMessage 弹 4 按钮
    const targetShort = record.target ? path.basename(record.target) : '<no-target>';
    const typeLabel = record.type.toUpperCase();
    const msg =
      `[MoA Actor Approval] ${typeLabel} tool wants to act\n` +
      `Tool: ${record.tool_name}\n` +
      `Target: ${targetShort}\n` +
      `Input: ${record.input_summary.substring(0, 200)}\n` +
      (record.backup_path ? `Backup: ${path.basename(record.backup_path)}\n` : '');

    const choice = await getVscode().window.showWarningMessage(
      msg,
      { modal: false },
      'Yes',
      'No',
      'Yes to All',
      'Reject All'
    );
    switch (choice) {
      case 'Yes':       return 'yes';
      case 'Yes to All':return 'yes_to_all';
      case 'Reject All':return 'reject_all';
      case 'No':
      default:          return 'no';
    }
  }

  /**
   * v0.20.0: Gate-A 批量审批（Actor 入口，一次性勾选要执行的 action_items）。
   *
   * @param actionItems 聚合器给出的 action_items（任意 T 类型，渲染时只看 type/target/rationale）
   * @returns 用户勾选的 action_items 数组；空数组表示全部拒绝；undefined 表示用户取消（视为全部拒绝）
   */
  async requestBatchApproval<T extends { type: string; target: string; rationale?: string }>(
    actionItems: readonly T[]
  ): Promise<T[]> {
    if (actionItems.length === 0) return [];

    if (this.batchApprovalImpl) {
      const picked = await this.batchApprovalImpl(actionItems, {
        canPickMany: true,
        placeHolder: `Select action_items to execute (${actionItems.length} total). Backups will be created automatically.`,
      });
      return picked ?? [];
    }

    // 默认实现：showQuickPick 多选
    interface PickableItem extends QuickPickItem { actionItem: T; }
    const picks: PickableItem[] = actionItems.map((a, i) => ({
      actionItem: a,
      label: `$(pass) ${i + 1}. [${a.type}] ${a.target}`,
      description: (a.rationale ?? '').substring(0, 100),
      picked: true,  // 默认全选（用户取消即代表拒绝，更安全的是默认全选让用户剔除不想要的）
    }));

    const selected = await getVscode().window.showQuickPick(picks, {
      canPickMany: true,
      placeHolder: `MoA Actor: select ${actionItems.length} action_items to execute (deselect to reject)`,
    });
    if (!selected) return [];
    return selected.map((s) => s.actionItem);
  }
}

/**
 * 为 actingAgent 的单个 iter 创建一个 SafeExecutor。
 *
 * v0.20.0 扩展：默认从 `resolveExecutionConfig().approvalMode` 读审批模式；
 * 可通过 `options.approvalMode` 显式覆盖（主要用于测试）。
 * 工厂函数，简化调用方代码。
 *
 * @param taskDir 任务目录
 * @param iterNum iter 号
 * @param progress 可选 progress 回调
 * @param options 可选：覆盖 approvalMode / 注入 mock 回调
 */
export function createSafeExecutor(
  taskDir: string,
  iterNum: number,
  progress?: (msg: string) => void,
  options?: {
    approvalMode?: ApprovalMode;
    callApprovalImpl?: (record: SafeActionRecord) => Promise<'yes' | 'no' | 'yes_to_all' | 'reject_all'>;
    batchApprovalImpl?: <T>(items: readonly T[], options: QuickPickOptions & { canPickMany: true }) => Promise<T[] | undefined>;
  },
): SafeExecutor {
  const execConfig = resolveExecutionConfig();
  const approvalMode = options?.approvalMode ?? execConfig.approvalMode;
  return new SafeExecutor(taskDir, iterNum, progress, {
    approvalMode,
    callApprovalImpl: options?.callApprovalImpl,
    batchApprovalImpl: options?.batchApprovalImpl,
  });
}
