import { readFile, writeFile, mkdir, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DEFAULT_UPDATE_CONFIG, normalizeUpdateConfig, fetchVerifiedRelease, fetchUpdateBytes, verifyArtifact, isEngineCompatible, isNewerVersion, resolveUpdateUrl } from '../shared/update-feed.mjs';
import { prepareRelease, activateRelease, getInstallState, rollbackRelease } from '../shared/plugin-install.mjs';
import { assertSameOrigin } from '../voice/src/web.mjs';
import { readLimited } from '../voice/src/media.mjs';

const json = async path => JSON.parse(await readFile(path, 'utf8'));
const conflict = message => Object.assign(new Error(message), { status: 409 });

/** Each immutable release is staged before one profile manifest switch; loaded code stays intact. */
export async function createUpdates({ directory, profile, runtime, version, engineVersion, isBusy = () => false,
  installation = 'desktop', fetcher = globalThis.fetch, publicKey, install = { prepareRelease, activateRelease, getInstallState, rollbackRelease } }) {
  const configFile = join(directory, 'updates.json');
  const lifetime = new AbortController();
  const updateFetch = (url, options = {}) => fetcher(url, { ...options, signal: AbortSignal.any([lifetime.signal, ...(options.signal ? [options.signal] : [])]) });
  let config = { ...DEFAULT_UPDATE_CONFIG }, phase = 'idle', release = null, error = '', checkedAt = null, task = null, closed = false;
  try { config = normalizeUpdateConfig(await json(configFile)); } catch (failure) { if (failure.code !== 'ENOENT') error = '更新源配置读取失败，请重新选择更新来源'; }
  const installed = async () => profile ? await install.getInstallState(profile) : { managed: false };
  const status = async () => {
    const state = await installed(), busy = !!(await isBusy());
    const restartRequired = !!state.managed && state.version !== version;
    const compatible = !!release && !!engineVersion && isEngineCompatible(engineVersion, release.engine);
    return {
      phase: restartRequired ? 'ready' : phase, installation, notice: phase === 'unpublished' ? '更新通道尚未就绪' : '', config, current: { plugin: version, engine: engineVersion, app: state.appVersion },
      managed: !!state.managed, busy, restartRequired, checkedAt, error,
      canInstall: !!state.managed && !busy && !restartRequired && !task && compatible && isNewerVersion(release.plugin.version, version),
      canRollback: !!state.managed && !!state.previous && !restartRequired && !task,
      release: release ? { ...release, plugin: { ...release.plugin, available: isNewerVersion(release.plugin.version, version), compatible, reason: compatible ? undefined : '请先升级应用，以匹配此插件需要的引擎。' },
        ...(release.app ? { app: { ...release.app, available: !state.appVersion || isNewerVersion(release.app.version, state.appVersion), url: resolveUpdateUrl(release.app.url, config) } } : {}) } : null,
    };
  };
  const start = work => {
    error = '';
    task = Promise.resolve().then(work).catch(failure => {
      if (failure.code === 'UPDATE_UNPUBLISHED') { release = null; error = ''; phase = 'unpublished'; }
      else { error = failure.message; phase = 'error'; }
    }).finally(() => { task = null; });
  };
  const guard = async () => {
    if (closed) throw conflict('更新服务已关闭');
    if (task) throw conflict('更新正在进行，请稍候');
    const state = await installed();
    if (!state.managed) throw conflict(installation === 'server' ? '此主机由服务器部署管理，请由维护者更新' : '此安装需要先升级一次应用，才能独立更新插件');
    if (state.version !== version) throw conflict('请先重启主机应用，使已准备的版本生效');
    if (await isBusy()) throw conflict('有任务正在运行，结束后再更新');
    return state;
  };
  // Reserve mutation admission synchronously, before asynchronous profile/task inspection.
  let dispatching = false;
  const dispatch = async input => {
    if (input.action === 'status') return status();
    if (closed) throw conflict('更新服务已关闭');
    if (dispatching || task) throw conflict('更新正在进行，请稍候');
    dispatching = true;
    try {
      switch (input.action) {
        case 'configure': {
          const state = await installed();
          if (state.managed && state.version !== version) throw conflict('请先重启主机应用');
          const next = normalizeUpdateConfig(input);
          await mkdir(directory, { recursive: true, mode: 0o700 });
          const temporary = `${configFile}.${randomUUID()}.tmp`;
          try { await writeFile(temporary, JSON.stringify(next), { mode: 0o600 }); await rename(temporary, configFile); }
          finally { await rm(temporary, { force: true }); }
          config = next; release = null; error = ''; phase = 'idle'; checkedAt = null;
          break;
        }
        case 'check': {
          phase = 'checking';
          start(async () => {
            const next = await fetchVerifiedRelease({ config, fetcher: updateFetch, publicKey });
            release = next;
            checkedAt = new Date().toISOString(); phase = 'idle';
          });
          break;
        }
        case 'install': {
          const state = await guard();
          if (!release || !engineVersion || !isEngineCompatible(engineVersion, release.engine)) throw conflict('请先检查可兼容的插件版本');
          if (!isNewerVersion(release.plugin.version, version)) throw conflict('插件已是最新版本');
          const selected = release;
          phase = 'downloading';
          start(async () => {
            const archive = join(state.root, `.download-${randomUUID()}.tar.gz`);
            try {
              const bytes = verifyArtifact(await fetchUpdateBytes(selected.plugin.url, { config, fetcher: updateFetch, maxBytes: selected.plugin.size, timeoutMs: 5 * 60_000 }), selected.plugin);
              if (closed) throw new Error('更新已取消');
              await mkdir(state.root, { recursive: true, mode: 0o700 });
              await writeFile(archive, bytes, { mode: 0o600 });
              const prepared = await install.prepareRelease({ archive, root: state.root, version: selected.plugin.version, runtime });
              if (closed) throw new Error('更新已取消');
              if (await isBusy()) throw conflict('下载期间有新任务开始，结束后再点更新');
              await install.activateRelease({ profile, release: prepared });
              phase = 'ready';
            } finally { await rm(archive, { force: true }); }
          });
          break;
        }
        case 'rollback': {
          const state = await guard();
          if (!state.previous) throw conflict('暂无可回退版本');
          phase = 'downloading';
          start(async () => { if (await isBusy()) throw conflict('有任务正在运行'); await install.rollbackRelease({ profile, runtime }); phase = 'ready'; });
          break;
        }
        default: throw new Error('未知更新操作');
      }
      return status();
    } finally { dispatching = false; }
  };
  return { dispatch, status, settled: async () => { await task; }, close: async () => { closed = true; lifetime.abort(); await task; } };
}

