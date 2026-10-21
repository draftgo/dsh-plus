export const RELAY_CONTROL_PATH = '/__link/relay/control';
export const RELAY_DATA_PATH = '/__link/relay/data';
export const RELAY_WORKBENCH_PATH = '/link/workbench/';
export const RELAY_VOICE_PATH = '/link/workbench/api/voice/realtime';
export const RELAY_CHUNK_BYTES = 48 * 1024;

export function relayPathAllowed(method, path) {
  if (typeof method !== 'string' || typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') || path.includes('\\') || /%(?:2f|5c|00)/i.test(path)) return false;
  let decoded;
  try { decoded = decodeURIComponent(path.split('?')[0]); } catch { return false; }
  if (decoded.split('/').some(part => part === '.' || part === '..')) return false;
  const pathname = path.split('?')[0];
  if (pathname === '/link/api/info') return method === 'GET';
  if (['/link/api/pair', '/link/api/pair/status', '/link/api/rpc', '/link/api/workbench'].includes(pathname)) return method === 'POST';
  if (['/link', '/link/', '/link/index.html', '/link/app.js', '/link/app.css'].includes(pathname)) return method === 'GET' || method === 'HEAD';
  if (!pathname.startsWith(RELAY_WORKBENCH_PATH) || !['GET', 'HEAD', 'POST'].includes(method)) return false;
  const route = pathname.slice(RELAY_WORKBENCH_PATH.length);
  return !/^(?:api\/commander-(?:link|devices)|api\/(?:owner|admin)(?:\/|$))/i.test(route);
}
