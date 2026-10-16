import { mkdir, open, readFile, rename, rm, lstat, chmod } from 'node:fs/promises';
import { join, dirname, resolve, parse } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { ToolConfigError, TOOL_IDS, toolId, toolCapabilities, nativeConfigFiles, nativePatches, parseConfig, renderConfig, validateObject } from './tool-config.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const text = (value, label) => { if (typeof value !== 'string' || !value.trim() || value.length > 512 || /[\u0000-\u001f]/u.test(value)) throw new ToolConfigError('无效的' + label); return value.trim(); };
async function safePath(path) { let part = resolve(path); while (part !== parse(part).root) { try { const info = await lstat(part); if (info.isSymbolicLink()) throw new ToolConfigError('配置路径不能经过符号链接', 409); } catch (e) { if (e.code !== 'ENOENT') throw e; } part = dirname(part); } }
async function read(path) { await safePath(path); try { const info = await lstat(path); if (!info.isFile() || info.size > 8 * 1024 * 1024) throw new ToolConfigError('配置文件类型或大小不受支持', 409); return await readFile(path, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } }
async function atomic(path, value) {
  await safePath(path); await mkdir(dirname(path), { recursive: true, mode: 0o700 }); const temporary = path + '.' + randomUUID() + '.tmp'; let handle;
  try { handle = await open(temporary, 'wx', 0o600); await handle.writeFile(value); await handle.sync(); await handle.close(); handle = null; await safePath(path); await rename(temporary, path); await chmod(path, 0o600); }
  finally { await handle?.close(); await rm(temporary, { force: true }); }
}
export function createToolProfiles({ directory, providers, ...paths }) {
  if (!directory || !providers?.resolve) throw new TypeError('directory and official provider resolver are required');
  const storePath = join(directory, 'tool-profiles.json'), backupDir = join(directory, 'tool-config-backups'); let queue = Promise.resolve();
  const exclusive = operation => { const result = queue.then(async () => { await mkdir(directory, { recursive: true, mode: 0o700 }); const lock = join(directory, '.tool-profiles.lock'); try { await mkdir(lock, { mode: 0o700 }); } catch (e) { if (e.code === 'EEXIST') throw new ToolConfigError('工具配置正在由其他操作更新，请稍后重试', 409); throw e; } try { return await operation(); } finally { await rm(lock, { recursive: true, force: true }); } }); queue = result.catch(() => {}); return result; };
  const state = async () => { const raw = await read(storePath); if (!raw) return { version: 1, profiles: {}, bindings: {}, backups: [] }; try { const data = JSON.parse(raw); if (data.version !== 1 || !object(data.profiles) || !object(data.bindings) || !Array.isArray(data.backups)) throw Error(); validateObject(data); return data; } catch { throw new ToolConfigError('工具配置存储损坏，原文件已保留', 409); } };
  const persist = data => atomic(storePath, JSON.stringify(data, null, 2) + '\n');
  const sanitize = profile => profile ? structuredClone(profile) : null;
  const build = async (input, data) => {
    const tool = toolId(input.tool), profile = data.profiles[tool]; if (!profile) throw new ToolConfigError('请先保存工具配置', 409);
    if (input.revision && input.revision !== profile.revision) throw new ToolConfigError('工具方案已变更，请重新预览', 409);
    if (data.bindings[profile.providerId] && !data.bindings[profile.providerId].includes(tool)) throw new ToolConfigError('此供应商未绑定当前工具', 409);
    const provider = await providers.resolve(profile.providerId);
    let address; try { address = new URL(provider.baseURL); } catch { throw new ToolConfigError('供应商地址无效'); }
    if (!['http:', 'https:'].includes(address.protocol) || address.username || address.password || address.search || address.hash || typeof provider.apiKey !== 'string' || !provider.apiKey || /[\r\n\u0000]/u.test(provider.apiKey)) throw new ToolConfigError('供应商连接配置无效');
    if (JSON.stringify(profile.overrides).includes(provider.apiKey)) throw new ToolConfigError('高级配置不能包含供应商密钥');
    const files = [], current = {};
    for (const spec of nativeConfigFiles(tool, paths)) { const before = await read(spec.path); current[spec.role] = parseConfig(before || '', spec.format); files.push({ ...spec, before }); }
    const patches = nativePatches(profile, provider, current);
    for (const item of files) { item.after = renderConfig(item.before || '', item.format, patches[item.role]); item.checksum = item.before === null ? null : hash(item.before); }
    return { tool, profile, files, warnings: [tool === 'mcode' ? 'MiniMax 的当前模型由原生工具选择；这里只登记供应商和模型。' : '正在运行的原生工具可能需要重启才能读取新配置。', ...(files.some(x => ['toml', 'json5'].includes(x.format)) ? ['TOML/JSON5 保留所有配置字段，格式与注释可能重排。'] : []), ...(tool === 'claude-desktop' ? ['需要支持第三方 gateway profile 的 Claude Desktop 版本。'] : [])] };
  };
  const publicFiles = files => files.map(x => ({ role: x.role, path: x.path, exists: x.before !== null, checksum: x.checksum, changed: x.before !== x.after }));
  async function transact(data, tool, files, restoreOf, appliedProfile) {
    const changed = files.filter(x => x.before !== x.after); if (!changed.length) { data.applied ??= {}; if (appliedProfile) data.applied[tool] = structuredClone(appliedProfile); else delete data.applied[tool]; await persist(data); return { tool, backupId: null, files: files.map(x => ({ path: x.path, checksum: x.before === null ? null : hash(x.before) })), warnings: [] }; }
    const id = randomUUID(), createdAt = new Date().toISOString(), backup = { version: 1, id, tool, appliedProfile: data.applied?.[tool] || null, files: changed.map(x => ({ path: x.path, before: x.before, afterChecksum: x.after === null ? null : hash(x.after) })) };
    await atomic(join(backupDir, id + '.json'), JSON.stringify(backup));
    const written = [];
    try {
      for (const item of changed) {
        const actual = await read(item.path); if (actual !== item.before) throw new ToolConfigError('原生配置被其他程序修改，请重新预览', 409);
        if (item.after === null) await rm(item.path); else await atomic(item.path, item.after); written.push(item);
      }
      data.applied ??= {}; if (appliedProfile) data.applied[tool] = structuredClone(appliedProfile); else delete data.applied[tool];
      data.backups.push({ id, tool, createdAt, files: changed.map(x => x.path), ...(restoreOf ? { restoreOf } : {}) }); await persist(data);
    } catch (error) {
      let conflict = false;
      for (const item of written.reverse()) { if (await read(item.path) !== item.after) { conflict = true; continue; } if (item.before === null) await rm(item.path, { force: true }); else await atomic(item.path, item.before); }
      if (conflict) throw new ToolConfigError('写入失败且配置随后被外部修改，已保留备份供人工恢复', 409); throw error;
    }
    return { tool, backupId: id, files: files.map(x => ({ path: x.path, checksum: x.after === null ? null : hash(x.after) })), warnings: [] };
  }
  return {
    async list() { const data = await state(); return { profiles: Object.values(data.profiles).map(sanitize), applied: Object.values(data.applied || {}).map(sanitize), backups: data.backups.map(x => structuredClone(x)), capabilities: toolCapabilities(), bindings: structuredClone(data.bindings), defaults: Object.values(data.defaults || {}).map(sanitize) }; },
    async get(tool) { return sanitize((await state()).profiles[toolId(tool)]); },
    async runtime(tool) {
      tool = toolId(tool); const data = await state(), profile = data.applied?.[tool]; if (!profile) return { configured: false, env: {} };
      if (data.bindings[profile.providerId] && !data.bindings[profile.providerId].includes(tool)) throw new ToolConfigError('此供应商未绑定当前工具', 409);
      const { baseURL, apiKey } = await providers.resolve(profile.providerId);
      const env = tool === 'claude' ? { ANTHROPIC_BASE_URL: baseURL, ANTHROPIC_API_KEY: apiKey, ANTHROPIC_AUTH_TOKEN: apiKey, ANTHROPIC_MODEL: profile.model } : tool === 'gemini' ? { GEMINI_API_KEY: apiKey, GOOGLE_GEMINI_BASE_URL: baseURL, GEMINI_MODEL: profile.model } : {};
      return { configured: true, providerId: profile.providerId, model: profile.model, provider: ['pi', 'opencode'].includes(tool) ? 'dsh-plus' : undefined, env };
    },
    setBindings(input) { return exclusive(async () => { const data = await state(), providerId = text(input.providerId, '供应商'); await providers.resolve(providerId); if (!Array.isArray(input.tools) || input.tools.length > TOOL_IDS.length + 1) throw new ToolConfigError('无效的工具绑定'); data.bindings[providerId] = [...new Set(input.tools.map(id => id === 'harness' ? id : toolId(id)))]; await persist(data); return { bindings: structuredClone(data.bindings) }; }); },
    save(input) { return exclusive(async () => {
      const data = await state(), tool = toolId(input.tool), providerId = text(input.providerId, '供应商'), model = text(input.model, '模型'), overrides = input.overrides || {};
      if (!object(overrides) || JSON.stringify(overrides).length > 256 * 1024) throw new ToolConfigError('高级配置须为 JSON 对象且不超过 256 KiB'); validateObject(overrides, { overrides: true });
      if (input.expectedRevision && input.expectedRevision !== data.profiles[tool]?.revision) throw new ToolConfigError('工具方案被修改，请刷新', 409);
      const capability = toolCapabilities().find(x => x.tool === tool), protocol = input.protocol || capability.protocols[0]; if (!capability.protocols.includes(protocol)) throw new ToolConfigError('工具不支持此协议');
      if (input.contextWindow !== undefined && (!Number.isSafeInteger(input.contextWindow) || input.contextWindow <= 0)) throw new ToolConfigError('上下文窗口须为正整数');
      const provider = await providers.resolve(providerId); if (JSON.stringify(overrides).includes(provider.apiKey)) throw new ToolConfigError('高级配置不能包含供应商密钥');
      if (data.bindings[providerId] && !data.bindings[providerId].includes(tool)) throw new ToolConfigError('此供应商未绑定当前工具', 409);
      const profile = { tool, providerId, model, protocol, overrides: structuredClone(overrides), ...(input.contextWindow ? { contextWindow: input.contextWindow } : {}), revision: randomUUID(), updatedAt: new Date().toISOString() };
      data.profiles[tool] = profile; await persist(data); return sanitize(profile);
    }); },
    setDefault(input) { return exclusive(async () => {
      const data = await state(), tool = toolId(input.tool), profile = data.profiles[tool];
      if (!profile || input.revision !== profile.revision) throw new ToolConfigError('工具方案已变更，请刷新后保存默认', 409);
      if (data.bindings[profile.providerId] && !data.bindings[profile.providerId].includes(tool)) throw new ToolConfigError('此供应商未绑定当前工具', 409);
      await providers.resolve(profile.providerId);
      data.defaults ??= {}; data.defaults[tool] = structuredClone(profile); await persist(data);
      return { profile: sanitize(profile) };
    }); },
    async preview(input) { const result = await build(input, await state()); return { tool: result.tool, revision: result.profile.revision, files: publicFiles(result.files), warnings: result.warnings }; },
    apply(input) { return exclusive(async () => { const data = await state(), result = await build(input, data); if (input.checksums) for (const item of result.files) if (!Object.hasOwn(input.checksums, item.path) || input.checksums[item.path] !== item.checksum) throw new ToolConfigError('原生配置已变更，请重新预览', 409); const applied = await transact(data, result.tool, result.files, undefined, result.profile); return { ...applied, warnings: result.warnings }; }); },
    restore(input) { return exclusive(async () => {
      const data = await state(), info = data.backups.find(x => x.id === input.backupId); if (!info || !/^[a-f0-9-]{36}$/u.test(info.id)) throw new ToolConfigError('备份不存在', 404);
      const backup = JSON.parse(await read(join(backupDir, info.id + '.json'))), allowed = new Set(nativeConfigFiles(info.tool, paths).map(x => x.path)), files = [];
      for (const item of backup.files) { if (!allowed.has(item.path)) throw new ToolConfigError('备份目标与当前工具路径不一致', 409); const before = await read(item.path), checksum = before === null ? null : hash(before); if (checksum !== item.afterChecksum || input.checksums && input.checksums[item.path] !== checksum) throw new ToolConfigError('原生配置在备份后已变更，拒绝覆盖；请先另存并手动合并', 409); files.push({ path: item.path, before, after: item.before }); }
      return transact(data, info.tool, files, info.id, backup.appliedProfile);
    }); },
  };
}
