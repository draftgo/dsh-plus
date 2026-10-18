import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFile } from 'node:fs/promises';

export const UPDATE_REPOSITORY = 'draftgo/dsh-plus';
export const DEFAULT_UPDATE_CONFIG = Object.freeze({ source: 'mirror', mirrorUrl: 'https://ghfast.top/' });
export const MAX_PLUGIN_BYTES = 256 * 1024 * 1024;
const releaseBase = `https://github.com/${UPDATE_REPOSITORY}/releases/`;
const metadataUrl = `${releaseBase}download/plugin-updates/dsh-plus-update.json`;

export class UpdateFeedError extends Error {
  constructor(code, message, options) { super(message, options); this.name = 'UpdateFeedError'; this.code = code; }
}
const fail = (code, message) => { throw new UpdateFeedError(code, message); };

function mirrorPrefix(value) {
  let parsed;
  try { parsed = new URL(value); } catch { fail('UPDATE_SOURCE', '更新镜像地址无效'); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash)
    fail('UPDATE_SOURCE', '更新镜像须使用不含凭据、查询参数和片段的 HTTPS 地址');
  return `${parsed.href.replace(/\/+$/, '')}/`;
}

export function normalizeUpdateConfig(config = {}) {
  const source = config.source ?? DEFAULT_UPDATE_CONFIG.source;
  if (!['mirror', 'github', 'custom'].includes(source)) fail('UPDATE_SOURCE', '未知更新源');
  if (source === 'custom' && !config.mirrorUrl) fail('UPDATE_SOURCE', '请填写自定义 HTTPS 镜像地址');
  const mirrorUrl = source === 'custom' ? mirrorPrefix(config.mirrorUrl) : DEFAULT_UPDATE_CONFIG.mirrorUrl;
  return { source, mirrorUrl };
}

export function releaseDownloadUrl(filename, tag = 'latest') {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(filename) || !/^[a-zA-Z0-9][a-zA-Z0-9._+-]*$/.test(tag))
    fail('UPDATE_URL', '更新文件名或版本标签无效');
  return tag === 'latest' ? `${releaseBase}latest/download/${filename}` : `${releaseBase}download/${tag}/${filename}`;
}

export function filenameFromReleaseUrl(value, { metadata = false } = {}) {
  if (typeof value !== 'string' || !value.startsWith(releaseBase)) fail('UPDATE_URL', '仅支持本仓库的 GitHub Release 下载地址');
  const suffix = value.slice(releaseBase.length);
  const match = suffix.match(/^download\/([a-zA-Z0-9][a-zA-Z0-9._+-]*)\/([a-zA-Z0-9][a-zA-Z0-9._-]*)$/)
    || (metadata && suffix.match(/^(latest)\/download\/(dsh-plus-update\.json(?:\.sig)?)$/));
  if (!match) fail('UPDATE_URL', '更新下载地址无效');
  return match[2];
}

export function resolveUpdateUrl(url, config = DEFAULT_UPDATE_CONFIG) {
  filenameFromReleaseUrl(url, { metadata: true });
  const normalized = normalizeUpdateConfig(config);
  return normalized.source === 'github' ? url : `${normalized.mirrorUrl}${url}`;
}

function parseVersion(value) {
  if (typeof value !== 'string' || value.length > 128) fail('UPDATE_VERSION', '版本号无效');
  const match = value.match(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/);
  if (!match) fail('UPDATE_VERSION', `版本号无效：${value}`);
  const prerelease = match[4]?.split('.') ?? [];
  if (prerelease.some(part => /^\d+$/.test(part) && part.length > 1 && part.startsWith('0'))) fail('UPDATE_VERSION', '预发布版本号无效');
  return { parts: match.slice(1, 4).map(BigInt), prerelease };
}

