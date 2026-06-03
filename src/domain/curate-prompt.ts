// src/domain/curate-prompt.ts
import { SPINE_HEADINGS } from './types';

export function buildCuratePrompt(
  currentPrd: string,
  instruction: string,
  gitDiff: string,
): string {
  return [
    'You are the scribe that maintains a PRODUCT document (doc.md) explaining the service to its users. Edit the document per the instruction below.',
    `Always keep the English spine (${SPINE_HEADINGS.join(' , ')}); give each feature/page a "## <name>" section.`,
    'Write user-facing behavior, policy, elements, and state — never a work log. Do not touch content unrelated to the instruction.',
    'LANGUAGE: keep the two spine headings in English; write all other content in the same language the document/user already uses. Do not translate it.',
    '',
    'Instruction:',
    '"""',
    instruction,
    '"""',
    '',
    'Current document:',
    '"""',
    currentPrd,
    '"""',
    '',
    'Reference code change (git diff):',
    '"""',
    gitDiff || '(none)',
    '"""',
    '',
    'Output the FULL updated document markdown only — no commentary, no code fences (```).',
  ].join('\n');
}
