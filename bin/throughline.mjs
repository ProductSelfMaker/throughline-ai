#!/usr/bin/env node
// Build the web app (if needed) and start the server, which opens the browser.
import { spawn } from 'node:child_process';

const child = spawn('npm', ['start'], { stdio: 'inherit', shell: false });
child.on('exit', (code) => process.exit(code ?? 0));
