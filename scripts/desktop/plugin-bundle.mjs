/** Build-time Plus packaging and one-time profile enrollment using the official bundle API. */
import { spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, openSync, closeSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
const helperBase = existsSync(fileURLToPath(new URL('./shared/plugin-install.mjs', import.meta.url))) ? './shared/' : '../../plugins/commander/shared/';
const { activateRelease, getInstallState, prepareRelease, releaseBundleName } = await import(new URL(`${helperBase}plugin-install.mjs`, import.meta.url));
const { compareVersions } = await import(new URL(`${helperBase}update-feed.mjs`, import.meta.url));

const PLUS = 'dsh-plus';
const LEGACY_PLUS = '@dowork/commander';
const COMPOSITION = '@dowork/dsh-plus-desktop';
const MARKER = '.dsh-plus-enrolled.json';
const readJson = path => JSON.parse(readFileSync(path, 'utf8'));
const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });

function findPackage(name, from) {
  for (let parent = resolve(from); ; parent = dirname(parent)) {
    const candidate = join(parent, 'node_modules', name);
    if (existsSync(join(candidate, 'package.json'))) return realpathSync(candidate);
    if (dirname(parent) === parent) throw new Error(`Plus bundle: missing dependency ${name} from ${from}`);
  }
}

function sharedPackage(name) { return name.startsWith('@deepseek-ai/'); }

