/**
 * MoA Orchestrator (v0.12.0) — Hermes-style iterative MoA loop.
 *
 * Implements the multi-round MoA loop where:
 *   - recon is delegated to #runSubagent (via main Copilot session)
 *   - workers (refs) are lightweight vscode.lm calls with NO tool schema injection
 *   - aggregator (GLM-5.2 default, user-configurable) fuses worker outputs
 *   - state persists to disk so iterations survive main-session compaction
 *
 * Three LM tools expose this loop to the main Copilot session:
 *   #moa_orchestrate  — start a new loop, returns task_id
 *   #moa_continue     — feed subagent recon results, run one iteration
 *   #moa_finalize     — force-stop and produce action items
 *
 * State directory layout:
 *   <workspace>/.moa_cache/<task_id>/
 *     state.json              — current MoaState (overwritten each step)
 *     task.txt                — original task description
 *     iteration_NNN/
 *       recon_request.json    — gaps to fill (what #runSubagent should look for)
 *       recon_result.json     — subagent result fed back via #moa_continue
 *       workers/<label>.json  — individual worker outputs
 *       aggregator.json       — aggregator synthesis + new gaps
 *     final.json              — #moa_finalize output
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as crypto from 'crypto';
import { promises as fs } from 'fs';

// ─────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────

export interface EvidenceItem {
  source: string;
  snippet: string;
  confidence: 'high' | 'medium' | 'low';
}

export interface IterationRecord {
  iteration: number;
  started_at: string;
  recon_request?: { gaps: string[]; prompt: string };
  recon_result?: { content: string; source: string };
  worker_outputs: Array<{ label: string; model: string; output: string; error?: string }>;
  aggregator_output?: AggregatorOutput;
}

export interface AggregatorOutput {
  synthesis: string;
  evidence_coverage: number;   // 0-1
  critical_gaps: string[];
  next_action: 'recon_needed' | 'finalize' | 'need_more_analysis';
}

export interface MoaState {
  task_id: string;
  task: string;
  created_at: string;
  last_update: string;
  iteration: number;
  evidence: EvidenceItem[];
  synthesis: string;
  gaps: string[];
  completeness: number;        // 0-1
  status: 'running' | 'awaiting_recon' | 'finalized' | 'error';
  history: IterationRecord[];
  error?: string;
}

export interface MoaFinalOutput {
  task_id: string;
  summary: string;
  action_items: Array<{
    type: 'write_file' | 'execute' | 'create_roadmap' | 'research_more' | 'inform_user';
    target: string;
    content: string;
    rationale: string;
  }>;
  confidence: number;
  unresolved: string[];
  iterations_used: number;
}

// ─────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────

const MAX_ITER = 12;                  // user-specified: 10-15 range, take middle
const COMPLETENESS_THRESHOLD = 0.8;   // aggregator says ≥0.8 → can finalize
const CONVERGENCE_WINDOW = 3;         // last N iterations checked for stall

// ─────────────────────────────────────────────────────────────────────────
// State persistence
// ─────────────────────────────────────────────────────────────────────────

async function getCacheRoot(): Promise<string> {
  const ws = vscode.workspace.workspaceFolders?.[0];
  if (!ws) {
    throw new Error('MoA orchestrator requires an open workspace');
  }
  const root = path.join(ws.uri.fsPath, '.moa_cache');
  await fs.mkdir(root, { recursive: true });
  // v0.14.10: 首次创建 .moa_cache/ 时同步写入 README（已存在不覆盖）
  try {
    const { ensureCacheReadme } = require('./cacheReadme');
    ensureCacheReadme(root);
  } catch {
    // 模块加载失败不阻塞主流程
  }
  return root;
}

async function getTaskDir(taskId: string): Promise<string> {
  const dir = path.join(await getCacheRoot(), taskId);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

export async function saveState(state: MoaState): Promise<void> {
  const dir = await getTaskDir(state.task_id);
  state.last_update = new Date().toISOString();
  const statePath = path.join(dir, 'state.json');
  const tmp = `${statePath}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(state, null, 2), 'utf8');
  await fs.rename(tmp, statePath);  // atomic
}

export async function loadState(taskId: string): Promise<MoaState | null> {
  try {
    const statePath = path.join(await getTaskDir(taskId), 'state.json');
    const raw = await fs.readFile(statePath, 'utf8');
    return JSON.parse(raw) as MoaState;
  } catch {
    return null;
  }
}

async function saveIterationArtifact(
  taskId: string,
  iteration: number,
  filename: string,
  data: unknown
): Promise<void> {
  const dir = path.join(await getTaskDir(taskId), `iteration_${String(iteration).padStart(3, '0')}`);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, filename), JSON.stringify(data, null, 2), 'utf8');
}

// ─────────────────────────────────────────────────────────────────────────
// Model resolution (reuses moa.refModels + moa.aggregator config)
// ─────────────────────────────────────────────────────────────────────────

interface ResolvedModel {
  model: vscode.LanguageModelChat;
  label: string;
}

async function resolveModels(): Promise<{
  workers: ResolvedModel[];
  aggregator: ResolvedModel;
}> {
  const all = await vscode.lm.selectChatModels({});
  const PLACEHOLDER = new Set(['auto', 'automatic', 'default', '']);
  const real = all.filter((m) => !PLACEHOLDER.has(m.name.toLowerCase().trim()));

  const config = vscode.workspace.getConfiguration('moa');
  const refCfg = config.get<Array<{ role: string; model: string }>>('refModels') ?? [];
  const aggCfg = config.get<{ model?: string }>('aggregator');

  const workers: ResolvedModel[] = [];
  for (const cfg of refCfg) {
    let m = real.find((x) => (x.id ?? '') === cfg.model);
    if (!m) m = real.find((x) => x.name.toLowerCase().includes(cfg.model.toLowerCase()));
    if (m) workers.push({ model: m, label: cfg.role || m.name });
  }

  if (workers.length === 0) {
    throw new Error(
      'No usable worker models. Run "Moa: Configure Models" to set moa.refModels.'
    );
  }

  let aggregator: ResolvedModel | undefined;
  if (aggCfg?.model) {
    const aggModelKey = aggCfg.model;
    let m = real.find((x) => (x.id ?? '') === aggModelKey);
    if (!m) m = real.find((x) => x.name.toLowerCase().includes(aggModelKey.toLowerCase()));
    if (m) aggregator = { model: m, label: 'aggregator' };
  }
  if (!aggregator) aggregator = { model: workers[0].model, label: 'aggregator (fallback to first worker)' };

  return { workers, aggregator };
}

// ─────────────────────────────────────────────────────────────────────────
// Worker / aggregator invocation (NO tool schema injection)
// ─────────────────────────────────────────────────────────────────────────

async function callLLM(
  model: vscode.LanguageModelChat,
  systemPrompt: string,
  userPrompt: string,
  token: vscode.CancellationToken,
  label: string
): Promise<string> {
  // @types/vscode 1.95.0 has no .System() factory — prepend system text to user.
  // This is what the rest of the codebase does (moaRunner uses only .User()).
  const messages = [
    vscode.LanguageModelChatMessage.User(systemPrompt + '\n\n---\n\n' + userPrompt),
  ];

  // CRITICAL: do NOT pass tool references here. We want clean LLM calls
  // without 149-tool schema injection. This is the Hermes MoA spirit.
  const response = await model.sendRequest(messages, {}, token);

  let collected = '';
  for await (const chunk of response.text) {
    collected += chunk;
  }
  return collected;
}

function evidenceBlock(evidence: EvidenceItem[]): string {
  if (evidence.length === 0) return '(none yet)';
  return evidence
    .map((e, i) => `${i + 1}. [${e.confidence}] ${e.source}\n   ${e.snippet}`)
    .join('\n');
}

function buildWorkerPrompt(
  task: string,
  state: MoaState,
  label: string
): { system: string; user: string } {
  const system = [
    'You are a Mixture-of-Agents worker (label: ' + label + ').',
    'You are NOT the acting agent — you cannot call tools.',
    'Your role is to analyze the task against the current evidence and surface:',
    '  - new insights the aggregator missed',
    '  - contradictions in the evidence',
    '  - specific gaps that block a confident answer',
    '',
    'Respond in JSON ONLY (no prose, no markdown fences):',
    '{',
    '  "analysis": "<3-5 bullets of your perspective>",',
    '  "new_findings": [{"source": "...", "snippet": "...", "confidence": "high|medium|low"}],',
    '  "confidence": <0-1>,',
    '  "identified_gaps": ["<specific missing info>", ...]',
    '}',
    '',
    'Match the language of the task (Chinese task → Chinese analysis).',
  ].join('\n');

  const user = [
    'TASK:',
    task,
    '',
    'CURRENT EVIDENCE (iteration ' + state.iteration + '):',
    evidenceBlock(state.evidence),
    '',
    'CURRENT SYNTHESIS (for critique):',
    state.synthesis || '(none yet — first iteration)',
    '',
    'REMAINING GAPS:',
    state.gaps.length > 0 ? state.gaps.map((g) => '- ' + g).join('\n') : '(none)',
  ].join('\n');

  return { system, user };
}

function buildAggregatorPrompt(
  task: string,
  state: MoaState,
  workerOutputs: Array<{ label: string; output: string }>
): { system: string; user: string } {
  const system = [
    'You are the MoA aggregator. Synthesize worker outputs into a coherent view.',
    'You also decide whether enough evidence has been gathered to finalize.',
    '',
    'Respond in JSON ONLY:',
    '{',
    '  "synthesis": "<coherent narrative combining worker insights>",',
    '  "evidence_coverage": <0-1, your judgment>,',
    '  "critical_gaps": ["<specific missing info that blocks confidence>", ...],',
    '  "next_action": "recon_needed" | "finalize" | "need_more_analysis"',
    '}',
    '',
    'Rules:',
    '- next_action="recon_needed": critical_gaps non-empty AND could be filled by reading files/web',
    '- next_action="finalize": critical_gaps empty OR evidence_coverage >= ' + COMPLETENESS_THRESHOLD,
    '- next_action="need_more_analysis": gaps remain but require deeper reasoning, not new data',
    '',
    'Match the language of the task.',
  ].join('\n');

  const user = [
    'TASK:',
    task,
    '',
    'WORKER OUTPUTS (iteration ' + state.iteration + '):',
    ...workerOutputs.map((w) => '--- ' + w.label + ' ---\n' + w.output),
    '',
    'CURRENT EVIDENCE:',
    evidenceBlock(state.evidence),
  ].join('\n');

  return { system, user };
}

function buildFinalPrompt(task: string, state: MoaState): { system: string; user: string } {
  const system = [
    'You are the MoA finalizer. Convert the accumulated synthesis into action items.',
    '',
    'Respond in JSON ONLY:',
    '{',
    '  "summary": "<1-paragraph final summary>",',
    '  "action_items": [',
    '    {',
    '      "type": "write_file" | "execute" | "create_roadmap" | "research_more" | "inform_user",',
    '      "target": "<file path / command / roadmap title / etc.>",',
    '      "content": "<specific content>",',
    '      "rationale": "<why this action>"',
    '    }',
    '  ],',
    '  "confidence": <0-1>,',
    '  "unresolved": ["<open questions for the user>", ...]',
    '}',
    '',
    'Action item types:',
    '- write_file: concrete file to create/overwrite (target=path, content=full text)',
    '- execute: shell command to run (target=command)',
    '- create_roadmap: high-level plan document (target=title)',
    '- research_more: follow-up investigation needed (target=topic)',
    '- inform_user: just tell the user (target=subject, content=message)',
    '',
    'Match the language of the task.',
  ].join('\n');

  const user = [
    'TASK:',
    task,
    '',
    'FINAL SYNTHESIS:',
    state.synthesis,
    '',
    'EVIDENCE GATHERED (' + state.evidence.length + ' items):',
    evidenceBlock(state.evidence.slice(-20)),
    '',
    'ITERATIONS: ' + state.iteration,
    'FINAL COMPLETENESS: ' + state.completeness,
  ].join('\n');

  return { system, user };
}

// ─────────────────────────────────────────────────────────────────────────
// JSON extraction (workers may wrap in fences despite instruction)
// ─────────────────────────────────────────────────────────────────────────

function extractJson(text: string): unknown {
  // Strip markdown fences
  let t = text.trim();
  if (t.startsWith('```')) {
    t = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  }
  // Find first { ... last }
  const first = t.indexOf('{');
  const last = t.lastIndexOf('}');
  if (first === -1 || last === -1 || last <= first) {
    throw new Error('No JSON object found in LLM response');
  }
  return JSON.parse(t.substring(first, last + 1));
}

// ─────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────

export async function createOrchestration(task: string): Promise<MoaState> {
  const taskId = 'moa_' + Date.now().toString(36) + '_' + crypto.randomBytes(3).toString('hex');
  const now = new Date().toISOString();

  const state: MoaState = {
    task_id: taskId,
    task,
    created_at: now,
    last_update: now,
    iteration: 0,
    evidence: [],
    synthesis: '',
    gaps: [],
    completeness: 0,
    status: 'awaiting_recon',
    history: [],
  };

  await saveState(state);
  const dir = await getTaskDir(taskId);
  await fs.writeFile(path.join(dir, 'task.txt'), task, 'utf8');

  return state;
}

/**
 * Run one full iteration: workers + aggregator.
 * If subagentResult is provided, it is recorded as the recon_result for this
 * iteration BEFORE workers run.
 */
