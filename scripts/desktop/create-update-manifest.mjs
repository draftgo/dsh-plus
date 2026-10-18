import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { releaseDownloadUrl, validateReleaseManifest } from '../../plugins/commander/shared/update-feed.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));

export async function createUpdateManifest({ pluginPath, outDir, version, engineVersion, tag = `plugin-v${version}`, privateKey, publicKey, notes, app } = {}) {
  if (!privateKey) throw new Error('缺少 DSH_PLUS_UPDATE_PRIVATE_KEY 发布签名密钥');
  const key = createPrivateKey(privateKey);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('发布签名必须使用 Ed25519 密钥');
  const bytes = await readFile(pluginPath);
  const manifest = validateReleaseManifest({
    schemaVersion: 1,
    version,
    engine: { min: engineVersion, max: engineVersion },
    plugin: {
      version,
      url: releaseDownloadUrl(path.basename(pluginPath), tag),
      sha256: createHash('sha256').update(bytes).digest('hex'),
      size: bytes.byteLength,
    },
    ...(notes ? { notes } : {}),
    ...(app ? { app } : {}),
  });
  const payload = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  const signature = sign(null, payload, key);
  const trusted = createPublicKey(publicKey ?? await readFile(new URL('../../plugins/commander/shared/update-public-key.pem', import.meta.url)));
  if (trusted.asymmetricKeyType !== 'ed25519' || !verify(null, payload, trusted, signature)) throw new Error('发布密钥与客户端内置信任公钥不匹配');
  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, 'dsh-plus-update.json'), payload);
  await writeFile(path.join(outDir, 'dsh-plus-update.json.sig'), `${signature.toString('base64')}\n`);
  return manifest;
}

async function main() {
  const options = {};
  const allowed = new Set(['--plugin', '--out', '--tag', '--notes-file', '--app-feed']);
  const args = process.argv.slice(2);
  while (args.length) {
    const option = args.shift(), value = args.shift();
    if (!allowed.has(option) || !value || value.startsWith('--')) throw new Error(`未知参数或缺少参数值：${option}`);
    options[option] = value;
  }
  const pkg = JSON.parse(await readFile(path.join(root, 'plugins/commander/package.json'), 'utf8'));
  const upstream = JSON.parse(await readFile(path.join(root, 'upstream.json'), 'utf8'));
  const outDir = path.resolve(options['--out'] || path.join(root, 'artifacts/plugins'));
  let app;
  if (options['--app-feed']) {
    const feed = JSON.parse(await readFile(options['--app-feed'], 'utf8'));
    const file = feed.files?.[0];
    if (!file || file.url !== `dsh-plus-${feed.version}-win-x64-setup.exe`) throw new Error('应用更新清单无效');
    app = { version: feed.version, url: releaseDownloadUrl(file.url, 'app-updates'), size: file.size };
  }
  const result = await createUpdateManifest({
    app,
    pluginPath: path.resolve(options['--plugin'] || path.join(outDir, `dsh-plus-${pkg.version}-plugin.tar.gz`)),
    outDir,
    version: pkg.version,
    engineVersion: upstream.version,
    tag: options['--tag'] || `plugin-v${pkg.version}`,
    privateKey: process.env.DSH_PLUS_UPDATE_PRIVATE_KEY,
    notes: options['--notes-file'] ? await readFile(options['--notes-file'], 'utf8') : undefined,
  });
  process.stdout.write(`DSH-Plus ${result.version}: 已生成签名更新清单\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1; });
