// src/domain/merge-prompt.ts
// Merge several workspaces' product docs into one coherent document. Where workspaces
// genuinely disagree, the model must NOT silently pick — it flags a CONFLICT (a question for
// the user), resolved later via chat. No in-document conflict callouts.
import { SPINE_HEADINGS } from './types';

export interface Conflict { id: string; question: string }

export function buildMergePrompt(docs: { name: string; md: string }[]): string {
  const lines = [
    'You merge several PRODUCT documents — each from a separate "workspace" of the same product — into ONE coherent product document.',
    `Keep the English spine (${SPINE_HEADINGS.join(' , ')}); give each feature/page a "## <name>" section.`,
    'Combine overlapping features; keep every distinct feature. Write a clean document — do NOT put conflict markers inside the document text.',
    'CONFLICTS: where two workspaces describe the SAME feature differently or contradict each other, do NOT silently choose. Write a best-effort merged version in the doc AND record the disagreement as a conflict question for the user.',
    'LANGUAGE: keep the two spine headings in English; write everything else in the SAME language the docs use. Do not translate.',
    '',
  ];
  docs.forEach((d, i) => {
    lines.push(`=== Workspace ${i + 1}: ${d.name} ===`, '"""', d.md || '(empty)', '"""', '');
  });
  lines.push(
    'Output the FULL merged document markdown, then ONE conflicts block and nothing else:',
    '<!--CONFLICTS [{"id":"c1","question":"<one-line question naming the workspaces and the disagreement>"}] CONFLICTS-->',
    'If there are no conflicts, end with: <!--CONFLICTS [] CONFLICTS-->. No commentary, no code fences (```).',
  );
  return lines.join('\n');
}

const CONFLICTS_RE = /<!--CONFLICTS\s+([\s\S]*?)\s+CONFLICTS-->/;

/** Split the merged doc from its trailing CONFLICTS block (tolerant; [] when absent/malformed). */
export function extractConflicts(raw: string): { md: string; conflicts: Conflict[] } {
  const m = CONFLICTS_RE.exec(raw);
  if (!m) return { md: raw.trim(), conflicts: [] };
  const md = raw.replace(m[0], '').trim();
  let conflicts: Conflict[] = [];
  try {
    const arr = JSON.parse(m[1]);
    if (Array.isArray(arr)) {
      conflicts = arr
        .filter((c) => c && typeof c.id === 'string' && typeof c.question === 'string')
        .map((c) => ({ id: c.id, question: c.question }));
    }
  } catch { conflicts = []; }
  return { md, conflicts };
}
