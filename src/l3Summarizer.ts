/**
 * L3 Summarizer —— MoA 第三层级"孙代理"（v0.13.0）
 *
 * 设计动机
 * --------
 * 当 recon agent 读到超大文件（默认 > 30KB）时，简单机械截断会砍断函数 /
 * 类定义 / 关键代码块，导致下游 refs 看到残缺内容。
 *
 * 解法：派一个轻量 LLM（默认 MiniMax-M3）作为"第三层级 subagent"，
 * 让它读全文 + 用户问题，返回 ≤10KB 的精选片段（保留代码块完整性）。
 *
 * 为什么是"第三层级"
 * ------------------
 * 按 CLAUDE.md §2.4 两层嵌套规则：
 *   - 主会话 LLM = 第 0 层
 *   - MoA recon agent = 第 1 层（被主会话调起）
 *   - L3 Summarizer = 第 2 层（被 recon 调起）
 * 部分语境下也算"第 3 层"（按用户原始叫法"孙代理"）。
 * 固定用 MiniMax-M3 (TokenPlan)，因为：
 *   1. 成本极低（每次约 5000 token）
 *   2. 长上下文友好（1M context window）
 *   3. CLAUDE.md §2.4 规定两层嵌套强制 M3
 *
 * 缓存策略
 * --------
 * 同一文件 + 同一用户问题在单次 MoA 任务内只摘要一次。
 * 缓存写到 `<workspace>/.moa_cache/l3_summaries/<sha1>.txt`，
 * key = sha1(filePath + fileSize + userPrompt)。
 *
 * 失败 fallback
 * ------------
 * M3 不可用 / 调用失败 / 输出异常 → 退回 L2 语义边界截断（见 moaRunner.ts）。
 * 不阻塞主流水线。
 */

import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as path from 'path';
import * as fs from 'fs';

/**
 * L3 孙代理调用参数。
 */
export interface L3SummarizeOptions {
  /** 待摘要的文件绝对路径（用于缓存 key + 返回时标注来源） */
  filePath: string;
  /** 文件全文内容 */
  fullContent: string;
  /** 用户的原始问题（用于判断哪些片段相关） */
  userPrompt: string;
  /** ChatRequest 的 toolInvocationToken（如需走工具调用路径） */
  toolInvocationToken?: vscode.ChatParticipantToolToken;
  /** 可选：覆盖默认模型（默认 MiniMax-M3） */
  modelId?: string;
  /** 可选：覆盖目标输出长度（默认 10000 字符） */
  targetChars?: number;
}

/**
 * L3 孙代理调用结果。
 */
export interface L3SummarizeResult {
  /** 精选后的内容（保留代码块完整性，≤ targetChars） */
  summary: string;
  /** 摘要来源标记 */
  source: string;
  /** 是否命中缓存 */
  fromCache: boolean;
  /** 调用耗时（毫秒，不含缓存命中） */
  elapsedMs: number;
}

/** 默认目标输出长度（字符）。
 * v0.14.4: 从 10k 提升到 50k —— 1M 上下文模型完全能消化，避免过度压缩。
 * 仅作为 fallback，实际优先读 moa.reconL3TargetChars 配置。 */
const DEFAULT_TARGET_CHARS = 50000;

/**
 * 计算 L3 缓存 key（filePath + fileSize + userPrompt 的 SHA1）。
 * 不把 mtime 放入 key —— 假设同一任务内文件不变。
 */
function computeCacheKey(filePath: string, fullContent: string, userPrompt: string): string {
  const hash = crypto.createHash('sha1');
  hash.update(filePath);
  hash.update('|');
  hash.update(String(fullContent.length));
  hash.update('|');
  // 用 userPrompt 前 200 字符参与 key，避免 prompt 微调导致频繁失效
  hash.update(userPrompt.substring(0, 200));
  return hash.digest('hex');
}

/**
 * 取得缓存目录路径：<workspace>/.moa_cache/l3_summaries/
 * 如果 workspace 不可用，退回 os.tmpdir()。
 *
 * v0.14.10: 创建 .moa_cache/ 时顺便写入 README.md（仅首次，已存在不覆盖）。
 */
