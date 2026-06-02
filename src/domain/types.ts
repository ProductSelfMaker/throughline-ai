export interface ParsedSpec {
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

/** A batch of new agent activity since the last checkpoint. */
export interface ActivityBatch {
  /** Scribe-ready excerpt: "사용자: …" / "AI: …" / "[도구] name target" lines. */
  excerpt: string;
  /** session file (absolute path) -> new byte offset to persist. */
  advanced: Record<string, number>;
}

/** One work session, summarized for the history view. */
export interface SessionSummary {
  id: string;
  title: string;
  time: number; // last-activity epoch ms
  messages: number;
  tools: number;
  tokens: number;
}

/** Aggregate token usage for the tokens view. */
export interface TokenStats {
  total: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
  turns: number;
  tools: number;
  perDay: { date: string; total: number }[];
}

/** Derived analytics over recent session logs (history + tokens views). */
export interface Analytics {
  tokens: TokenStats;
  history: SessionSummary[];
  approx: boolean; // true if the byte budget truncated the scan
}

/** Reads new agent activity for a project and watches for more. */
export interface ActivityReader {
  readNew(checkpoint: Record<string, number>): Promise<ActivityBatch>;
  /** Current byte offsets (EOF) of all sources — used to start observing from "now". */
  currentOffsets(): Promise<Record<string, number>>;
  /** Recent activity (last `days`, capped to `maxChars`) — used for a full rebuild. */
  readRecent(days: number, maxChars: number): Promise<string>;
  /** Derived analytics (history + tokens) over recent logs, byte-bounded. */
  analyze(days: number, maxBytes: number): Promise<Analytics>;
  watch(onActivity: () => void): () => void;
}

export interface AgentRunner {
  /** One-shot: given the current spec + transcript, returns the full updated spec markdown. */
  scribe(
    currentSpecMarkdown: string,
    transcript: Message[],
    signal?: AbortSignal,
  ): Promise<string>;
  /** Generic one-shot completion for a prompt (sync, curation, flow). */
  complete(prompt: string, signal?: AbortSignal): Promise<string>;
}

/** The living PRODUCT doc — a user-facing explanation of the service, organized by
 *  feature/page. `## 개요` (what the service is, for whom) and `## 열린 질문` are always
 *  present; each feature grows its own `## <name>` section (무엇 / 동작·정책 / 요소 / 상태).
 *  This is NOT a work log — that lives in history. */
export const OVERVIEW_HEADING = '## 개요';
export const OPEN_QUESTIONS_HEADING = '## 열린 질문';
export const SPINE_HEADINGS = [OVERVIEW_HEADING, OPEN_QUESTIONS_HEADING] as const;

/** Scaffold used when no doc exists yet — an empty product-doc skeleton. */
export const DEFAULT_SPEC = `---
title: Untitled
updated:
---

## 개요

## 열린 질문
`;