/** Copy published plugin files and required JS dependencies without duplicating Cordis or official services. */
export function stagePluginBundle({ runtime, output, plugin = resolve(import.meta.dirname, '../../plugins/commander'), platform = process.platform, arch = process.arch }) {
  runtime = runtime ? resolve(runtime) : null; plugin = resolve(plugin);
  const manifest = readJson(join(plugin, 'package.json'));
  if (manifest.name !== PLUS || !manifest.dsh?.bundle?.patch) throw new Error('Plus bundle: expected the DSH-Plus bundle package');
  output = resolve(output ?? join(runtime ? dirname(runtime) : dirname(plugin), 'plus-seed'));
  const relativeOutput = runtime ? relative(runtime, output) : '..';
  if (runtime && (!relativeOutput || (relativeOutput !== '..' && !relativeOutput.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(relativeOutput)))) throw new Error('Plus bundle: seed must be outside the sealed engine runtime');
  const bundleName = releaseBundleName(manifest.version);
  const destination = join(output, 'node_modules', PLUS);
  const composition = join(output, 'node_modules', bundleName);
  if (existsSync(composition)) throw new Error(`Plus bundle: composition already exists: ${composition}`);
  if (existsSync(destination)) throw new Error(`Plus bundle: destination already exists: ${destination}`);
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  // npm supplies the package's own files allowlist; never ship the source workspace or private config.
  const packed = spawnSync(npm, ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: plugin, encoding: 'utf8', shell: process.platform === 'win32' });
  if (packed.status !== 0) throw new Error(`Plus bundle: npm pack failed: ${packed.stderr}`);
  const files = JSON.parse(packed.stdout)[0].files.map(file => file.path);
  for (const required of ['src/plugin.mjs', 'lib/client.js', 'lib/link.mjs', 'lib/link-web/index.html', 'voice/src/plugin.mjs', 'cordis.patch.yml']) {
    if (!files.includes(required) || !existsSync(join(plugin, required))) throw new Error(`Plus bundle: missing built file ${required}; run build:plus first`);
  }
  const shared = new Map();
  const copied = new Set();
  const omitted = new Set();
  const assertShared = (name, spec) => {
    const directory = runtime ? join(runtime, 'node_modules', name) : findPackage(name, plugin);
    if (!existsSync(join(directory, 'package.json'))) throw new Error(`Plus bundle: official runtime omits ${name}`);
    const version = readJson(join(directory, 'package.json')).version;
    const anchor = runtime ? realpathSync(join(runtime, 'node_modules/@deepseek-ai/dsh-app-boot/package.json')) : fileURLToPath(new URL('../../deepseek-harness/package.json', import.meta.url));
    const semver = createRequire(anchor)('semver');
    if (!semver.satisfies(version, spec, { includePrerelease: true })) throw new Error(`Plus bundle: ${name}@${version} does not satisfy ${spec}`);
    shared.set(name, version);
  };
  function dependencies(source, target, ancestors = new Set()) {
    const metadata = readJson(join(source, 'package.json'));
    const optional = metadata.optionalDependencies ?? {};
    for (const [name, spec] of Object.entries({ ...metadata.dependencies, ...optional })) {
      // ssh2 falls back to JS; omit the build machine's optional Node ABI addon.
      if (metadata.name === 'ssh2' && name === 'cpu-features') { omitted.add(name); continue; }
      if (sharedPackage(name)) { assertShared(name, spec); continue; }
      let dependency;
      try { dependency = findPackage(name, source); }
      catch (error) { if (Object.hasOwn(optional, name)) { omitted.add(name); continue; } throw error; }
      const dependencyManifest = readJson(join(dependency, 'package.json'));
      const supports = (values, target) => !values || (!values.includes(`!${target}`) && (values.every(value => value.startsWith('!')) || values.includes(target)));
      if (!supports(dependencyManifest.os, platform) || !supports(dependencyManifest.cpu, arch)) {
        if (!Object.hasOwn(optional, name)) throw new Error(`Plus bundle: ${name} is unavailable for ${platform}-${arch}`);
        omitted.add(name); continue;
      }
      if (ancestors.has(dependency)) continue;
      const output = join(target, 'node_modules', name);
      mkdirSync(dirname(output), { recursive: true });
      cpSync(dependency, output, { recursive: true, dereference: true, filter: path => {
        if (path === dependency) return true;
        const relative = path.slice(dependency.length + 1);
        if (name === 'ssh2' && (relative === join('lib', 'protocol', 'crypto', 'build') || relative.startsWith(join('lib', 'protocol', 'crypto', 'build') + sep))) return false;
        return !relative.split(/[\\/]/u).includes('node_modules') && !/\.(?:[cm]?[jt]s|css)\.map$|\.tsbuildinfo$/u.test(relative);
      } });
      copied.add(name);
      dependencies(dependency, output, new Set([...ancestors, dependency]));
    }
    for (const [name, spec] of Object.entries(metadata.peerDependencies ?? {})) {
      if (sharedPackage(name) && !metadata.peerDependenciesMeta?.[name]?.optional) assertShared(name, spec);
    }
  }
  try {
    mkdirSync(destination, { recursive: true });
    for (const file of files) {
      if (file.startsWith('/') || file.split(/[\\/]/u).some(part => part === '..' || part === 'node_modules')) throw new Error(`Plus bundle: invalid packed file ${file}`);
      mkdirSync(dirname(join(destination, file)), { recursive: true });
      copyFileSync(join(plugin, file), join(destination, file));
    }
    dependencies(plugin, destination, new Set([plugin]));
    // The official resolver excludes the selected bundle itself. An immutable wrapper carries
    // DSH-Plus as a dependency, so Host inventory and client injection both resolve it.
    mkdirSync(composition, { recursive: true });
    writeJson(join(composition, 'package.json'), {
      name: bundleName, displayName: 'DSH-Plus', version: manifest.version, private: true, type: 'module', license: 'MIT',
      dependencies: { [PLUS]: manifest.version }, dsh: { bundle: { patch: './cordis.patch.yml' } },
      exports: { './package.json': './package.json', './locale/*.json': './locale/*.json' },
    });
    copyFileSync(join(plugin, 'cordis.patch.yml'), join(composition, 'cordis.patch.yml'));
    if (existsSync(join(plugin, 'locale'))) cpSync(join(plugin, 'locale'), join(composition, 'locale'), { recursive: true });
    else {
      mkdirSync(join(composition, 'locale'), { recursive: true });
      writeJson(join(composition, 'locale/en.json'), { meta: { title: 'DSH-Plus', description: 'DSH-Plus plugin updates and desktop features.' } });
    }
    const services = [...shared].sort(([a], [b]) => a.localeCompare(b)).map(([name, version]) => ({ name, version }));
    writeJson(join(output, 'release.json'), { schemaVersion: 1, version: manifest.version, platform, arch, shared: services });
    return { name: PLUS, bundle: bundleName, version: manifest.version, directory: output, destination, dependencies: [...copied].sort(), shared: services, omittedOptionalDependencies: [...omitted].sort() };
  } catch (error) {
    rmSync(destination, { recursive: true, force: true });
    rmSync(composition, { recursive: true, force: true });
    rmSync(join(output, 'release.json'), { force: true });
    throw error;
  }
}