export async function mountUpdates(ctx, commander, options = {}) {
  const context = ctx.get('profileContext');
  const runtime = context?.installAnchor && dirname(context.installAnchor);
  const pkg = await json(new URL('../package.json', import.meta.url));
  let engineVersion;
  try { engineVersion = (await json(join(runtime, 'node_modules/@deepseek-ai/dsh-app-boot/package.json'))).version; } catch {}
  const service = await createUpdates({ directory: commander.store.directory, profile: context?.dir, runtime, installation: context?.name === 'desktop' ? 'desktop' : 'server', version: pkg.version, engineVersion,
    isBusy: () => commander.list().some(session => ['running', 'connecting', 'waiting'].includes(session.status)) ||
      (ctx.get('agents')?.list?.() ?? []).some(agent => agent.status === 'running'), ...options });
  const fetch = async request => {
    try {
      assertSameOrigin(request);
      if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw Object.assign(new Error('Expected application/json'), { status: 415 });
      const input = JSON.parse(new TextDecoder().decode(await readLimited(request, 4096)));
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('请求必须为 JSON 对象');
      return Response.json(await service.dispatch(input), { headers: { 'cache-control': 'no-store' } });
    } catch (failure) { return Response.json({ error: failure.message }, { status: failure.status || 400, headers: { 'cache-control': 'no-store' } }); }
  };
  ctx.effect(() => ctx.connection.fetch.register({ path: '/api/commander/updates', methods: ['POST'], requestBody: 'buffered', fetch }));
  ctx.effect(() => () => service.close());
  return service;
}
