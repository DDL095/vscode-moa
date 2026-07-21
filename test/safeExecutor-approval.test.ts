/**
 * v0.20.0 — SafeExecutor 审批能力单元测试
 *
 * 跑法（项目根目录）：
 *   npm test
 */

// ─────────────────────────────────────────────────────────────────────────
// vscode 模块 stub —— 在导入被测文件之前注入，绕过顶部 `import * as vscode`
// ─────────────────────────────────────────────────────────────────────────
import { createRequire } from 'node:module';
const require_ = createRequire(import.meta.url);
const Module = require_('node:module') as typeof import('module');
const origResolve = Module._resolveFilename as unknown as (...a: unknown[]) => string;
Module._resolveFilename = function (request: string, ...args: unknown[]) {
  if (request === 'vscode') return 'node:module';
  return origResolve.call(this, request, ...args);
};
const origLoad = Module._load as unknown as (...a: unknown[]) => unknown;
Module._load = function (request: string, ...args: unknown[]) {
  if (request === 'vscode') {
    return {
      workspace: { getConfiguration: () => ({ get: (_k: string, dflt: unknown) => dflt }) },
      window: {
        showWarningMessage: async () => 'Yes',
        showQuickPick: async () => [],
      },
      QuickPickItem: class {},
    };
  }
  return origLoad.call(this, request, ...args);
};

import * as assert from 'node:assert';
import { test } from 'node:test';
import * as path from 'path';
import * as os from 'os';
import * as fsPromises from 'fs/promises';

import {
  SafeExecutor,
  ApprovalRejectedError,
  type SafeActionRecord,
} from '../src/moaCore/safeExecutor';

async function makeTempTaskDir(): Promise<string> {
  return fsPromises.mkdtemp(path.join(os.tmpdir(), 'moa-test-'));
}

