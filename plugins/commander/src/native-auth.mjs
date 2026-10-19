import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
/** Ask the existing CLI; never parse/copy account files or expose raw output. */
export function createNativeAuth({ installer, executor = execute, env = process.env, cacheMs = 15000 } = {}) {
  const cache = new Map(), pending = new Map();
  const inspect = async tool => {
    if (!['codex', 'claude'].includes(tool)) return { tool, status: 'unsupported' };
    try {
      const launch = await installer.resolveLaunch(tool);
      if (!launch) return { tool, status: 'not-installed' };
      const args = tool === 'codex' ? ['login', 'status'] : ['auth', 'status', '--json'];
      const output = await executor(launch.command, [...launch.args, ...args], { env: { ...env, ...launch.env }, timeout: 5000, maxBuffer: 32768, windowsHide: true });
      if (tool === 'codex') {
        const text = String(output.stdout || '') + String(output.stderr || '');
        return { tool, status: /logged in using chatgpt/iu.test(text) ? 'subscription' : /logged in using (?:an? )?api key/iu.test(text) ? 'api' : 'unknown' };
      }
      const value = JSON.parse(output.stdout);
      const subscription = value.loggedIn === true && value.authMethod === 'claude.ai' && (!value.apiProvider || value.apiProvider === 'firstParty');
      return { tool, status: subscription ? 'subscription' : value.loggedIn ? 'api' : 'logged-out' };
    } catch (error) { return { tool, status: error.code === 1 ? 'logged-out' : 'unavailable' }; }
  };
  return {
    async status(tool) {
      const current = cache.get(tool);
      if (current && Date.now() - current.time < cacheMs) return { ...current.value };
      if (!pending.has(tool)) pending.set(tool, inspect(tool).then(value => { cache.set(tool, { time: Date.now(), value }); return value; }).finally(() => pending.delete(tool)));
      return { ...await pending.get(tool) };
    },
  };
}
