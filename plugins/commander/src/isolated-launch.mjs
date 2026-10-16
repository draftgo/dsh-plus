import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

// SDK history helpers read the parent environment. A separate short-lived
// process avoids ever changing process.env across concurrent A/B sessions.
export async function isolatedClaudeHistory(directory, operation, sessionId, cwd) {
  if (!['info', 'messages', 'list'].includes(operation)) throw new Error('Unsupported isolated history operation');
  const { stdout } = await promisify(execFile)(process.execPath, [fileURLToPath(import.meta.url), 'claude-history', operation, sessionId || '', cwd], {
    env: { ...process.env, CLAUDE_CONFIG_DIR: directory }, timeout: 15_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true,
  });
  return JSON.parse(stdout);
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === 'claude-history') {
  try {
    const sdk = await import('@anthropic-ai/claude-agent-sdk');
    const [, , , operation, sessionId, cwd] = process.argv;
    const result = operation === 'info' ? await sdk.getSessionInfo(sessionId, { dir: cwd }) : operation === 'messages' ? await sdk.getSessionMessages(sessionId, { dir: cwd }) : operation === 'list' ? await sdk.listSessions({ dir: cwd, limit: 50 }) : null;
    process.stdout.write(JSON.stringify(result ?? null));
  } catch { process.stderr.write('Isolated Claude history read failed'); process.exitCode = 1; }
}