function mockRecord(type: SafeActionRecord['type'], target: string): SafeActionRecord {
  return {
    iter: 1,
    seq: 1,
    type,
    target,
    tool_name: `mock_${type}`,
    input_summary: JSON.stringify({ path: target }).substring(0, 200),
    status: 'success',
    timestamp: new Date().toISOString(),
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Gate-A
// ─────────────────────────────────────────────────────────────────────────

test('Gate-A: 全空 actionItems 直接返回空数组（不弹窗）', async () => {
  const taskDir = await makeTempTaskDir();
  try {
    const executor = new SafeExecutor(taskDir, 1, undefined, {
      approvalMode: 'batch',
      batchApprovalImpl: async () => {
        throw new Error('should not be called for empty action_items');
      },
    });
    const result = await executor.requestBatchApproval([]);
    assert.deepStrictEqual(result, []);
  } finally { await fsPromises.rm(taskDir, { recursive: true, force: true }); }
});

test('Gate-A: 用户全选返回全部', async () => {
  const taskDir = await makeTempTaskDir();
  try {
    const items = [
      { type: 'write_file', target: 'a.ts',  rationale: 'rationale A' },
      { type: 'execute',   target: 'npm test', rationale: 'rationale B' },
    ];
    const executor = new SafeExecutor(taskDir, 1, undefined, {
      approvalMode: 'batch',
      batchApprovalImpl: async <T,>(passed: readonly T[]): Promise<T[]> => [...passed],
    });
    const picked = await executor.requestBatchApproval(items);
    assert.strictEqual(picked.length, 2);
    assert.deepStrictEqual(picked[0].target, 'a.ts');
  } finally { await fsPromises.rm(taskDir, { recursive: true, force: true }); }
});

test('Gate-A: 用户部分勾选返回子集', async () => {
  const taskDir = await makeTempTaskDir();
  try {
    const items = [
      { type: 'write_file', target: 'a.ts', rationale: 'A' },
      { type: 'execute',   target: 'cmd',  rationale: 'B' },
      { type: 'write_file', target: 'c.ts', rationale: 'C' },
    ];
    const executor = new SafeExecutor(taskDir, 1, undefined, {
      approvalMode: 'batch',
      batchApprovalImpl: async <T,>(passed: readonly T[]): Promise<T[]> => [passed[0], passed[2]],
    });
    const picked = await executor.requestBatchApproval(items);
    assert.strictEqual(picked.length, 2);
    assert.strictEqual(picked[0].target, 'a.ts');
    assert.strictEqual(picked[1].target, 'c.ts');
  } finally { await fsPromises.rm(taskDir, { recursive: true, force: true }); }
});

test('Gate-A: 用户取消（undefined）视为全部拒绝', async () => {
  const taskDir = await makeTempTaskDir();
  try {
    const items = [{ type: 'write_file', target: 'a.ts', rationale: 'A' }];
    const executor = new SafeExecutor(taskDir, 1, undefined, {
      approvalMode: 'batch',
      batchApprovalImpl: async <T,>(): Promise<T[] | undefined> => undefined,
    });
    const picked = await executor.requestBatchApproval(items);
    assert.deepStrictEqual(picked, []);
  } finally { await fsPromises.rm(taskDir, { recursive: true, force: true }); }
});

// ─────────────────────────────────────────────────────────────────────────
// Gate-B
// ─────────────────────────────────────────────────────────────────────────

test('Gate-B: 用户选 Yes 返回 yes', async () => {
  const taskDir = await makeTempTaskDir();
  try {
    const executor = new SafeExecutor(taskDir, 1, undefined, {
      approvalMode: 'per_call',
      callApprovalImpl: async () => 'yes',
    });
    const decision = await executor.requestCallApproval(mockRecord('write_file', 'a.ts'));
    assert.strictEqual(decision, 'yes');
  } finally { await fsPromises.rm(taskDir, { recursive: true, force: true }); }
});

test('Gate-B: 用户选 No 返回 no', async () => {
  const taskDir = await makeTempTaskDir();
  try {
    const executor = new SafeExecutor(taskDir, 1, undefined, {
      callApprovalImpl: async () => 'no',
    });
    const decision = await executor.requestCallApproval(mockRecord('write_file', 'a.ts'));
    assert.strictEqual(decision, 'no');
  } finally { await fsPromises.rm(taskDir, { recursive: true, force: true }); }
});

test('Gate-B: 用户选 Yes to All 激活 yesToAllActivated', async () => {
  const taskDir = await makeTempTaskDir();
  try {
    const executor = new SafeExecutor(taskDir, 1, undefined, {
      callApprovalImpl: async () => 'yes_to_all',
    });
    const decision = await executor.requestCallApproval(mockRecord('write_file', 'a.ts'));
    assert.strictEqual(decision, 'yes_to_all');
  } finally { await fsPromises.rm(taskDir, { recursive: true, force: true }); }
});

test('Gate-B: 用户选 Reject All 返回 reject_all', async () => {
  const taskDir = await makeTempTaskDir();
  try {
    const executor = new SafeExecutor(taskDir, 1, undefined, {
      callApprovalImpl: async () => 'reject_all',
    });
    const decision = await executor.requestCallApproval(mockRecord('write_file', 'a.ts'));
    assert.strictEqual(decision, 'reject_all');
  } finally { await fsPromises.rm(taskDir, { recursive: true, force: true }); }
});

// ─────────────────────────────────────────────────────────────────────────
// ApprovalRejectedError
// ─────────────────────────────────────────────────────────────────────────

test('ApprovalRejectedError: name 属性和 source 字段正确', () => {
  const err = new ApprovalRejectedError('gate_b', 'user declined');
  assert.strictEqual(err.name, 'ApprovalRejectedError');
  assert.ok(err instanceof Error);
  assert.ok(err instanceof ApprovalRejectedError);
  assert.strictEqual(err.source, 'gate_b');
  assert.ok(err.message.includes('user declined'));
});

test('ApprovalRejectedError: 默认 message 应包含 source', () => {
  const err = new ApprovalRejectedError('reject_all');
  assert.ok(err.message.includes('reject_all'));
});

// ─────────────────────────────────────────────────────────────────────────
// wrapToolCall + 审批交互
// ─────────────────────────────────────────────────────────────────────────

test('wrapToolCall (approvalMode=none): 写文件时不弹 Gate-B', async () => {
  const taskDir = await makeTempTaskDir();
  try {
    let popupCalled = false;
    const executor = new SafeExecutor(taskDir, 1, undefined, {
      approvalMode: 'none',
      callApprovalImpl: async () => {
        popupCalled = true;
        return 'yes';
      },
    });
    const target = path.join(taskDir, 'test.txt');
    await executor.wrapToolCall('mock_write_file', { path: target }, async () => ({ content: 'ok' }));
    await executor.flushManifest();
    assert.strictEqual(popupCalled, false);
    const manifest = JSON.parse(await fsPromises.readFile(path.join(taskDir, 'manifest.json'), 'utf8'));
    assert.strictEqual(manifest[0].status, 'success');
  } finally { await fsPromises.rm(taskDir, { recursive: true, force: true }); }
});

test('wrapToolCall (approvalMode=per_call + read): 只读操作不弹 Gate-B', async () => {
  const taskDir = await makeTempTaskDir();
  try {
    let popupCalled = false;
    const executor = new SafeExecutor(taskDir, 1, undefined, {
      approvalMode: 'per_call',
      callApprovalImpl: async () => {
        popupCalled = true;
        return 'no';
      },
    });
    const target = path.join(taskDir, 'test.txt');
    await executor.wrapToolCall('mock_read_file', { path: target }, async () => ({ content: 'ok' }));
    assert.strictEqual(popupCalled, false);
  } finally { await fsPromises.rm(taskDir, { recursive: true, force: true }); }
});

test('wrapToolCall (approvalMode=per_call + write + no): 抛 ApprovalRejectedError(gate_b) + rejected_by_user', async () => {
  const taskDir = await makeTempTaskDir();
  try {
    const executor = new SafeExecutor(taskDir, 1, undefined, {
      approvalMode: 'per_call',
      callApprovalImpl: async () => 'no',
    });
    const target = path.join(taskDir, 'test.txt');
    await assert.rejects(
      executor.wrapToolCall('mock_write_file', { path: target }, async () => ({ content: 'should not reach' })),
      (err: unknown) => err instanceof ApprovalRejectedError && err.source === 'gate_b'
    );
    await executor.flushManifest();
    const manifest = JSON.parse(await fsPromises.readFile(path.join(taskDir, 'manifest.json'), 'utf8'));
    assert.strictEqual(manifest[0].status, 'rejected_by_user');
  } finally { await fsPromises.rm(taskDir, { recursive: true, force: true }); }
});
