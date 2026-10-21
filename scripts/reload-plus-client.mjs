#!/usr/bin/env node
/** Rebuild the running DSH-Plus client and let Harness HMR publish it. */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const child = spawn(process.execPath, [fileURLToPath(new URL('../plugins/commander/scripts/build-client.mjs', import.meta.url)), '--client'], {
  cwd: root,
  stdio: 'inherit',
});
child.on('exit', code => process.exit(code ?? 1));
