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

/** One work item = a single user turn (a prompt and the work until the next prompt).
 *  Carries the JSONL byte range so its detail can be fetched on demand. */
export interface WorkItem {
  id: string;     // `${file}:${start}-${end}`
  file: string;   // session basename (no .jsonl)
  start: number;  // byte offset, inclusive
  end: number;    // byte offset, exclusive
  title: string;  // the user's prompt (clipped)
  time: number;   // epoch ms
  tools: number;  // tool calls within the turn
  tokens: number; // tokens within the turn
}

/** One message inside a work item's detail. */
export interface WorkMessage {
  role: 'user' | 'assistant';
  text: string;
  tools: { name: string; target: string }[];
}

/** Full conversation + work for a single work item. */
export interface WorkItemDetail {
  title: string;
  time: number;
  tokens: number;
  filesTouched: string[];
  messages: WorkMessage[];
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
  /** The most recent `limit` work items (user turns), newest first. */
  listWorkItems(limit: number): Promise<WorkItem[]>;
  /** Full conversation/work for one work item (bounded by its byte range). */
  readWorkItem(file: string, start: number, end: number): Promise<WorkItemDetail | null>;
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
 *  feature/page. The structural spine `## Overview` and `## Open Questions` is always
 *  present (English — the service's structural language); each feature grows its own
 *  `## <name>` section. Section names and prose are written in the user's own
 *  working language. This is NOT a work log — that lives in history. */
export const OVERVIEW_HEADING = '## Overview';
export const OPEN_QUESTIONS_HEADING = '## Open Questions';
export const SPINE_HEADINGS = [OVERVIEW_HEADING, OPEN_QUESTIONS_HEADING] as const;

/** Scaffold used when no doc exists yet — an empty product-doc skeleton. */
export const DEFAULT_SPEC = `---
title: Untitled
updated:
---

## Overview

## Open Questions
`;