function getCacheDir(): string {
  const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const base = ws ?? require('os').tmpdir();
  const cacheRoot = path.join(base, '.moa_cache');
  const dir = path.join(cacheRoot, 'l3_summaries');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    // v0.14.10: 首次创建 .moa_cache/ 时同步写入 README
    if (ws) {
      try {
        const { ensureCacheReadme } = require('./cacheReadme');
        ensureCacheReadme(cacheRoot);
      } catch {
        // cacheReadme 模块加载失败不阻塞主流程
      }
    }
  }
  return dir;
}

/**
 * 读缓存（如存在）。
 */
function readCache(key: string): string | null {
  try {
    const cachePath = path.join(getCacheDir(), `${key}.txt`);
    if (fs.existsSync(cachePath)) {
      return fs.readFileSync(cachePath, 'utf8');
    }
  } catch {
    // 缓存读失败不阻塞主流程
  }
  return null;
}

/**
 * 写缓存（best-effort）。
 */
function writeCache(key: string, content: string): void {
  try {
    const cachePath = path.join(getCacheDir(), `${key}.txt`);
    fs.writeFileSync(cachePath, content, 'utf8');
  } catch {
    // 写失败不影响主流程
  }
}

/**
 * 构造 L3 孙代理的 prompt。
 *
 * 设计要点：
 *   - 明确角色（精选器，不是分析器）
 *   - 输出必须是原文片段（不要总结/改写）
 *   - 保留代码块/函数完整性
 *   - 不写死工具名 / 不依赖外部能力
 */
function buildL3Prompt(opts: L3SummarizeOptions): string {
  const target = opts.targetChars ?? DEFAULT_TARGET_CHARS;
  return [
    '你是 MoA 流水线的第三层级"文件精选器"（L3 Summarizer）。',
    '',
    '## 任务',
    `下面是一个 ${opts.fullContent.length} 字符的大文件，针对用户问题，从中提取最相关的片段（≤ ${target} 字符）。`,
    '',
    '## 严格要求',
    '  1. 输出必须是**原文片段**，不要总结、不要改写、不要翻译。',
    '  2. 保留代码块、函数定义、类定义、关键注释的完整性。',
    '  3. 如果某函数过长，可以只取关键部分（如签名 + 前几行 + return 语句），用 `// ... 已省略 ...` 标注。',
    '  4. 每个片段前用 `// === 来自第 N 行附近 ===` 标注大致位置。',
    '  5. 如果文件明显与用户问题无关，输出 `[NOT_RELEVANT]`。',
    '  6. 优先保留：函数定义、类型定义、配置、错误处理；跳过：长字符串字面量、测试 fixture、注释块。',
    '',
    '## 用户问题',
    opts.userPrompt,
    '',
    `## 文件路径：${opts.filePath}`,
    '',
    '## 文件内容',
    '```',
    opts.fullContent,
    '```',
  ].join('\n');
}

/**
 * 调用 L3 孙代理。
 *
 * 主入口：先查缓存，命中则直接返回；否则调用配置的 L3 模型，结果写缓存。
 *
 * v0.14.0: 模型从 `moa.l3Summarizer.model` 配置项读取，不再硬编码。
 *   - 配置为空字符串 → 完全禁用 L3（直接返回 null，调用方 fallback 到 L2）
 *   - 配置了具体模型 → 用该模型
 *   - 配置的模型不可用 → 返回 null（fallback 到 L2）
 *
 * 失败时（模型不可用 / 超时 / 输出异常）返回 null，由调用方 fallback 到 L2。
 *
 * @throws 不抛异常 —— 所有错误都捕获后返回 null。
 */
