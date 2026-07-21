/**
 * v0.21.0 I-2 测试 —— moaLogUtils 工具函数。
 *
 * 跑法（项目根目录）：
 *   npm test
 * 或：
 *   npx ts-node --transpile-only --compiler-options '{"module":"commonjs"}' test/moaLogUtils.test.ts
 *
 * 覆盖：
 *   - formatLocalTimestamp 本地时区格式
 *   - formatLogLine 各字段组合（无 iter / 无 model / 无 details 等）
 *   - formatTaskBoundary 三种 event（started / finalized / crashed）
 *   - 长字符串截断（task > 120 字符）
 */

import * as assert from 'node:assert';
import { test } from 'node:test';
import {
  formatLocalTimestamp,
  formatLogLine,
  formatTaskBoundary,
} from '../src/moaLogUtils';

// ─────────────────────────────────────────────────────────────────────────
// formatLocalTimestamp
// ─────────────────────────────────────────────────────────────────────────

test('formatLocalTimestamp: 基本格式 + 含 TZ 标签 + UTC 偏移', () => {
  const fixed = new Date('2026-07-21T10:30:45.123Z'); // UTC
  const out = formatLocalTimestamp(fixed);
  // 不绑定具体时区（CI 可能是 UTC），但应该包含必备段
  assert.match(out, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} /, '应匹配 YYYY-MM-DD HH:mm:ss.SSS');
  assert.match(out, / \(UTC[+-]\d{2}:\d{2}\)$/, '应包含 UTC 偏移括号');
  // 日期与时间之间应是空格，不是 ISO 的 'T' 分隔符
  assert.match(out, /\d{4}-\d{2}-\d{2} \d{2}:/, '日期和时间之间应为空格');
  assert.ok(!/^\d{4}-\d{2}-\d{2}T/.test(out), '不应是 ISO T 分隔符');
  assert.ok(!out.endsWith('Z'), '不应以 Z 结尾（不是 UTC ISO）');
});

test('formatLocalTimestamp: 毫秒段 3 位补零', () => {
  const fixed = new Date('2026-07-21T10:30:45.005Z');
  const out = formatLocalTimestamp(fixed);
  assert.match(out, /\.005 /, '毫秒应补零为 3 位');
});

test('formatLocalTimestamp: 默认参数 = 当前时间', () => {
  const before = Date.now();
  const out = formatLocalTimestamp();
  const after = Date.now();
  // 只是验证不会抛异常 + 返回合理字符串
  assert.ok(out.length > 20);
  assert.ok(after >= before);
});

// ─────────────────────────────────────────────────────────────────────────
// formatLogLine
// ─────────────────────────────────────────────────────────────────────────

test('formatLogLine: 最小（只有 event）', () => {
  const out = formatLogLine({ event: 'skipped' });
  assert.match(out, /^\[[^\]]+\] skipped$/);
});

test('formatLogLine: 完整字段（iter + role + model + elapsed + details）', () => {
  const out = formatLogLine({
    iter: 3,
    role: 'Refs/advisor_1',
    model: 'DeepSeek-V4-Flash',
    elapsed_sec: 3.2,
    event: 'response',
    details: { confidence: 0.85, new_findings: 3, label: 'stable' },
  });
  assert.match(out, /\[iter 3\]/);
  assert.match(out, /\[Refs\/advisor_1\]/);
  assert.match(out, /\[model: DeepSeek-V4-Flash\]/);
  assert.match(out, /\(3\.2s\)/);
  assert.match(out, /confidence=0\.85/);
  assert.match(out, /new_findings=3/);
  assert.match(out, /label=stable/); // 字符串值原样输出
});

test('formatLogLine: 无 iter / 无 model / 无 elapsed / 无 details', () => {
  const out = formatLogLine({
    role: 'Planner',
    event: 'response',
  });
  assert.ok(!out.includes('[iter'));
  assert.ok(!out.includes('[model'));
  assert.ok(!/\(\d+\.\d+s\)/.test(out), '不应有 elapsed');
  assert.match(out, /\[Planner\] response$/);
});

