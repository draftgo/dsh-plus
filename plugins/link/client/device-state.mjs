const statuses = { online: '可连接', connected: '已连接', offline: '离线', connecting: '连接中', failed: '连接失败', disconnected: '未连接', unknown: '未检测' };
export function deviceStatus(device) { return statuses[device?.status] || '未检测'; }
export function deviceKind(device) { return device?.kind === 'ssh' ? '服务器' : device?.kind === 'local' ? '本机' : '电脑'; }
export function jobFinished(job) { return ['ready', 'done', 'completed', 'succeeded', 'success', 'failed', 'error'].includes(job?.state); }
export function jobFailed(job) { return ['failed', 'error'].includes(job?.state); }
export function sshInput(form) {
  const port = Number(form.port);
  if (!form.host.trim() || !form.username.trim()) throw new Error('请填写服务器地址和用户名');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('SSH 端口应为 1–65535');
  return { host: form.host.trim(), port, username: form.username.trim(), name: form.name.trim() || form.host.trim(), source: form.source, ...(form.auth === 'key' ? { privateKey: form.privateKey, passphrase: form.passphrase } : { password: form.password }) };
}
/** Only isolated loopback proxies or trusted HTTPS workbenches may be embedded. */
export function workbenchUrl(value, origin) {
  const url = new URL(value, origin);
  if (url.username || url.password || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))) throw new Error('工作台地址无效');
  return url.href;
}
