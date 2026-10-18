import { join } from 'node:path';
import { ToolInstaller } from './tool-install.mjs';
import { createToolProfiles } from './tool-profiles.mjs';
import { createSessionRoutes } from './session-routes.mjs';
import { createPickerCatalog } from './picker-catalog.mjs';
import { assertProviderToolAccess } from './provider-access.mjs';
import { createNativeAuth } from './native-auth.mjs';
import { assertSameOrigin } from '../voice/src/web.mjs';
import { readLimited } from '../voice/src/media.mjs';

/** Owner-only management surface; credentials are resolved only inside adapters. */
export async function mountTooling(ctx, commander, providers, options = {}) {
  const busy = tool => [...commander.sessions.values()].some(session => session.provider === tool &&
    (commander.drivers.has(session.id) || commander.connecting.has(session.id) || ['running', 'connecting', 'waiting'].includes(session.status)));
  const installer = options.installer ?? new ToolInstaller({ root: join(commander.store.directory, 'tools'), isRunning: busy });
  providers.setNativeAuth?.(createNativeAuth({ installer }));
  const profiles = options.profiles ?? createToolProfiles({ directory: commander.store.directory, providers });
  commander.toolInstaller = installer; commander.toolProfiles = profiles;
  const routeService = createSessionRoutes({ directory: commander.store.directory, providers, profiles });
  const pickerCatalog = createPickerCatalog({ commander, installer, profiles, providers, routeService, llm: ctx.llm });
  commander.routeService = routeService; commander.pickerCatalog = pickerCatalog;
  // Direct official provider selections must obey the same subscription boundary
  // as opaque native routes, including auxiliary requests and stored selections.
  if (ctx.on && providers.describeAccess) ctx.on('llm/stream', async function* (options, next) {
    if (!options.provider?.startsWith('commander-') && ctx.llm?.listConfigurableProviders?.().some(entry => entry.provider === options.provider)) {
      const access = await providers.describeAccess(options.provider);
      try { assertProviderToolAccess(access, 'harness'); }
      catch (error) {
        yield { type: 'finish', reason: { kind: 'error', failure: { code: error.code, message: error.message + ' 请在模型菜单中选择对应的 Harness 工具。' } } };
        return;
      }
    }
    yield* next();
  });
  const dispatch = async (input, signal) => {
    switch (input.action) {
      case 'pickerCatalog': return pickerCatalog.list();
      case 'catalog': return { tools: (await installer.list()).map(tool => ({ ...tool, routeSupported: routeService.supports(tool.id).supported, routeReason: routeService.supports(tool.id).reason })), ...await profiles.list(), providerAccess: await providers.accessList?.() ?? [] };
      case 'profiles': return profiles.list();
      case 'providers': return { providers: await providers.list() };
      case 'models': return { models: await providers.models(input.providerId, signal) };
      case 'job': return { job: installer.job(input.id) };
      case 'install': return { job: installer.install(input.tool) };
      case 'update': return { job: installer.updateTool(input.tool) };
      case 'reinstall': return { job: installer.reinstall(input.tool) };
      case 'uninstall': return { job: installer.uninstall(input.tool) };
      case 'cancel': return { job: installer.cancel(input.id) };
      case 'setDefault': {
        const profile = (await profiles.list()).profiles?.find(item => item.tool === input.tool);
        if (!profile || profile.revision !== input.revision) throw Object.assign(Error('工具方案已变更，请刷新'), { status: 409 });
        await routeService.capture({ ...profile, tool: input.tool });
        return profiles.setDefault(input);
      }
      case 'saveProfile': return { profile: await profiles.save(input) };
      case 'setBindings': return profiles.setBindings(input);
      case 'preview': return { preview: await profiles.preview(input) };
      case 'apply': {
        if (input.confirmNativeWrite !== true) throw Object.assign(Error('同步本机配置需要显式确认；设置新会话默认不会修改本机配置'), { status: 409 });
        if (busy(input.tool)) throw Object.assign(Error('工具仍有连接中的会话，请先断开再应用配置'), { status: 409 });
        if (!input.revision || !input.checksums || typeof input.checksums !== 'object' || Array.isArray(input.checksums)) throw Error('请先预览并确认配置文件版本');
        return { result: await profiles.apply(input) };
      }
      case 'restore': {
        if (input.confirmNativeWrite !== true) throw Object.assign(Error('恢复本机配置需要显式确认'), { status: 409 });
        const { backups } = await profiles.list(), backup = backups.find(row => row.id === input.backupId);
        if (backup && busy(backup.tool)) throw Object.assign(Error('工具仍有连接中的会话，请先断开再恢复'), { status: 409 });
        return { result: await profiles.restore(input) };
      }
      default: throw Error('未知工具管理操作');
    }
  };
  const fetch = async request => {
    try {
      assertSameOrigin(request);
      if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw Object.assign(Error('Expected application/json'), { status: 415 });
      const input = JSON.parse(new TextDecoder().decode(await readLimited(request, 300 * 1024)));
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('请求必须为 JSON 对象');
      return Response.json(await dispatch(input, request.signal), { headers: { 'cache-control': 'no-store' } });
    } catch (error) {
      // Provider/installer failures carry controlled messages; never serialize options or resolved secrets.
      return Response.json({ error: error.message }, { status: Number.isInteger(error.status) ? error.status : 400, headers: { 'cache-control': 'no-store' } });
    }
  };
  ctx.effect(() => ctx.connection.fetch.register({ path: '/api/commander/tooling', methods: ['POST'], requestBody: 'buffered', fetch }));
  ctx.effect(() => async () => {
    if (commander.toolInstaller === installer) { commander.toolInstaller = undefined; commander.toolProfiles = undefined; if (commander.routeService === routeService) commander.routeService = undefined; if (commander.pickerCatalog === pickerCatalog) commander.pickerCatalog = undefined; }
    await installer.close();
  });
  return { installer, profiles, fetch };
}
