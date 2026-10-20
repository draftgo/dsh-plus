/** Immutable profile-local plugin releases. The profile manifest is the only activation pointer. */
import { createHash, randomUUID } from 'node:crypto';
import { cp, lstat, mkdir, readFile, rename, rm, symlink, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compareVersions } from './update-feed.mjs';

export const PLUS_PACKAGE = 'dsh-plus';
export const LEGACY_BUNDLES = ['@dowork/dsh-plus-desktop', '@dowork/commander', 'dsh-plus'];
export const releaseBundleName = version => `@dsh-plus/desktop-${createHash('sha256').update(version).digest('hex').slice(0, 16)}`;
const json = async file => JSON.parse(await readFile(file, 'utf8'));
const present = async file => { try { await lstat(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };

export function assertReleaseVersion(version) {
  compareVersions(version, version);
  if (version.length > 100 || !/^[a-zA-Z0-9][a-zA-Z0-9.+-]*$/.test(version)) throw new Error('插件版本号无效');
  return version;
}

function assertArchivePath(name) {
  if (typeof name !== 'string' || name.length > 2048 || name.includes('\\') || isAbsolute(name)) throw new Error('更新包包含不安全路径');
  const parts = name.replace(/\/$/, '').split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || /[<>:"|?*\x00-\x1f]/.test(part) || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new Error('更新包包含不安全路径');
  if (parts[0] !== 'node_modules' && name !== 'release.json') throw new Error('更新包包含非插件文件');
}

async function describeRelease(directory, version) {
  const metadata = await json(join(directory, 'release.json'));
  const pluginPath = join(directory, 'node_modules', PLUS_PACKAGE);
  const bundleName = releaseBundleName(version), bundlePath = join(directory, 'node_modules', bundleName);
  const plugin = await json(join(pluginPath, 'package.json'));
  const bundle = await json(join(bundlePath, 'package.json'));
  if (metadata.schemaVersion !== 1 || metadata.version !== version || plugin.name !== PLUS_PACKAGE || plugin.version !== version || bundle.name !== bundleName || bundle.version !== version || bundle.dependencies?.[PLUS_PACKAGE] !== version)
    throw new Error('插件版本目录信息不一致');
  if (metadata.platform && metadata.platform !== process.platform) throw new Error(`此插件包适用于 ${metadata.platform}，当前系统为 ${process.platform}`);
  if (metadata.arch && metadata.arch !== process.arch) throw new Error(`此插件包适用于 ${metadata.arch}，当前架构为 ${process.arch}`);
  for (const file of ['src/plugin.mjs', 'lib/client.js', 'lib/link.mjs', 'lib/link-web/index.html', 'voice/src/plugin.mjs', 'cordis.patch.yml']) {
    const stat = await lstat(join(pluginPath, file));
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('插件更新包缺少必要文件');
  }
  return { directory, version, pluginPath, bundlePath, bundleName, root: dirname(directory), shared: metadata.shared ?? [] };
}

async function attachOfficialPackages(release, runtime) {
  if (!runtime) {
    if (release.shared.length) throw new Error('未找到官方引擎目录，无法校验插件共享服务');
    return;
  }
  runtime = await realpath(runtime);
  const findPackage = async name => {
    for (let current = runtime; ; current = dirname(current)) {
      const candidate = join(current, 'node_modules', name);
      if (await present(join(candidate, 'package.json'))) return candidate;
      if (dirname(current) === current) return null;
    }
  };
  if (await findPackage(PLUS_PACKAGE)) throw new Error('此桌面版本仍内置锁定插件，请先安装支持独立插件更新的新版应用');
  for (const item of release.shared) {
    const name = typeof item === 'string' ? item : item.name;
    if (typeof name !== 'string' || !/^@deepseek-ai\/[a-z0-9][a-z0-9-]*$/.test(name)) throw new Error('插件声明了不受支持的共享服务');
    const source = await findPackage(name), target = join(release.directory, 'node_modules', name);
    if (!source) throw new Error(`官方引擎缺少共享服务 ${name}`);
    const manifest = await json(join(source, 'package.json'));
    if (typeof item === 'object' && item.version !== manifest.version) throw new Error(`共享服务 ${name} 版本不兼容，请更新应用`);
    if (await present(target)) {
      let current;
      try { current = await realpath(target); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (current === await realpath(source)) continue;
      if (!(await lstat(target)).isSymbolicLink()) throw new Error('插件包不得覆盖官方共享服务');
      await rm(target, { recursive: true, force: true });
    }
    await mkdir(dirname(target), { recursive: true });
    await symlink(source, target, process.platform === 'win32' ? 'junction' : 'dir');
  }
}

/** Prepare and validate without changing the running profile. No lifecycle scripts are executed. */
export async function prepareRelease({ archive, directory, root, version, runtime }) {
  assertReleaseVersion(version);
  root = resolve(root);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const destination = join(root, version);
  if (await present(destination)) {
    const release = await describeRelease(destination, version);
    await attachOfficialPackages(release, runtime);
    return release;
  }
  const temporary = join(root, `.prepare-${randomUUID()}`);
  await mkdir(temporary, { mode: 0o700 });
  try {
    if (directory && !archive) {
      await cp(resolve(directory), temporary, { recursive: true, dereference: false, filter: async source => {
        if ((await lstat(source)).isSymbolicLink()) throw new Error('离线种子不得包含符号链接');
        return true;
      } });
    } else {
      const tar = await import('tar');
      let total = 0, count = 0;
      let validationError;
      const seen = new Set();
      await tar.t({ file: archive, strict: true, onReadEntry: entry => {
        try {
          assertArchivePath(entry.path);
          if (!['File', 'Directory'].includes(entry.type)) throw new Error('插件更新包不得包含链接或设备文件');
          const normalized = entry.path.replace(/\/$/, '').toLowerCase();
          if (seen.has(normalized)) throw new Error('插件更新包包含重复路径');
          seen.add(normalized);
          total += entry.size;
          if (++count > 60_000 || total > 1024 * 1024 * 1024 || entry.size < 0) throw new Error('插件更新包解压大小超出限制');
        } catch (error) { validationError ??= error; }
      } });
      if (validationError) throw validationError;
      await tar.x({ file: archive, cwd: temporary, strict: true, preservePaths: false, noMtime: true, noChmod: true,
        filter: (name, entry) => { assertArchivePath(name); if (!['File', 'Directory'].includes(entry.type)) throw new Error('插件更新包不得包含链接'); return true; },
      });
    }
    const prepared = await describeRelease(temporary, version);
    await attachOfficialPackages(prepared, runtime);
    await rename(temporary, destination);
    return await describeRelease(destination, version);
  } catch (error) { await rm(temporary, { recursive: true, force: true }); throw error; }
}

export async function getInstallState(profile) {
  let manifest;
  try { manifest = await json(join(profile, 'package.json')); }
  catch (error) { if (error.code === 'ENOENT') return { managed: false, enabled: false }; throw error; }
  const state = manifest.dsh?.plusInstall;
  if (!state || state.schemaVersion !== 1) return { managed: false, enabled: (manifest.dsh?.profile?.bundles ?? []).some(name => LEGACY_BUNDLES.includes(name)) };
  return { ...state, managed: true, enabled: (manifest.dsh?.profile?.bundles ?? []).includes(state.bundleName), previous: state.previous ?? null };
}

/** Unique immutable wrapper links are created first; one manifest rename activates the whole release. */
export async function activateRelease(options) {
  let atomic;
  try { atomic = await import('@deepseek-ai/dsh-atomic-write'); }
  catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
    atomic = await import(pathToFileURL(join(options.release.directory, 'node_modules/@deepseek-ai/dsh-atomic-write/lib/index.js')).href);
  }
  return atomic.withFileLock(join(resolve(options.profile), 'package.json'), () => activateLocked(options, atomic));
}

async function activateLocked({ profile, release, enabled, appVersion, migrateLegacy = false }, atomic) {
  profile = resolve(profile);
  const checked = await describeRelease(resolve(release.directory), release.version);
  const manifestPath = join(profile, 'package.json'), manifest = await json(manifestPath);
  if (!Array.isArray(manifest.dsh?.profile?.bundles)) throw new Error('工作区插件配置无效，原配置已保留');
  const before = await getInstallState(profile);
  const target = join(profile, 'node_modules', checked.bundleName);
  await mkdir(dirname(target), { recursive: true });
  if (await present(target)) {
    if (await realpath(target) !== await realpath(checked.bundlePath)) throw new Error('此插件版本的安装位置已被占用');
  } else await symlink(checked.bundlePath, target, process.platform === 'win32' ? 'junction' : 'dir');
  const selected = manifest.dsh.profile.bundles;
  const wasEnabled = enabled ?? (before.managed ? before.enabled : selected.some(name => LEGACY_BUNDLES.includes(name)));
  const isManagedName = name => LEGACY_BUNDLES.includes(name) || name.startsWith('@dsh-plus/desktop-');
  manifest.dependencies ??= {};
  for (const name of Object.keys(manifest.dependencies)) if (isManagedName(name)) delete manifest.dependencies[name];
  manifest.dependencies[checked.bundleName] = `link:${checked.bundlePath.replaceAll('\\', '/')}`;
  manifest.dsh.profile.bundles = selected.filter(name => !isManagedName(name));
  if (wasEnabled) manifest.dsh.profile.bundles.push(checked.bundleName);
  const previous = before.managed && before.version !== checked.version
    ? { version: before.version, directory: before.directory, bundleName: before.bundleName }
    : before.previous ?? null;
  manifest.dsh.plusInstall = { schemaVersion: 1, version: checked.version, directory: checked.directory, bundleName: checked.bundleName, root: checked.root, previous, appVersion: appVersion ?? before.appVersion ?? null };
  // Native lookup inside the profile wins over the selected bundle's fallback.
  // Only the offline installer may move an old package a running Host can import.
  const shadow = join(profile, 'node_modules', PLUS_PACKAGE);
  let backup;
  if (await present(shadow)) {
    const legacy = await json(join(shadow, 'package.json'));
    if (legacy.name !== PLUS_PACKAGE) throw new Error('插件安装位置被其他内容占用，原文件已保留');
    assertReleaseVersion(legacy.version);
    if (migrateLegacy || await realpath(shadow) !== await realpath(checked.pluginPath)) {
      if (!migrateLegacy) throw new Error('检测到旧版插件残留，请关闭小角并重新运行新版安装程序');
      const migrationRoot = join(profile, '.dsh-plus');
      await mkdir(migrationRoot, { recursive: true, mode: 0o700 });
      backup = join(migrationRoot, `.legacy-${randomUUID()}`);
      await rename(shadow, backup);
    }
  }
  try {
    await atomic.writeFileAtomic(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 });
  } catch (error) {
    if (backup) await rename(backup, shadow);
    throw error;
  }
  if (backup) await rm(backup, { recursive: true, force: true });
  return getInstallState(profile);
}

export async function rollbackRelease({ profile, runtime }) {
  const state = await getInstallState(profile);
  if (!state.previous) throw new Error('没有可回退的插件版本');
  const release = await prepareRelease({ root: state.root, version: state.previous.version, runtime });
  return activateRelease({ profile, release });
}
