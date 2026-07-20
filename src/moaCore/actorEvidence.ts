/**
 * v0.15.0 hotfix 1: Actor evidence 提取纯函数。
 *
 * 抽到独立文件是为了能在不 mock vscode 的情况下进行单元测试
 * （moaOrchestrator.ts 顶部 `import * as vscode` 无法在 Node test env 直接 import）。
 *
 * 背景：Actor LLM 经常不回填 action.content 字段（只回 type/target/rationale），
 * 直接访问 ar.action.content.length 会抛
 *   "Cannot read properties of undefined (reading 'length')"
 * 导致 state.history.push 不执行、state.json 不更新、timeline.md 漏写本轮。
 */

import type { ActorActionResult } from './roles';

/**
 * Evidence item 的最小结构（与 moaOrchestrator.EvidenceItem 保持字段一致，
 * 这里独立定义避免反向依赖 orchestrator）。
 */
export interface ActorEvidenceItem {
  source: string;
  snippet: string;
  confidence: 'high' | 'medium' | 'low';
}

/**
 * 把单个 ActorActionResult 转为 evidence item。
 *
 * @param ar - Actor 单个 action 的执行结果
 * @param iterNum - 当前迭代号
 * @returns EvidenceItem（status=success/failed 时），或 undefined（status=skipped 时跳过）
 */
export function buildActorEvidence(
  ar: ActorActionResult,
  iterNum: number,
): ActorEvidenceItem | undefined {
  if (ar.status !== 'success' && ar.status !== 'failed') return undefined;

  // 优先用 action.content（如果有），否则用 artifacts/output_chars/rationale 构造兜底 snippet
  const rawContent = ar.action?.content;
  let snippet: string;
  if (typeof rawContent === 'string' && rawContent.length > 0) {
    snippet = rawContent.length > 2000
      ? rawContent.substring(0, 2000) + '\n...(truncated)'
      : rawContent;
  } else {
    // 兜底：用 artifacts + output_chars + rationale 构造
    const arts = Array.isArray(ar.artifacts) && ar.artifacts.length > 0
      ? ar.artifacts.join(', ')
      : '(no artifacts)';
    snippet = `[${ar.status.toUpperCase()}] ${ar.action?.type ?? 'unknown'} → ${ar.action?.target ?? '?'}`
      + ` | output_chars=${ar.output_chars ?? 0} | artifacts: ${arts}`
      + ` | rationale: ${ar.action?.rationale ?? ''}`;
  }
  if (ar.error_message) snippet += `\nError: ${ar.error_message}`;

  return {
    source: `actor@iter${iterNum}:${ar.action?.type ?? 'unknown'}:${ar.action?.target ?? '?'}`,
    snippet,
    confidence: 'high',
  };
}