export async function l3Summarize(opts: L3SummarizeOptions): Promise<L3SummarizeResult | null> {
  // v0.14.3: target 优先级：opts > moa.reconL3TargetChars 配置 > DEFAULT_TARGET_CHARS 兜底
  const config = vscode.workspace.getConfiguration('moa');
  const configuredTarget = config.get<number>('reconL3TargetChars');
  const target = opts.targetChars ?? configuredTarget ?? DEFAULT_TARGET_CHARS;

  // v0.14.0: 从配置读取模型 ID（opts.modelId 优先，否则读 moa.l3Summarizer.model）
  let modelId = opts.modelId;
  if (!modelId) {
    const l3Cfg = config.get<{ model?: string }>('l3Summarizer');
    modelId = l3Cfg?.model ?? '';
  }

  // 空配置 = 禁用 L3
  if (!modelId || modelId.trim().length === 0) {
    return null;
  }

  // 1. 查缓存
  const cacheKey = computeCacheKey(opts.filePath, opts.fullContent, opts.userPrompt);
  const cached = readCache(cacheKey);
  if (cached) {
    return {
      summary: cached,
      source: `L3 (cached): ${opts.filePath}`,
      fromCache: true,
      elapsedMs: 0,
    };
  }

  // 2. 拉模型 —— 用 selectChatModels 找匹配的，取第一个
  //    modelId 可能是完整 ID（vendor:::model 形式）或子串
  let model: vscode.LanguageModelChat | undefined;
  try {
    const candidates = await vscode.lm.selectChatModels({});
    // 优先精确匹配 id，其次子串匹配 name/id
    model = candidates.find((m) => m.id === modelId)
      ?? candidates.find((m) => m.id.includes(modelId!) || m.name.includes(modelId!));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[L3] selectChatModels 失败: ${msg}`);
    return null;
  }

  if (!model) {
    console.warn(`[L3] 未找到匹配模型: ${modelId}`);
    return null;
  }

  // 3. 调用
  const startMs = Date.now();
  try {
    const messages: vscode.LanguageModelChatMessage[] = [
      vscode.LanguageModelChatMessage.User(buildL3Prompt(opts)),
    ];

    const response = await model.sendRequest(messages, {}, new vscode.CancellationTokenSource().token);
    let output = '';
    for await (const frag of response.text) {
      output += frag;
    }

    // 4. 校验输出
    if (!output || output.trim().length === 0) {
      console.warn(`[L3] M3 返回空内容`);
      return null;
    }

    // 如果输出明显超长（M3 没遵守 target 限制），做一次硬截断
    if (output.length > target * 1.5) {
      output = output.substring(0, target) + '\n// ... (L3 输出超长，已截断) ...';
    }

    // 5. 写缓存
    writeCache(cacheKey, output);

    return {
      summary: output,
      source: `L3 (MiniMax-M3): ${opts.filePath}`,
      fromCache: false,
      elapsedMs: Date.now() - startMs,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[L3] sendRequest 失败: ${msg}`);
    return null;
  }
}

/**
 * 判断是否应该触发 L3（避免无脑触发小文件）。
 *
 * 触发条件：
 *   - 内容长度 > threshold（默认 30000）
 *   - 文件扩展名是代码类（.ts/.js/.py/.go/.rs/.java/.cpp/.c/.rb/.php/.swift/.kt）
 *   - 不在 node_modules / .min. 等依赖/压缩路径
 */
export function shouldTriggerL3(
  filePath: string,
  fullContentLength: number,
  threshold: number = 30000
): boolean {
  if (fullContentLength <= threshold) return false;

  const codeExtensions = [
    '.ts', '.js', '.tsx', '.jsx', '.py', '.go', '.rs', '.java',
    '.cpp', '.c', '.h', '.hpp', '.rb', '.php', '.swift', '.kt',
    '.scala', '.clj', '.ex', '.exs', '.ml', '.fs', '.vue', '.svelte',
  ];
  const ext = path.extname(filePath).toLowerCase();
  if (!codeExtensions.includes(ext)) return false;

  // 排除依赖与压缩文件
  if (filePath.includes('node_modules')) return false;
  if (filePath.includes('.min.')) return false;
  if (filePath.includes('/dist/')) return false;
  if (filePath.includes('/build/')) return false;

  return true;
}