export async function runIteration(
  taskId: string,
  subagentResult: { content: string; source: string } | undefined,
  token: vscode.CancellationToken,
  progress?: (msg: string) => void
): Promise<MoaState> {
  const state = await loadState(taskId);
  if (!state) throw new Error('Task not found: ' + taskId);
  if (state.status === 'finalized') {
    throw new Error('Task already finalized: ' + taskId);
  }

  state.iteration += 1;
  const iterNum = state.iteration;
  progress?.(`[MoA] starting iteration ${iterNum}`);

  const record: IterationRecord = {
    iteration: iterNum,
    started_at: new Date().toISOString(),
    worker_outputs: [],
  };

  // 1. Ingest subagent recon result (if provided)
  if (subagentResult) {
    record.recon_result = subagentResult;
    // Add to evidence as one chunk — workers/aggregator will pull specifics
    state.evidence.push({
      source: subagentResult.source || `subagent@iter${iterNum}`,
      snippet: subagentResult.content.length > 4000
        ? subagentResult.content.substring(0, 4000) + '\n...(truncated)'
        : subagentResult.content,
      confidence: 'high',
    });
    progress?.(`[MoA] ingested subagent result from ${subagentResult.source}`);
  }

  // 2. Resolve models
  const { workers, aggregator } = await resolveModels();
  progress?.(`[MoA] using ${workers.length} workers + aggregator ${aggregator.label}`);

  // 3. Run workers in parallel (NO tools injected → lightweight prompts)
  const workerPrompts = workers.map((w) => {
    const { system, user } = buildWorkerPrompt(state.task, state, w.label);
    return callLLM(w.model, system, user, token, w.label).then(
      (output) => ({ label: w.label, model: w.model.name, output, error: undefined as string | undefined }),
      (err) => ({
        label: w.label,
        model: w.model.name,
        output: '',
        error: err instanceof Error ? err.message : String(err),
      })
    );
  });
  const workerOutputs = await Promise.all(workerPrompts);
  record.worker_outputs = workerOutputs;

  // Persist worker outputs
  for (const w of workerOutputs) {
    await saveIterationArtifact(taskId, iterNum, `workers/${w.label}.json`, w);
  }
  progress?.(`[MoA] ${workerOutputs.filter((w) => !w.error).length}/${workerOutputs.length} workers succeeded`);

  // 4. Run aggregator
  const successfulOutputs = workerOutputs.filter((w) => !w.error && w.output);
  if (successfulOutputs.length === 0) {
    state.status = 'error';
    state.error = 'All workers failed in iteration ' + iterNum;
    state.history.push(record);
    await saveState(state);
    return state;
  }

  const { system: aggSys, user: aggUser } = buildAggregatorPrompt(
    state.task,
    state,
    successfulOutputs.map((w) => ({ label: w.label, output: w.output }))
  );

  let aggOutput: AggregatorOutput;
  try {
    const aggRaw = await callLLM(aggregator.model, aggSys, aggUser, token, 'aggregator');
    aggOutput = extractJson(aggRaw) as AggregatorOutput;
    record.aggregator_output = aggOutput;
    await saveIterationArtifact(taskId, iterNum, 'aggregator.json', aggOutput);
  } catch (err) {
    state.status = 'error';
    state.error = `Aggregator failed in iteration ${iterNum}: ${err instanceof Error ? err.message : String(err)}`;
    state.history.push(record);
    await saveState(state);
    return state;
  }

  // 5. Update state from aggregator
  state.synthesis = aggOutput.synthesis;
  state.completeness = aggOutput.evidence_coverage;
  state.gaps = aggOutput.critical_gaps;

  // 6. Extract new evidence from worker findings
  for (const w of workerOutputs) {
    if (w.error || !w.output) continue;
    try {
      const parsed = extractJson(w.output) as { new_findings?: EvidenceItem[] };
      if (Array.isArray(parsed.new_findings)) {
        for (const f of parsed.new_findings.slice(0, 3)) {
          if (f.source && f.snippet) {
            state.evidence.push({
              source: f.source,
              snippet: f.snippet,
              confidence: f.confidence || 'medium',
            });
          }
        }
      }
    } catch {
      // worker output not parseable — skip extraction, the raw text still in record
    }
  }

  // 7. Decide next status
  if (shouldStop(state)) {
    state.status = 'finalized';
    progress?.(`[MoA] converged at iteration ${iterNum}, completeness=${state.completeness.toFixed(2)}`);
  } else if (aggOutput.next_action === 'recon_needed' && state.gaps.length > 0) {
    state.status = 'awaiting_recon';
    // Build recon request for main session to feed #runSubagent
    record.recon_request = {
      gaps: state.gaps,
      prompt: buildReconPrompt(state),
    };
    await saveIterationArtifact(taskId, iterNum, 'recon_request.json', record.recon_request);
    progress?.(`[MoA] iteration ${iterNum} needs recon for ${state.gaps.length} gap(s)`);
  } else {
    state.status = 'running';
    progress?.(`[MoA] iteration ${iterNum} complete, continuing without new recon`);
  }

  state.history.push(record);
  await saveState(state);
  return state;
}

