/**
 * v0.15.0 hotfix 回归测试。
 *
 * 跑法（项目根目录）：
 *   npm test
 * 或：
 *   npx ts-node --transpile-only --compiler-options '{"module":"commonjs"}' test/hotfix.test.ts
 *
 * 使用 Node.js 内置 node:test 框架（零依赖，Node 18+）。
 *
 * 覆盖点：
 *   - hotfix 1: buildActorEvidence 对缺失 action.content 字段的容错
 *     （原本直接访问 .length 导致 state.history 不入栈的崩溃 bug）
 */

import * as assert from 'node:assert';
import { test } from 'node:test';
import { buildActorEvidence } from '../src/moaCore/actorEvidence';
import type { ActorActionResult } from '../src/moaCore/roles';

// ─────────────────────────────────────────────────────────────────────────
// hotfix 1: buildActorEvidence 防御性测试
// ─────────────────────────────────────────────────────────────────────────

test('hotfix1: 完整 action.content 时优先用 content（不被截断）', () => {
  const ar: ActorActionResult = {
    action: {
      type: 'write_file',
      target: '/path/to/file.md',
      content: '这是文件内容，比较短。',
      rationale: '生成简报',
    },
    status: 'success',
    output_chars: 20,
    error_message: undefined,
    artifacts: ['/path/to/file.md'],
  };
  const ev = buildActorEvidence(ar, 1);
  assert.ok(ev, '应返回 evidence item');
  assert.strictEqual(ev!.confidence, 'high');
  assert.strictEqual(ev!.source, 'actor@iter1:write_file:/path/to/file.md');
  assert.strictEqual(ev!.snippet, '这是文件内容，比较短。');
});

test('hotfix1: 长 content 被截断到 2000 字符 + ...(truncated) 后缀', () => {
  const longContent = 'x'.repeat(3000);
  const ar: ActorActionResult = {
    action: {
      type: 'write_file',
      target: '/p/f',
      content: longContent,
      rationale: 'r',
    },
    status: 'success',
    output_chars: 3000,
    artifacts: [],
  };
  const ev = buildActorEvidence(ar, 1);
  assert.ok(ev);
  assert.ok(ev!.snippet.length <= 2020, 'snippet 应被截断');  // 2000 + '\n...(truncated)'
  assert.ok(ev!.snippet.endsWith('...(truncated)'), '应以 ...(truncated) 结尾');
});

test('hotfix1 核心 bug: action.content 缺失时不崩溃，用 artifacts/output_chars 兜底', () => {
  // 这是 v0.15.0 hotfix 1 修复的原始崩溃场景：
  //   Actor LLM 只回 type/target/rationale，没回 content
  //   旧代码 ar.action.content.length 抛 "Cannot read properties of undefined (reading 'length')"
  const ar: ActorActionResult = {
    action: {
      type: 'execute',
      target: '在工作区根目录执行 Python 脚本生成简报',
      // 注意：content 字段被 LLM 省略
      rationale: '多次 Recon 均遭遇终端长度截断导致数据缺失',
    },
    status: 'success',
    output_chars: 3200,
    error_message: null,
    artifacts: ['D:\\path\\_moa_v015_test_brief.md'],
  };
  // 不应抛错
  const ev = buildActorEvidence(ar, 2);
  assert.ok(ev, '应返回兜底 evidence，不抛错');
  assert.strictEqual(ev!.confidence, 'high');
  assert.strictEqual(ev!.source, 'actor@iter2:execute:在工作区根目录执行 Python 脚本生成简报');
  // 兜底 snippet 应包含关键字段
  assert.ok(ev!.snippet.includes('[SUCCESS]'), '应含状态标签');
  assert.ok(ev!.snippet.includes('output_chars=3200'), '应含 output_chars');
  assert.ok(ev!.snippet.includes('_moa_v015_test_brief.md'), '应含 artifacts');
  assert.ok(ev!.snippet.includes('rationale:'), '应含 rationale');
});

