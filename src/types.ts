/**
 * Type definitions for MoA Bridge chat participant.
 */

import type { ChatParticipantToolToken } from 'vscode';

/**
 * Execution path for MoA workflow.
 *
 * - P1: Native subagent simulation (no Hermes needed; uses vscode.lm)
 * - P2a: ACP protocol to Hermes (needs formulahendry.acp-client)
 * - P2b: Wrapper script call to Hermes (needs Hermes CLI installed)
 */
export type MoaPath = 'P1' | 'P2a' | 'P2b' | 'unknown';

/**
 * Result of path detection (capability scan).
 */
export interface PathDetection {
  /** Detected path (best-effort). */
  path: MoaPath;
  /** Workspace root where moa-bridge scripts live. */
  workspaceRoot: string;
  /** Absolute path to moa-bridge scripts directory. */
  scriptsDir: string;
  /** Absolute path to presets directory. */
  presetsDir: string;
  /** Whether Detect-Capabilities.ps1 reported capability info. */
  capabilities: Record<string, boolean>;
}

/**
 * Parsed prompt — supports `preset=<name> ...` prefix.
 */
export interface ParsedPrompt {
  /** Preset name (without extension), e.g. "default" / "fast" / "academic". */
  presetName: string;
  /** Remaining prompt after stripping preset prefix. */
  userPrompt: string;
  /** Slash command name (e.g. "preset", "help"), or empty string. */
  command: string;
}

/**
 * Result of running MoA wrapper (P2b).
 */
export interface MoaRunResult {
  /** Final aggregated output (Markdown). */
  output: string;
  /** Wall-clock elapsed seconds. */
  elapsed: number;
  /** Path that was actually used. */
  path: MoaPath;
  /** Resolved preset name. */
  preset: string;
}

/**
 * Lightweight structured prompt for vscode.lm.
 */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * Re-export helper to keep imports tidy in other files.
 */
export type { ChatParticipantToolToken };