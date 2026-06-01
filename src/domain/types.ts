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

export interface AgentRunner {
  /** Streams a planning reply token-by-token; resolves with the full assistant text. */
  converse(
    transcript: Message[],
    onToken: (t: string) => void,
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

/** The three fixed "spine" sections that must always be present (hybrid structure). */
export const SPINE_HEADINGS = [
  '## 🎯 요약',
  '## ✅ 핵심 기능',
  '## 🟡 미정 / 열린 질문',
] as const;

/** Scaffold used when no spec.md exists yet. */
export const DEFAULT_SPEC = `---
title: Untitled
updated:
---

## 🎯 요약

## ✅ 핵심 기능

## 🟡 미정 / 열린 질문
`;
