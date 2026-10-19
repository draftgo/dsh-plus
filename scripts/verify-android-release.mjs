import { spawnSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { existsSync, readFileSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const apk = resolve(process.argv[2] ?? join(root, 'plugins/link/mobile/android/app/build/outputs/apk/release/app-release.apk'));
const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
if (!sdk) throw new Error('ANDROID_HOME or ANDROID_SDK_ROOT is required');
const buildTools = join(sdk, 'build-tools', '35.0.0');
const windows = process.platform === 'win32';
function run(command, args, encoding = 'utf8') {
  const env = { ...process.env };
  if (env.JAVA_HOME) env.PATH = join(env.JAVA_HOME, 'bin') + delimiter + (env.PATH ?? '');
  const result = spawnSync(command, args, { encoding, env, shell: windows && command.endsWith('.bat') });
  if (result.error || result.status !== 0) throw new Error('Android verification failed: ' + command + ' ' + (result.stderr || result.error?.message || ''));
  return result.stdout;
}
if (!existsSync(apk)) throw new Error('Missing signed Android release APK');
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const metadata = run(join(buildTools, windows ? 'aapt.exe' : 'aapt'), ['dump', 'badging', apk]);
if (!metadata.includes("package: name='cn.draftgo.dshplus.link'")) throw new Error('Unexpected Android applicationId');
if (!metadata.includes("versionName='" + version + "'")) throw new Error('Android application version differs from root package');
const gradle = readFileSync(join(root, 'plugins/link/mobile/android/app/build.gradle'), 'utf8');
const versionCode = /versionCode\s+(\d+)/.exec(gradle)?.[1];
if (!versionCode || !metadata.includes("versionCode='" + versionCode + "'")) throw new Error('Unexpected Android versionCode');
if (!metadata.includes("application-label:'小角'")) throw new Error('Android application label must be 小角');
if (metadata.includes('application-debuggable')) throw new Error('Release APK must not be debuggable');
const signature = run(join(buildTools, windows ? 'apksigner.bat' : 'apksigner'), ['verify', '--verbose', '--print-certs', apk]);
if (/CN=Android Debug/i.test(signature)) throw new Error('Release APK uses a debug signing certificate');
const fingerprint = /Signer #1 certificate SHA-256 digest: ([a-f0-9]+)/i.exec(signature)?.[1]?.toLowerCase();
if (!fingerprint) throw new Error('Missing Android signing certificate');
for (const key of ['DSH_ANDROID_KEYSTORE_PATH', 'DSH_ANDROID_KEY_ALIAS', 'DSH_ANDROID_KEYSTORE_PASSWORD']) {
  if (!process.env[key]) throw new Error('Release certificate verification requires ' + key);
}
{
  const keytool = process.env.JAVA_HOME ? join(process.env.JAVA_HOME, 'bin', windows ? 'keytool.exe' : 'keytool') : 'keytool';
  const certificate = run(keytool, ['-exportcert', '-keystore', process.env.DSH_ANDROID_KEYSTORE_PATH, '-alias', process.env.DSH_ANDROID_KEY_ALIAS, '-storepass:env', 'DSH_ANDROID_KEYSTORE_PASSWORD'], null);
  const expected = new X509Certificate(certificate).fingerprint256.replaceAll(':', '').toLowerCase();
  if (fingerprint !== expected) throw new Error('APK signing certificate differs from the persistent release key');
}
const archive = readFileSync(apk);
function readAsset(name) {
  let footer = archive.length - 22;
  const minimum = Math.max(0, footer - 65535);
  while (footer >= minimum && archive.readUInt32LE(footer) !== 0x06054b50) footer--;
  if (footer < minimum) throw new Error('Invalid APK ZIP footer');
  let offset = archive.readUInt32LE(footer + 16);
  const count = archive.readUInt16LE(footer + 10);
  for (let i = 0; i < count; i++) {
    if (archive.readUInt32LE(offset) !== 0x02014b50) throw new Error('Invalid APK ZIP directory');
    const method = archive.readUInt16LE(offset + 10);
    const size = archive.readUInt32LE(offset + 20);
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    if (archive.toString('utf8', offset + 46, offset + 46 + nameLength) === name) {
      const local = archive.readUInt32LE(offset + 42);
      const start = local + 30 + archive.readUInt16LE(local + 26) + archive.readUInt16LE(local + 28);
      const data = archive.subarray(start, start + size);
      if (method === 0) return data;
      if (method === 8) return inflateRawSync(data);
      throw new Error('Unsupported APK ZIP compression');
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error('Missing APK resource: ' + name);
}
for (const [asset, file] of [
  ['assets/app.js', 'plugins/link/dist/web/app.js'],
  ['assets/native-appearance.js', 'plugins/link/mobile/android/app/src/main/assets/native-appearance.js'],
  ['assets/server/server-seed.bundle', 'plugins/link/dist/server/server-seed.tar.gz'],
  ['assets/server/manifest.json', 'plugins/link/dist/server/manifest.json'],
]) {
  const packed = readAsset(asset);
  if (!packed.equals(readFileSync(join(root, file)))) throw new Error('APK resource differs from current build: ' + asset);
}
console.log('Verified 小角 ' + version + ' Android release: non-debuggable, matching release signature and current resources; certificate SHA256 ' + fingerprint);
