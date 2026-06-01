// Ensure node-pty's prebuilt spawn-helper is executable.
// npm sometimes drops the mode bit, causing `posix_spawnp failed` at runtime.
import { chmodSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const base = join('node_modules', 'node-pty', 'prebuilds');
if (existsSync(base)) {
  for (const dir of readdirSync(base)) {
    const helper = join(base, dir, 'spawn-helper');
    if (existsSync(helper)) {
      try {
        chmodSync(helper, 0o755);
        console.log('fix-node-pty: chmod +x', helper);
      } catch (e) {
        console.warn('fix-node-pty: could not chmod', helper, String(e));
      }
    }
  }
}
