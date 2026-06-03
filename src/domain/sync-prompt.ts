// src/domain/sync-prompt.ts
import { SPINE_HEADINGS } from './types';

export function buildSyncPrompt(
  currentSpecMarkdown: string,
  transcriptExcerpt: string,
  gitDiff: string,
): string {
  return [
    'You are the scribe that maintains a PRODUCT document (doc.md) explaining the service to its users.',
    'The user is coding in their own terminal; below is a recent activity excerpt and the code change (git diff).',
    'This document is NOT a work log ("what was done") — that belongs to history.',
    'Instead, capture *what each feature/page is and how it behaves from the user\'s point of view* — visible behavior, policies, elements, and states, not internal implementation.',
    'Rules:',
    `1) Always keep the structural spine in English: ${SPINE_HEADINGS.join(' , ')}. "## Overview" = what the service is and who it is for (1–2 paragraphs).`,
    '2) Give each feature/page its own "## <name>" section with: what it is (one line), behavior & policy (rules), elements (screen makeup), and state (idle/empty/error/etc. when relevant).',
    '3) Only reflect product behavior that was actually implemented or decided in the activity/code; add or update the matching section.',
    '4) Never write a work log (steps, todos, commit messages) — that is history.',
    '5) Collect anything undecided or contradictory as "- " bullets under "## Open Questions".',
    '6) Do not invent features; reflect only what the activity/diff supports.',
    'LANGUAGE: keep the two spine headings exactly in English, but write everything else — feature section names and all prose — in the SAME language the user writes in (infer it from the activity excerpt). Do not translate the user\'s language to English.',
    '',
    'Current document:',
    '"""',
    currentSpecMarkdown,
    '"""',
    '',
    'Recent activity excerpt:',
    '"""',
    transcriptExcerpt || '(none)',
    '"""',
    '',
    'Code change (git diff):',
    '"""',
    gitDiff || '(none)',
    '"""',
    '',
    'Output the FULL updated document markdown only — no commentary, no code fences (```).',
  ].join('\n');
}
