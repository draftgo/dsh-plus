/** Build-time Plus packaging and one-time profile enrollment using the official bundle API. */
import { spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, openSync, closeSync, readFileSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const PLUS = '@dowork/commander';
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
export function stagePluginBundle({ runtime, plugin = resolve(import.meta.dirname, '../../plugins/commander'), platform = process.platform, arch = process.arch }) {
  runtime = resolve(runtime); plugin = resolve(plugin);
  const manifest = readJson(join(plugin, 'package.json'));
  if (manifest.name !== PLUS || !manifest.dsh?.bundle?.patch) throw new Error('Plus bundle: expected the Commander bundle package');
  const destination = join(runtime, 'node_modules', PLUS);
  const composition = join(runtime, 'node_modules', COMPOSITION);
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
  const shared = new Set();
  const copied = new Set();
  const omitted = new Set();
  const assertShared = (name, spec) => {
    const directory = join(runtime, 'node_modules', name);
    if (!existsSync(join(directory, 'package.json'))) throw new Error(`Plus bundle: official runtime omits ${name}`);
    const version = readJson(join(directory, 'package.json')).version;
    const semver = createRequire(realpathSync(join(runtime, 'node_modules/@deepseek-ai/dsh-app-boot/package.json')))('semver');
    if (!semver.satisfies(version, spec, { includePrerelease: true })) throw new Error(`Plus bundle: ${name}@${version} does not satisfy ${spec}`);
    shared.add(name);
  };
  function dependencies(source, target, ancestors = new Set()) {
    const metadata = readJson(join(source, 'package.json'));
    const optional = metadata.optionalDependencies ?? {};
    for (const [name, spec] of Object.entries({ ...metadata.dependencies, ...optional })) {
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
    // The official resolver excludes a selected bundle itself. A separate composition bundle makes
    // Commander a carried dependency, so both Host plugin rows and client injection can resolve it.
    mkdirSync(composition, { recursive: true });
    writeJson(join(composition, 'package.json'), {
      name: COMPOSITION, displayName: 'DSH-Plus Desktop', version: manifest.version, private: true, type: 'module', license: 'MIT',
      dependencies: { [PLUS]: manifest.version }, dsh: { bundle: { patch: './cordis.patch.yml' } },
    });
    copyFileSync(join(plugin, 'cordis.patch.yml'), join(composition, 'cordis.patch.yml'));
    return { name: PLUS, bundle: COMPOSITION, version: manifest.version, destination, dependencies: [...copied].sort(), shared: [...shared].sort(), omittedOptionalDependencies: [...omitted].sort() };
  } catch (error) {
    rmSync(destination, { recursive: true, force: true });
    rmSync(composition, { recursive: true, force: true });
    throw error;
  }
}

/** Enable Plus once; preserve user bundles, patches, dependencies and later disable/recovery choices. */
export async function initializePluginProfile({ runtime, resources, profile }) {
  runtime = resolve(runtime ?? [join(resources, 'app.asar', 'dsh'), join(resources, 'app.asar.unpacked', 'dsh')].find(path => existsSync(join(path, 'node_modules', PLUS, 'package.json'))) ?? join(resources, 'app.asar', 'dsh'));
  const bundle = join(runtime, 'node_modules', PLUS, 'package.json');
  if (!existsSync(bundle)) throw new Error(`Plus bundle: plugin is missing at ${bundle}`);
  if (!existsSync(join(runtime, 'node_modules', COMPOSITION, 'package.json'))) throw new Error('Plus bundle: desktop composition is missing; run stage first');
  const boot = await import(pathToFileURL(join(runtime, 'node_modules/@deepseek-ai/dsh-app-boot/lib/index.js')).href);
  const home = await import(pathToFileURL(join(runtime, 'node_modules/@deepseek-ai/dsh-home-paths/lib/index.js')).href);
  profile = resolve(profile ?? join(home.resolveDshHome(), 'profiles', 'desktop'));
  mkdirSync(profile, { recursive: true, mode: 0o700 });
  const marker = join(profile, MARKER);
  if (existsSync(marker)) return { profile, enrolled: false, reason: 'already-enrolled' };
  const lock = join(profile, 'lock');
  let descriptor;
  try { descriptor = openSync(lock, 'wx', 0o600); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error('Plus bundle: Desktop profile is busy; close DSH before installing');
    throw error;
  }
  const temporary = join(profile, `.dsh-plus-package-${process.pid}.tmp`);
  try {
    writeFileSync(descriptor, `${process.pid}\n`);
    if (existsSync(marker)) return { profile, enrolled: false, reason: 'already-enrolled' };
    boot.initProfile(profile, boot.PROFILE_TEMPLATES.web.bundles);
    const manifestPath = join(profile, 'package.json');
    const manifest = readJson(manifestPath);
    const bundles = manifest.dsh?.profile?.bundles;
    if (!Array.isArray(bundles) || !bundles.every(name => typeof name === 'string')) throw new Error('Plus bundle: invalid desktop profile bundles; existing configuration was preserved');
    const alreadyEnabled = bundles.includes(COMPOSITION);
    if (!alreadyEnabled || bundles.includes(PLUS)) {
      const selected = bundles.filter(name => name !== PLUS);
      manifest.dsh.profile.bundles = selected.includes(COMPOSITION) ? selected : [...selected, COMPOSITION];
      writeJson(temporary, manifest);
      renameSync(temporary, manifestPath);
    }
    // A separate marker also remembers a deliberate disable or official recovery after installation.
    writeJson(marker, { schemaVersion: 1, package: PLUS, bundle: COMPOSITION, version: readJson(bundle).version });
    return { profile, enrolled: !alreadyEnabled, reason: alreadyEnabled ? 'already-enabled' : 'enabled' };
  } finally {
    rmSync(temporary, { force: true });
    closeSync(descriptor);
    unlinkSync(lock);
  }
}

async function main() {
  const { values, positionals } = parseArgs({ options: { runtime: { type: 'string' }, platform: { type: 'string' }, arch: { type: 'string' }, resources: { type: 'string' }, plugin: { type: 'string' }, profile: { type: 'string' } }, allowPositionals: true });
  if (positionals.length !== 1 || !['stage', 'init-profile'].includes(positionals[0]) || (!values.runtime && !values.resources)) throw new Error('Usage: plugin-bundle.mjs stage --runtime <prepared-dsh> [--plugin <commander>] | init-profile --resources <resources> [--runtime <dsh.asar>] [--profile <directory>]');
  const result = positionals[0] === 'stage' ? stagePluginBundle(values) : await initializePluginProfile(values);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
