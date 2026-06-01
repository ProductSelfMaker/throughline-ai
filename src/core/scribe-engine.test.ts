// src/core/scribe-engine.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SpecStore } from './spec-store';
import { ScribeEngine } from './scribe-engine';
import { FakeAgentRunner } from '../agent/fake-runner';
import { ScribeResult } from '../domain/types';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'throughline-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const VALID = `## 🎯 요약
소셜 로그인 앱

## ✅ 핵심 기능
- [ ] 소셜 로그인

## 🟡 미정 / 열린 질문
- 결제 수단은?
`;

describe('ScribeEngine.runNow', () => {
  it('writes the new spec (with feature ids), returns the change set, and emits "updated"', async () => {
    const store = new SpecStore(join(dir, 'spec.md'));
    const engine = new ScribeEngine(store, new FakeAgentRunner({ scribeReply: VALID }));

    let emitted: ScribeResult | undefined;
    engine.on('updated', (r: ScribeResult) => (emitted = r));

    const result = await engine.runNow([{ role: 'user', content: '소셜 로그인만' }]);

    expect(result).not.toBeNull();
    expect(result!.changedLines.length).toBeGreaterThan(0);
    const onDisk = await store.read();
    expect(onDisk).toContain('- [ ] 소셜 로그인 <!-- id: feat-');
    expect(onDisk).toBe(result!.md);
    expect(emitted).toEqual(result);
  });

  it('returns null, emits "rejected", and leaves the file untouched when the spec is invalid', async () => {
    const store = new SpecStore(join(dir, 'spec.md'));
    await store.write('## 🎯 요약\n원본\n');
    const engine = new ScribeEngine(
      store,
      new FakeAgentRunner({ scribeReply: '미정 섹션 없는 깨진 문서' }),
    );

    let rejected = false;
    engine.on('rejected', () => (rejected = true));

    const result = await engine.runNow([{ role: 'user', content: 'x' }]);

    expect(result).toBeNull();
    expect(rejected).toBe(true);
    expect(await store.read()).toBe('## 🎯 요약\n원본\n');
  });

  it('returns null and emits "rejected" with the message when the runner throws', async () => {
    const store = new SpecStore(join(dir, 'spec.md'));
    await store.write('## 🎯 요약\n원본\n');
    const throwingRunner = {
      converse: async () => '',
      scribe: async () => {
        throw new Error('network down');
      },
      complete: async () => '',
    };
    const engine = new ScribeEngine(store, throwingRunner);

    let errors: string[] | undefined;
    engine.on('rejected', (e: string[]) => (errors = e));

    const result = await engine.runNow([{ role: 'user', content: 'x' }]);

    expect(result).toBeNull();
    expect(errors).toEqual(['network down']);
    expect(await store.read()).toBe('## 🎯 요약\n원본\n');
  });
});
