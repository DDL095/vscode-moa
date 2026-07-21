/**
 * v0.22.0 P0-10: final.md 分级内嵌展示
 *
 * 设计目标（docs/roadmap/v0.22.0-role-injection-overhaul.md §P0-10）：
 *   - 修改 moaHandler.ts 的 ChatRequestHandler 退出逻辑
 *   - 分级展示：
 *     * < 2000 字符：完整内嵌（full）
 *     * 2000-8000：摘要 + 关键信息（summary）
 *     * > 8000：结构化摘要（TL;DR + 关键发现 top 5 + action_items 表）
 *   - 配置：moa.finalMdInlineDisplay（full / summary / structured-summary / off，默认 structured-summary）
 *   - 目的：关键信息进上下文，下一轮对话不必多轮调取工具
 */

import * as vscode from 'vscode';

// ═════════════════════════════════════════════════════════════════════════
// 配置
// ═════════════════════════════════════════════════════════════════════════

export type FinalMdDisplayMode = 'full' | 'summary' | 'structured-summary' | 'off';

/** 默认阈值（可通过 moa.finalMdInlineThresholds 覆盖）。 */
const DEFAULT_FULL_THRESHOLD = 2000;
const DEFAULT_SUMMARY_THRESHOLD = 8000;

interface Thresholds {
  /** < this: 完整内嵌 */
  full: number;
  /** < this: 摘要 + 关键信息；>= this: 结构化摘要 */
  summary: number;
}

export function getFinalMdThresholds(): Thresholds {
  const cfg = vscode.workspace.getConfiguration('moa');
  const raw = cfg.get<{ full?: number; summary?: number }>('finalMdInlineThresholds');
  return {
    full: raw?.full ?? DEFAULT_FULL_THRESHOLD,
    summary: raw?.summary ?? DEFAULT_SUMMARY_THRESHOLD,
  };
}

export function getFinalMdDisplayMode(): FinalMdDisplayMode {
  const cfg = vscode.workspace.getConfiguration('moa');
  const raw = cfg.get<string>('finalMdInlineDisplay') ?? 'structured-summary';
  if (raw === 'full' || raw === 'summary' || raw === 'structured-summary' || raw === 'off') {
    return raw;
  }
  return 'structured-summary';
}

// ═════════════════════════════════════════════════════════════════════════
// 关键信息提取（用于 summary / structured-summary 模式）
// ═════════════════════════════════════════════════════════════════════════

/** 提取 TL;DR（首个 # / ## 标题 + 其下首段）。 */
export function extractTldr(finalMd: string): string {
  const lines = finalMd.split('\n');
  let inFirstSection = false;
  let collected: string[] = [];
  for (const line of lines) {
    if (/^#\s/.test(line) || /^##\s/.test(line)) {
      if (inFirstSection) break;
      inFirstSection = true;
      collected.push(line);
      continue;
    }
    if (inFirstSection) {
      if (line.trim() === '' && collected.length > 1) break;
      collected.push(line);
    }
  }
  return collected.join('\n').trim();
}

/** 提取 "关键发现 top 5"：扫描以 - 开头的要点行，取前 5 条非空、非注释。 */
export function extractKeyFindings(finalMd: string, topN = 5): string[] {
  const lines = finalMd.split('\n');
  const findings: string[] = [];
  for (const line of lines) {
    const m = line.match(/^[\s]*[-*]\s+(.+)/);
    if (m) {
      const text = m[1].trim();
      if (text.length > 10 && !text.startsWith('//')) {
        findings.push(text);
        if (findings.length >= topN) break;
      }
    }
  }
  return findings;
}

export interface ActionItem {
  type: string;
  target: string;
  detail?: string;
}

/** 解析 action_items 表格或列表。 */
export function extractActionItems(finalMd: string): ActionItem[] {
  const items: ActionItem[] = [];
  const lines = finalMd.split('\n');
  // 模式 1: markdown table
  // | type | target | detail |
  let inTable = false;
  for (const line of lines) {
    if (/^\|\s*\[?[a-z_]+\]?\|/i.test(line)) {
      const cells = line.split('|').map((c) => c.trim()).filter(Boolean);
      if (cells.length >= 2) {
        items.push({ type: cells[0], target: cells[1], detail: cells[2] });
      }
      inTable = true;
    } else if (inTable && line.trim() && !line.startsWith('|')) {
      inTable = false;
    }
  }
  if (items.length > 0) return items;

  // 模式 2: 列表
  for (const line of lines) {
    const m = line.match(/^[\s]*[-*]\s+\[([a-z_]+)\]\s+(.+)/i);
    if (m) {
      items.push({ type: m[1], target: m[2] });
      if (items.length >= 10) break;
    }
  }
  return items;
}

// ═════════════════════════════════════════════════════════════════════════
// 分级渲染
// ═════════════════════════════════════════════════════════════════════════

/**
 * 根据 final.md 长度 + 用户配置，返回适合注入 chat 的 Markdown。
 *
 * @param finalMd  完整的 final.md 内容（已从 .moa_cache/<task>/ 读取）
 * @param taskId   task_id（用于兜底提示）
 */
export function renderFinalMdForInline(finalMd: string, taskId: string): string {
  const mode = getFinalMdDisplayMode();
  if (mode === 'off') {
    return `\n\n> 📄 完整报告已落盘到 \`.moa_cache/${taskId}/final.md\`（${finalMd.length} 字符）。使用 \`.moa.finalMdInlineDisplay\` 切换展示模式。`;
  }

  const thresholds = getFinalMdThresholds();

  // Mode: full 且字符数 < full 阈值 → 完整内嵌
  if (mode === 'full' && finalMd.length < thresholds.full) {
    return `\n\n<details><summary>📄 final.md (${finalMd.length} 字符)</summary>\n\n${finalMd}\n\n</details>`;
  }

  // Mode: summary / structured-summary / full 超阈值 → 摘要
  if (finalMd.length < thresholds.summary) {
    // 2000-8000 区间 → summary 模式
    const tldr = extractTldr(finalMd);
    const findings = extractKeyFindings(finalMd, 3);
    let md = `\n\n## 📄 final.md 摘要 (${finalMd.length} 字符)\n\n`;
    if (tldr) {
      md += `### TL;DR\n${tldr}\n\n`;
    }
    if (findings.length > 0) {
      md += `### 关键发现\n`;
      findings.forEach((f) => (md += `- ${f}\n`));
      md += '\n';
    }
    md += `> 完整报告：\`.moa_cache/${taskId}/final.md\``;
    return md;
  }

  // > 8000 → structured-summary
  const tldr = extractTldr(finalMd);
  const findings = extractKeyFindings(finalMd, 5);
  const actions = extractActionItems(finalMd);
  let md = `\n\n## 📄 final.md 结构化摘要 (${finalMd.length} 字符)\n\n`;
  if (tldr) {
    md += `### TL;DR\n${tldr}\n\n`;
  }
  if (findings.length > 0) {
    md += `### 关键发现 top ${findings.length}\n`;
    findings.forEach((f, i) => (md += `${i + 1}. ${f}\n`));
    md += '\n';
  }
  if (actions.length > 0) {
    md += `### Action Items\n\n`;
    md += `| type | target |\n|---|---|\n`;
    actions.slice(0, 8).forEach((a) => (md += `| ${a.type} | ${a.target} |\n`));
    md += '\n';
  }
  md += `---\n> 完整报告：\`.moa_cache/${taskId}/final.md\`\n`;
  return md;
}
