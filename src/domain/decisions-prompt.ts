// src/domain/decisions-prompt.ts
export function buildDecisionsPrompt(activityExcerpt: string): string {
  return [
    'Extract the *key decisions* from the activity log below and organize them as markdown.',
    'Give each decision a "## <decision summary>" heading with one line each for: what (what was decided), why (the reason), and alternatives (what was rejected, if any).',
    'Include only decisions that were actually made. Exclude minor steps, work logs, and implementation details.',
    'LANGUAGE: write the content in the same language the user uses in the activity below. Do not translate it.',
    '',
    'Activity:',
    '"""',
    activityExcerpt || '(none)',
    '"""',
    '',
    'Output markdown only — no commentary, no code fences (```).',
  ].join('\n');
}