export function compareVersions(left, right) {
  const a = parseVersion(left), b = parseVersion(right);
  for (let index = 0; index < 3; index++) if (a.parts[index] !== b.parts[index]) return a.parts[index] > b.parts[index] ? 1 : -1;
  if (!a.prerelease.length || !b.prerelease.length) return a.prerelease.length === b.prerelease.length ? 0 : a.prerelease.length ? -1 : 1;
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index++) {
    const x = a.prerelease[index], y = b.prerelease[index];
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    if (x === y) continue;
    const nx = /^\d+$/.test(x), ny = /^\d+$/.test(y);
    if (nx && ny) return BigInt(x) > BigInt(y) ? 1 : -1;
    if (nx !== ny) return nx ? -1 : 1;
    return x > y ? 1 : -1;
  }
  return 0;
}
export const isNewerVersion = (candidate, current) => compareVersions(candidate, current) > 0;
export function isEngineCompatible(version, range) {
  if (!range || typeof range !== 'object' || !range.min) return false;
  return compareVersions(version, range.min) >= 0 && (!range.max || compareVersions(version, range.max) <= 0);
}

function validateArtifact(artifact, { plugin = false } = {}) {
  if (!artifact || typeof artifact !== 'object') fail('UPDATE_MANIFEST', '更新包信息缺失');
  parseVersion(artifact.version);
  const filename = filenameFromReleaseUrl(artifact.url);
  if (plugin && !filename.endsWith('.tar.gz')) fail('UPDATE_MANIFEST', '插件更新包格式须为 tar.gz');
  if (plugin || artifact.sha256 !== undefined) {
    if (!/^[a-f0-9]{64}$/.test(artifact.sha256)) fail('UPDATE_MANIFEST', '更新包校验值无效');
  }
  if (plugin || artifact.size !== undefined) {
    if (!Number.isSafeInteger(artifact.size) || artifact.size <= 0 || (plugin && artifact.size > MAX_PLUGIN_BYTES)) fail('UPDATE_MANIFEST', '更新包大小无效');
  }
}

export function validateReleaseManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest) || manifest.schemaVersion !== 1)
    fail('UPDATE_MANIFEST', '不支持的更新清单格式');
  parseVersion(manifest.version);
  if (!manifest.engine || typeof manifest.engine !== 'object') fail('UPDATE_MANIFEST', '缺少引擎兼容信息');
  parseVersion(manifest.engine.min);
  if (manifest.engine.max !== undefined && compareVersions(manifest.engine.max, manifest.engine.min) < 0) fail('UPDATE_MANIFEST', '引擎兼容范围无效');
  validateArtifact(manifest.plugin, { plugin: true });
  if (manifest.version !== manifest.plugin.version) fail('UPDATE_MANIFEST', '插件版本与清单版本不一致');
  if (manifest.app !== undefined) validateArtifact(manifest.app);
  if (manifest.notes !== undefined && (typeof manifest.notes !== 'string' || manifest.notes.length > 16_384)) fail('UPDATE_MANIFEST', '更新说明过长或格式无效');
  return manifest;
}

function allowedRedirect(url, initial) {
  const parsed = new URL(url);
  const allowedHosts = new Set([new URL(initial).hostname, 'github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com']);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash || !allowedHosts.has(parsed.hostname) || (parsed.port && parsed.port !== '443'))
    fail('UPDATE_REDIRECT', '更新源返回了不受信任的跳转地址');
}

