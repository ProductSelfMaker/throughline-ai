import { describe, it, expect } from 'vitest';
import { buildMergePrompt, extractConflicts } from './merge-prompt';

describe('buildMergePrompt', () => {
  it('embeds each workspace doc and asks to flag conflicts as structured questions', () => {
    const p = buildMergePrompt([
      { name: 'Billing', md: '## Overview\n결제 기능' },
      { name: 'Auth', md: '## Overview\n로그인 기능' },
    ]);
    expect(p).toContain('Billing');
    expect(p).toContain('결제 기능');
    expect(p).toContain('Auth');
    expect(p).toContain('## Overview');          // keep the spine
    expect(p).toContain('CONFLICTS');             // structured conflict block
    expect(p.toLowerCase()).toContain('do not'); // do not silently pick
  });
});

describe('extractConflicts', () => {
  it('splits the doc from the trailing CONFLICTS block', () => {
    const raw = '## Overview\nMerged.\n<!--CONFLICTS [{"id":"c1","question":"Billing says X, Auth says Y — which?"}] CONFLICTS-->';
    const { md, conflicts } = extractConflicts(raw);
    expect(md).toBe('## Overview\nMerged.');
    expect(conflicts).toEqual([{ id: 'c1', question: 'Billing says X, Auth says Y — which?' }]);
  });

  it('returns no conflicts when the block is absent or malformed', () => {
    expect(extractConflicts('## Overview\nMerged.')).toEqual({ md: '## Overview\nMerged.', conflicts: [] });
    const bad = extractConflicts('doc\n<!--CONFLICTS not json CONFLICTS-->');
    expect(bad.conflicts).toEqual([]);
    expect(bad.md).toBe('doc');
  });

  it('drops conflict entries missing id or question', () => {
    const { conflicts } = extractConflicts('d\n<!--CONFLICTS [{"id":"c1","question":"ok"},{"question":"no id"},{"id":"c3"}] CONFLICTS-->');
    expect(conflicts).toEqual([{ id: 'c1', question: 'ok' }]);
  });
});