test('formatLogLine: details 中非字符串值走 JSON.stringify', () => {
  const out = formatLogLine({
    event: 'tool_call',
    details: { count: 5, ok: true, list: [1, 2, 3] },
  });
  assert.match(out, /count=5/);
  assert.match(out, /ok=true/);
  assert.match(out, /list=\[1,2,3\]/);
});

test('formatLogLine: elapsed_sec 保留 1 位小数', () => {
  const out = formatLogLine({ event: 'x', elapsed_sec: 12.345 });
  assert.match(out, /\(12\.3s\)/);
});

// ─────────────────────────────────────────────────────────────────────────
// formatTaskBoundary
// ─────────────────────────────────────────────────────────────────────────

test('formatTaskBoundary: started 基本字段', () => {
  const lines = formatTaskBoundary('started', {
    task_id: 'moa_abc123',
    task: 'refactor foo',
  });
  assert.ok(lines.length >= 5);
  assert.strictEqual(lines[1], '=== Task STARTED ===');
  assert.ok(lines.some((l) => l.includes('moa_abc123')));
  assert.ok(lines.some((l) => l.includes('refactor foo')));
  // started 不应有 iters / elapsed
  assert.ok(!lines.some((l) => l.startsWith('iters')));
  assert.ok(!lines.some((l) => l.startsWith('elapsed')));
});

test('formatTaskBoundary: finalized 含 iter + elapsed + extra', () => {
  const lines = formatTaskBoundary('finalized', {
    task_id: 'moa_xyz',
    task: 'long task',
    iter: 10,
    elapsed_sec: 245.8,
    extra: { completeness: '0.85', convergence: 'natural' },
  });
  assert.strictEqual(lines[1], '=== Task FINALIZED ===');
  assert.ok(lines.some((l) => l.startsWith('iters') && l.includes('10')));
  assert.ok(lines.some((l) => l.startsWith('elapsed') && l.includes('245.8')));
  // extra 字段应出现在 timestamp 之前
  assert.ok(lines.some((l) => l.includes('completeness') && l.includes('0.85')));
  assert.ok(lines.some((l) => l.includes('convergence') && l.includes('natural')));
  // 最后一个非分隔行应是 timestamp
  const lastNonSeparator = lines.filter((l) => !l.startsWith('═')).slice(-1)[0];
  assert.ok(lastNonSeparator.startsWith('timestamp'), 'timestamp 应在最后');
});

test('formatTaskBoundary: crashed 顶层是 CRASHED', () => {
  const lines = formatTaskBoundary('crashed', {
    task_id: 'moa_err',
    task: 'x',
    extra: { error: 'OOM' },
  });
  assert.strictEqual(lines[1], '=== Task CRASHED ===');
  assert.ok(lines.some((l) => l.includes('OOM')));
});

test('formatTaskBoundary: task > 120 字符被截断', () => {
  const longTask = 'x'.repeat(200);
  const lines = formatTaskBoundary('started', {
    task_id: 't',
    task: longTask,
  });
  // 用 'task      :' 匹配（带空格 + 冒号），排除 'task_id   :'
  const taskLine = lines.find((l) => /^task\s+:/.test(l));
  assert.ok(taskLine, '应有 task 行');
  assert.ok(taskLine!.endsWith('...'), '应以 ... 结尾');
  // task_id(11) + ' x'.repeat(~115) + '...'
  assert.ok(taskLine!.length < 150, 'task 行应被截断');
});

test('formatTaskBoundary: 首尾是分隔线', () => {
  const lines = formatTaskBoundary('started', { task_id: 't', task: 'x' });
  assert.ok(lines[0].startsWith('═'), '首行应是 ═ 分隔线');
  assert.ok(lines[lines.length - 1].startsWith('═'), '尾行应是 ═ 分隔线');
  assert.strictEqual(lines[0], lines[lines.length - 1], '首尾分隔线长度一致');
});