test('hotfix1: action 整个对象都缺字段时（type/target/rationale 也 undefined）仍不崩溃', () => {
  // 极端情况：LLM 返回空 action 对象
  const ar = {
    action: {} as ActorActionResult['action'],
    status: 'success' as const,
    output_chars: 0,
    artifacts: [],
  };
  const ev = buildActorEvidence(ar as ActorActionResult, 1);
  assert.ok(ev, '应返回兜底 evidence');
  assert.ok(ev!.source.includes('unknown'), 'source 应含 unknown 兜底');
  assert.ok(ev!.snippet.includes('unknown'), 'snippet 应含 unknown 兜底');
});

test('hotfix1: status=skipped 时返回 undefined（不入 evidence）', () => {
  const ar: ActorActionResult = {
    action: {
      type: 'research_more',
      target: 't',
      content: 'c',
      rationale: 'r',
    },
    status: 'skipped',
    output_chars: 0,
    artifacts: [],
  };
  const ev = buildActorEvidence(ar, 1);
  assert.strictEqual(ev, undefined, 'skipped 应跳过');
});

test('hotfix1: status=failed 且 error_message 存在时，snippet 末尾追加 Error:', () => {
  const ar: ActorActionResult = {
    action: {
      type: 'execute',
      target: 't',
      // content 缺失，触发兜底路径
      rationale: 'r',
    },
    status: 'failed',
    output_chars: 0,
    error_message: 'Permission denied',
    artifacts: [],
  };
  const ev = buildActorEvidence(ar, 3);
  assert.ok(ev);
  assert.ok(ev!.snippet.includes('Error: Permission denied'), 'snippet 应含 error_message');
  assert.ok(ev!.snippet.startsWith('[FAILED]'), '应以 [FAILED] 开头');
});

test('hotfix1: artifacts 为 undefined 时不崩溃（用 (no artifacts) 兜底）', () => {
  const ar = {
    action: {
      type: 'execute' as const,
      target: 't',
      rationale: 'r',
    },
    status: 'success' as const,
    output_chars: 100,
    artifacts: undefined as unknown as string[],
  };
  const ev = buildActorEvidence(ar as ActorActionResult, 1);
  assert.ok(ev);
  assert.ok(ev!.snippet.includes('(no artifacts)'), '应用 (no artifacts) 兜底');
});

// ─────────────────────────────────────────────────────────────────────────
// 文档化场景：原始崩溃用例的回归保护
// ─────────────────────────────────────────────────────────────────────────

test('回归: 复刻 2026-07-19 实测崩溃的 actor_result.json 数据形状', () => {
  // 这是 v0.15.0 第一次实测时 iteration_002/actor_result.json 的真实结构。
  // 注意：buildActorEvidence 接受的是 executed_actions 数组里的单个元素（ActorActionResult），
  // 不是整个 ActorResult 对象。这里取 executed_actions[0] 作为输入。
  // 旧代码 (ar.action.content.length > 2000 ? ...) 在此数据上会抛：
  //   TypeError: Cannot read properties of undefined (reading 'length')
  const realWorldActorResult = {
    executed_actions: [
      {
        action: {
          type: 'execute',
          target: '在工作区根目录执行 Python 脚本生成简报',
          rationale: '多次 Recon 均遭遇终端长度截断导致数据缺失...',
        },
        status: 'success',
        output_chars: 3200,
        error_message: null,
        artifacts: ['D:\\BaiduYunDrive\\OneDrive\\实验相关文档\\AI\\_moa_v015_test_brief.md'],
      },
    ],
    self_assessment: {
      all_succeeded: true,
      missing_dependencies: [],
      should_recon: false,
      reason: '脚本成功执行...',
    },
    elapsed_sec: 81.044,
    tool_calls: 7,
  } as unknown as { executed_actions: ActorActionResult[] };

  const ar = realWorldActorResult.executed_actions[0];
  const ev = buildActorEvidence(ar, 2);
  assert.ok(ev, '真实崩溃用例必须返回 evidence（不再抛错）');
  assert.strictEqual(ev!.confidence, 'high');
  assert.ok(ev!.snippet.includes('output_chars=3200'), '应含真实 output_chars');
  assert.ok(ev!.snippet.includes('_moa_v015_test_brief.md'), '应含真实 artifact 路径');
});
