// src/domain/resolve-prompt.ts
// Apply the user's chat answer to one merge conflict and return the updated unified document.
import { SPINE_HEADINGS } from './types';

export function buildResolvePrompt(currentMd: string, question: string, answer: string): string {
  return [
    'You maintain a merged PRODUCT document. The user is resolving a merge conflict via chat.',
    `Apply the user's answer to the document and return the FULL updated document. Keep the English spine (${SPINE_HEADINGS.join(' , ')}) and touch only what the answer affects.`,
    'LANGUAGE: keep the two spine headings in English; write everything else in the SAME language the document uses.',
    '',
    'Conflict question:',
    '"""',
    question,
    '"""',
    '',
    "User's answer:",
    '"""',
    answer,
    '"""',
    '',
    'Current document:',
    '"""',
    currentMd,
    '"""',
    '',
    'Output the FULL updated document markdown only — no commentary, no code fences (```).',
  ].join('\n');
}
