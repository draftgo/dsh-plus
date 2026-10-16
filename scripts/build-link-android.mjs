import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const android = fileURLToPath(new URL('../plugins/link/mobile/android/', import.meta.url));
const windows = process.platform === 'win32';
for (const [command, args, cwd] of [
  [windows ? 'npm.cmd' : 'npm', ['--prefix', 'plugins/link', 'run', 'build:web'], root],
  [windows ? 'gradlew.bat' : './gradlew', ['assembleDebug', ...process.argv.slice(2)], android],
]) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', shell: windows });
  if (result.error) { console.error(result.error.message); process.exit(1); }
  if (result.status !== 0) process.exit(result.status ?? 1);
}
