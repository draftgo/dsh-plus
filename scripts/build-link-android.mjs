import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const android = fileURLToPath(new URL('../plugins/link/mobile/android/', import.meta.url));
const windows = process.platform === 'win32';
const options = process.argv.slice(2);
if (options.includes('--release') && options.includes('--debug')) throw new Error('Choose either --release or --debug');
const debug = options.includes('--debug');
const env = { ...process.env };
if (!debug) {
  const config = join(root, '.local/release-keys/xiaojiao-android-release.env');
  if (existsSync(config)) {
    for (const line of readFileSync(config, 'utf8').split(/\r?\n/)) {
      const match = /^(DSH_ANDROID_(?:KEYSTORE_PATH|KEYSTORE_PASSWORD|KEY_ALIAS|KEY_PASSWORD))=(.*)$/.exec(line);
      if (match && !env[match[1]]) env[match[1]] = match[2];
    }
  }
  for (const key of ['DSH_ANDROID_KEYSTORE_PATH', 'DSH_ANDROID_KEYSTORE_PASSWORD', 'DSH_ANDROID_KEY_ALIAS', 'DSH_ANDROID_KEY_PASSWORD']) {
    if (!env[key]) throw new Error('Missing ' + key + '; configure release signing or use --debug for development');
  }
}
const gradleArgs = options.filter(value => !['--release', '--debug'].includes(value));
for (const [command, args, cwd] of [
  [windows ? 'npm.cmd' : 'npm', ['run', 'build:plus'], root],
  [windows ? 'gradlew.bat' : './gradlew', [debug ? 'assembleDebug' : 'assembleRelease', ...gradleArgs], android],
  ...(!debug ? [[process.execPath, ['scripts/verify-android-release.mjs'], root]] : []),
]) {
  const result = spawnSync(command, args, { cwd, env, stdio: 'inherit', shell: windows });
  if (result.error) { console.error(result.error.message); process.exit(1); }
  if (result.status !== 0) process.exit(result.status ?? 1);
}