export async function fetchUpdateBytes(url, { config = DEFAULT_UPDATE_CONFIG, fetcher = globalThis.fetch, maxBytes = 256 * 1024, timeoutMs = 20_000 } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || !Number.isFinite(timeoutMs) || timeoutMs < 1) fail('UPDATE_REQUEST', '更新请求限制无效');
  const initial = resolveUpdateUrl(url, config), controller = new AbortController();
  let timer;
  try {
    return await Promise.race([
      (async () => {
        let target = initial;
        for (let redirects = 0; redirects <= 4; redirects++) {
          const response = await fetcher(target, { signal: controller.signal, redirect: 'manual', credentials: 'omit', headers: { accept: 'application/octet-stream' } });
          if ([301, 302, 303, 307, 308].includes(response.status)) {
            const location = response.headers.get('location');
            await response.body?.cancel();
            if (!location || redirects === 4) fail('UPDATE_REDIRECT', '更新源跳转次数过多或地址缺失');
            target = new URL(location, target).href;
            allowedRedirect(target, initial);
            continue;
          }
          if (!response.ok) {
            await response.body?.cancel();
            throw Object.assign(new UpdateFeedError('UPDATE_HTTP', `更新源请求失败（HTTP ${response.status}）`), { httpStatus: response.status });
          }
          const length = response.headers.get('content-length');
          if (length && (!/^\d+$/.test(length) || Number(length) > maxBytes)) { await response.body?.cancel(); fail('UPDATE_SIZE', '更新文件超过允许大小'); }
          if (!response.body) fail('UPDATE_BODY', '更新源返回空响应');
          const reader = response.body.getReader(), chunks = [];
          let size = 0;
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              size += value.byteLength;
              if (size > maxBytes) { await reader.cancel(); fail('UPDATE_SIZE', '更新文件超过允许大小'); }
              chunks.push(Buffer.from(value));
            }
          } finally { reader.releaseLock(); }
          return Buffer.concat(chunks, size);
        }
      })(),
      new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new UpdateFeedError('UPDATE_TIMEOUT', '更新源响应超时，请重试或切换更新源')); }, timeoutMs); }),
    ]);
  } catch (error) {
    if (error instanceof UpdateFeedError) throw error;
    throw new UpdateFeedError('UPDATE_NETWORK', '无法连接更新源，请检查网络或切换更新源', { cause: error });
  } finally { clearTimeout(timer); }
}

export async function fetchVerifiedRelease({ config = DEFAULT_UPDATE_CONFIG, publicKey, fetcher = globalThis.fetch, timeoutMs = 20_000 } = {}) {
  const downloaded = await Promise.allSettled([
    fetchUpdateBytes(metadataUrl, { config, fetcher, timeoutMs }).catch(error => {
      if (error.httpStatus === 404) throw new UpdateFeedError('UPDATE_UNPUBLISHED', '更新通道尚未就绪');
      throw error;
    }),
    fetchUpdateBytes(`${metadataUrl}.sig`, { config, fetcher, timeoutMs, maxBytes: 4096 }),
    publicKey || readFile(new URL('./update-public-key.pem', import.meta.url)),
  ]);
  for (const result of downloaded) if (result.status === 'rejected') throw result.reason;
  const [bytes, signatureBytes, trustedKey] = downloaded.map(result => result.value);
  const encoded = signatureBytes.toString('utf8').trim();
  if (!/^[A-Za-z0-9+/]{86}==$/.test(encoded)) fail('UPDATE_SIGNATURE', '更新清单签名格式无效');
  let valid = false;
  try {
    const key = createPublicKey(trustedKey);
    valid = key.asymmetricKeyType === 'ed25519' && verify(null, bytes, key, Buffer.from(encoded, 'base64'));
  } catch { fail('UPDATE_SIGNATURE', '更新公钥或签名无效'); }
  if (!valid) fail('UPDATE_SIGNATURE', '更新清单签名校验失败');
  let manifest;
  try { manifest = JSON.parse(bytes.toString('utf8')); } catch { fail('UPDATE_MANIFEST', '更新清单不是有效 JSON'); }
  return validateReleaseManifest(manifest);
}

export function verifyArtifact(bytes, artifact) {
  if (bytes.byteLength !== artifact.size) fail('UPDATE_SIZE', '更新包大小与清单不一致');
  if (createHash('sha256').update(bytes).digest('hex') !== artifact.sha256) fail('UPDATE_HASH', '更新包完整性校验失败');
  return bytes;
}