/** Enable Plus once; preserve user bundles, patches, dependencies and later disable/recovery choices. */
export async function initializePluginProfile({ runtime, resources, profile, seed }) {
  runtime = resolve(runtime ?? [join(resources, 'app.asar.unpacked', 'dsh'), join(resources, 'app.asar', 'dsh')].find(path => existsSync(join(path, 'node_modules/@deepseek-ai/dsh-app-boot/package.json'))) ?? join(resources, 'app.asar.unpacked', 'dsh'));
  if (existsSync(join(runtime, 'node_modules', PLUS, 'package.json'))) throw new Error('DSH-Plus: 此应用仍内置锁定插件，请安装新版桌面应用以迁移');
  seed = resolve(seed ?? join(resources, 'dsh-plus', 'seed'));
  const seedMetadata = readJson(join(seed, 'release.json'));
  const boot = await import(pathToFileURL(join(runtime, 'node_modules/@deepseek-ai/dsh-app-boot/lib/index.js')).href);
  const home = await import(pathToFileURL(join(runtime, 'node_modules/@deepseek-ai/dsh-home-paths/lib/index.js')).href);
  profile = resolve(profile ?? join(home.resolveDshHome(), 'profiles', 'desktop'));
  mkdirSync(profile, { recursive: true, mode: 0o700 });
  const marker = join(profile, MARKER);
  const manifestPath = join(profile, 'package.json');
  const lock = join(realpathSync(profile), 'lock');
  let descriptor;
  try { descriptor = openSync(lock, 'wx', 0o600); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const existing = lstatSync(lock);
    if (existing.isSymbolicLink() || !existing.isFile()) throw new Error('Plus bundle: Desktop profile lock is not a regular file');
    const owner = Number.parseInt(readFileSync(lock, 'utf8').trim(), 10);
    let active = !Number.isSafeInteger(owner) || owner <= 0;
    if (!active) {
      try { process.kill(owner, 0); active = true; }
      catch (signalError) { active = signalError.code !== 'ESRCH'; }
    }
    if (active) throw new Error('Plus bundle: Desktop profile is busy; close DSH before installing');
    // Match the official Desktop lock policy: only ESRCH confirms that its owner exited.
    unlinkSync(lock);
    descriptor = openSync(lock, 'wx', 0o600);
  }
  try {
    writeFileSync(descriptor, `${process.pid}\n`);
    const enrolled = existsSync(marker);
    const now = await getInstallState(profile);
    if (now.managed && compareVersions(now.version, seedMetadata.version) >= 0) {
      const refreshed = await prepareRelease({ directory: seed, root: now.root, version: now.version, runtime });
      const state = await activateRelease({ profile, release: refreshed, appVersion: seedMetadata.version });
      return { profile, enrolled: false, reason: 'already-enrolled', ...state };
    }
    if (!existsSync(manifestPath)) boot.initProfile(profile, boot.PROFILE_TEMPLATES.web.bundles);
    const manifest = readJson(manifestPath);
    const bundles = manifest.dsh?.profile?.bundles;
    if (!Array.isArray(bundles) || !bundles.every(name => typeof name === 'string')) throw new Error('DSH-Plus: invalid desktop profile bundles; existing configuration was preserved');
    const previouslyEnabled = bundles.some(name => [PLUS, LEGACY_PLUS, COMPOSITION].includes(name) || name.startsWith('@dsh-plus/desktop-'));
    const enabled = now.managed ? now.enabled : enrolled ? previouslyEnabled : true;
    const release = await prepareRelease({ directory: seed, root: join(profile, '.dsh-plus', 'releases'), version: seedMetadata.version, runtime });
    const state = await activateRelease({ profile, release, enabled, appVersion: seedMetadata.version });
    writeJson(marker, { schemaVersion: 2, package: PLUS, bundle: state.bundleName, version: state.version });
    return { profile, enrolled: !enrolled, reason: enrolled ? 'migrated' : 'enabled', ...state };
  } finally {
    closeSync(descriptor);
    unlinkSync(lock);
  }
}

async function main() {
  const { values, positionals } = parseArgs({ options: { output: { type: 'string' }, seed: { type: 'string' }, runtime: { type: 'string' }, platform: { type: 'string' }, arch: { type: 'string' }, resources: { type: 'string' }, plugin: { type: 'string' }, profile: { type: 'string' } }, allowPositionals: true });
  if (positionals.length !== 1 || !['stage', 'init-profile'].includes(positionals[0]) || (positionals[0] === 'init-profile' && !values.runtime && !values.resources)) throw new Error('Usage: plugin-bundle.mjs stage --output <seed> [--runtime <prepared-dsh>] [--plugin <plugin>] | init-profile --resources <resources> [--runtime <dsh>] [--profile <directory>]');
  const result = positionals[0] === 'stage' ? stagePluginBundle(values) : await initializePluginProfile(values);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