function buildReconPrompt(state: MoaState): string {
  return [
    'You are a MoA recon subagent.',
    '',
    'Task context:',
    state.task,
    '',
    'The aggregator has identified the following gaps that must be filled:',
    ...state.gaps.map((g, i) => `${i + 1}. ${g}`),
    '',
    'For each gap, gather concrete evidence (read files, search code, fetch URLs, etc.).',
    'Return a single Markdown block with your findings, including source paths.',
  ].join('\n');
}

function shouldStop(state: MoaState): boolean {
  if (state.iteration >= MAX_ITER) return true;
  if (state.completeness >= COMPLETENESS_THRESHOLD && state.gaps.length === 0) return true;

  // Convergence detection: last N iterations show no completeness growth
  const tail = state.history.slice(-CONVERGENCE_WINDOW);
  if (tail.length === CONVERGENCE_WINDOW) {
    const aggOutputs = tail
      .map((r) => r.aggregator_output?.evidence_coverage ?? 0);
    const allEqual = aggOutputs.every((v) => v === aggOutputs[0]);
    const noGapsChange = tail.every((r) => {
      const gapsLen = r.aggregator_output?.critical_gaps?.length ?? 0;
      return gapsLen === (tail[0].aggregator_output?.critical_gaps?.length ?? 0);
    });
    if (allEqual && noGapsChange) return true;
  }

  return false;
}

