// The page origin identifies the host the user is already connected to. A cloud
// installation should reuse its trusted HTTPS entry instead of a server NIC.
export function connectionDefaults(location) {
  const hostname = String(location?.hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  const octets = hostname.split('.').map(Number);
  const privateV4 = octets.length === 4 && octets.every(value => Number.isInteger(value) && value >= 0 && value <= 255) && (octets[0] === 0 || octets[0] === 10 || octets[0] === 127 || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) || (octets[0] === 192 && octets[1] === 168) || (octets[0] === 169 && octets[1] === 254));
  const local = !hostname || hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local') || hostname === '::1' || hostname === '::' || /^(?:fc|fd|fe[89ab])[0-9a-f]*:/i.test(hostname) || privateV4;
  const publicOrigin = location?.protocol === 'https:' && !local ? String(location.origin || '') : '';
  return { mode: publicOrigin ? 'public' : 'lan', publicUrl: publicOrigin };
}
