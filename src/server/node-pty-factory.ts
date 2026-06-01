// src/server/node-pty-factory.ts
import * as pty from 'node-pty';
import type { Pty } from './terminal-session';

/** Spawn a real shell PTY in `cwd`, adapted to the Pty interface. */
export function spawnNodePty(opts: { cwd: string; shell?: string }): Pty {
  const proc = pty.spawn(opts.shell ?? process.env.SHELL ?? '/bin/zsh', [], {
    name: 'xterm-color',
    cols: 80,
    rows: 24,
    cwd: opts.cwd,
    env: process.env as Record<string, string>,
  });
  return {
    write: (d) => proc.write(d),
    resize: (c, r) => proc.resize(c, r),
    onData: (cb) => { proc.onData(cb); },
    onExit: (cb) => { proc.onExit(() => cb()); },
    kill: () => proc.kill(),
  };
}