export async function finalizeTask(
  taskId: string,
  token: vscode.CancellationToken
): Promise<MoaFinalOutput> {
  const state = await loadState(taskId);
  if (!state) throw new Error('Task not found: ' + taskId);

  const { aggregator } = await resolveModels();
  const { system, user } = buildFinalPrompt(state.task, state);
  const raw = await callLLM(aggregator.model, system, user, token, 'finalizer');

  let parsed: Partial<MoaFinalOutput>;
  try {
    parsed = extractJson(raw) as Partial<MoaFinalOutput>;
  } catch {
    parsed = {
      summary: raw,
      action_items: [],
      confidence: state.completeness,
      unresolved: state.gaps,
    };
  }

  const output: MoaFinalOutput = {
    task_id: taskId,
    summary: parsed.summary || '(no summary produced)',
    action_items: Array.isArray(parsed.action_items) ? parsed.action_items : [],
    confidence: parsed.confidence ?? state.completeness,
    unresolved: Array.isArray(parsed.unresolved) ? parsed.unresolved : state.gaps,
    iterations_used: state.iteration,
  };

  state.status = 'finalized';
  state.history = state.history;  // unchanged
  await saveState(state);

  const dir = await getTaskDir(taskId);
  await fs.writeFile(path.join(dir, 'final.json'), JSON.stringify(output, null, 2), 'utf8');

  return output;
}

