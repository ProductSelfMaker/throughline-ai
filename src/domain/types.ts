export interface FeatureItem {
  id: string;
  text: string;
  done: boolean;
}

export interface ParsedSpec {
  features: FeatureItem[];
  openQuestions: string[];
  headings: string[];
}

export interface Message {
  role: 'user' | 'assistant';
  content: string;
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

export interface ScribeResult {
  md: string;
  changedLines: number[];
}

export type ChatEvent =
  | { type: 'text'; text: string }
  | { type: 'tool'; name: string; target: string };

/** A batch of new agent activity since the last checkpoint. */
export interface ActivityBatch {
  /** Scribe-ready excerpt: "사용자: …" / "AI: …" / "[도구] name target" lines. */
  excerpt: string;
  /** session file (absolute path) -> new byte offset to persist. */
  advanced: Record<string, number>;
}

/** Reads new agent activity for a project and watches for more. */
export interface ActivityReader {
  readNew(checkpoint: Record<string, number>): Promise<ActivityBatch>;
  watch(onActivity: () => void): () => void;
}

export interface AgentRunner {
  /** Drives the user's Claude Code; streams text deltas and tool-use events; resolves with the full assistant text. */
  converse(
    transcript: Message[],
    onEvent: (e: ChatEvent) => void,
    signal?: AbortSignal,
  ): Promise<string>;
  /** One-shot: given the current spec + transcript, returns the full updated spec markdown. */
  scribe(
    currentSpecMarkdown: string,
    transcript: Message[],
    signal?: AbortSignal,
  ): Promise<string>;
  /** Generic one-shot completion for a prompt (used for derived artifacts like the user-flow diagram). */
  complete(prompt: string, signal?: AbortSignal): Promise<string>;
}

/** PRD spine sections. A lean, always-present backbone; the scribe grows other
 *  `## <topic>` sections freely beneath it. Missing ones are self-healed (not
 *  rejected) on update — see ensureSpine. */
export const OVERVIEW_HEADING = '## 📌 개요';
export const GOALS_HEADING = '## 🎯 목표';
export const REQUIREMENTS_HEADING = '## ✅ 기능 요구사항';
export const OPEN_QUESTIONS_HEADING = '## ❓ 미해결 질문';

export const SPINE_HEADINGS = [
  OVERVIEW_HEADING,
  GOALS_HEADING,
  REQUIREMENTS_HEADING,
  OPEN_QUESTIONS_HEADING,
] as const;

/** Scaffold used when no spec.md exists yet — an empty PRD skeleton. */
export const DEFAULT_SPEC = `---
title: Untitled
updated:
---

${OVERVIEW_HEADING}

${GOALS_HEADING}

${REQUIREMENTS_HEADING}

${OPEN_QUESTIONS_HEADING}
`;
