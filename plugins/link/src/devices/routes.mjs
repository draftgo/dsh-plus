import { normalizeRoutes, normalizeTarget } from './registry.mjs';
import { probeRemote } from './remote.mjs';

const unreachable = new Set(['ECONNREFUSED', 'ETIMEDOUT', 'ENETUNREACH', 'EHOSTUNREACH', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET']);
/** Choose only among authenticated pairing candidates, before any business request is sent. */
export async function selectRoute(target, { timeout = 2500, signal, probe = probeRemote } = {}) {
  const routes = normalizeRoutes(target.routes);
  // Older pairings have one saved endpoint and retain their established trust policy.
  if (!routes?.length) return { ...target, ...normalizeTarget(target) };
  const ordered = [...routes.filter(route => route.kind === 'direct'), ...routes.filter(route => route.kind === 'relay')];
  let lastError;
  for (const route of ordered) {
    signal?.throwIfAborted();
    const candidate = { ...target, url: route.url, pin: route.kind === 'direct' ? route.pin : '' };
    try { await probe({ url: candidate.url, pin: candidate.pin }, { timeout, signal }); return candidate; }
    catch (error) {
      if (!unreachable.has(error.code) || error.statusCode === 401 || error.statusCode === 403) throw error;
      lastError = error;
    }
  }
  throw lastError;
}