// ─────────────────────────────────────────────────────────────────────────
// Status reporting for tool results
// ─────────────────────────────────────────────────────────────────────────

export function formatStatusMarkdown(state: MoaState): string {
  const lines: string[] = [
    `### MoA Task \`${state.task_id}\``,
    '',
    `**Status:** ${state.status}  `,
    `**Iteration:** ${state.iteration}/${MAX_ITER}  `,
    `**Completeness:** ${(state.completeness * 100).toFixed(0)}%  `,
    `**Evidence items:** ${state.evidence.length}  `,
    '',
  ];

  if (state.synthesis) {
    lines.push('#### Current synthesis');
    lines.push('');
    lines.push('> ' + state.synthesis.replace(/\n/g, '\n> '));
    lines.push('');
  }

  if (state.gaps.length > 0) {
    lines.push('#### Open gaps');
    lines.push('');
    for (const g of state.gaps) lines.push(`- ${g}`);
    lines.push('');
  }

  if (state.status === 'awaiting_recon') {
    const lastIter = state.history[state.history.length - 1];
    if (lastIter?.recon_request) {
      lines.push('#### Recon needed');
      lines.push('');
      lines.push('Call `#runSubagent` with this prompt, then feed the result back via `#moa_continue`:');
      lines.push('');
      lines.push('```');
      lines.push(lastIter.recon_request.prompt);
      lines.push('```');
      lines.push('');
    }
  }

  if (state.status === 'finalized' || shouldStop(state)) {
    lines.push('Call `#moa_finalize` to produce action items.');
    lines.push('');
  }

  if (state.error) {
    lines.push(`**Error:** ${state.error}`);
    lines.push('');
  }

  return lines.join('\n');
}
