import { X509Certificate, createHash, createPrivateKey, createPublicKey, generateKeyPair } from 'node:crypto';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import selfsigned from 'selfsigned';
import { promisify } from 'node:util';

/** Stable TLS key; the QR binds its actual SPKI, never a fabricated identity. */
export async function loadIdentity(directory) {
  const path = join(directory, 'tls.json');
  let value;
  try { value = JSON.parse(await readFile(path, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (!value) {
    const keys = await promisify(generateKeyPair)('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
    const cert = selfsigned.generate([{ name: 'commonName', value: 'DSH Link' }], {
      keyPair: keys, keySize: 2048, days: 3650, algorithm: 'sha256', extensions: [
        { name: 'basicConstraints', cA: false },
        { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
        { name: 'extKeyUsage', serverAuth: true },
        { name: 'subjectAltName', altNames: [{ type: 2, value: 'localhost' }, { type: 7, ip: '127.0.0.1' }, { type: 7, ip: '::1' }] },
      ],
    });
    value = { key: cert.private, cert: cert.cert };
    await writeFile(`${path}.tmp`, JSON.stringify(value), { mode: 0o600 });
    await rename(`${path}.tmp`, path);
  }
  const certificate = new X509Certificate(value.cert);
  if (!certificate.checkPrivateKey(createPrivateKey(value.key))) throw new Error('Link TLS 密钥与证书不匹配');
  if (Date.parse(certificate.validTo) < Date.now()) throw new Error('Link TLS 证书已到期');
  const pin = createHash('sha256').update(createPublicKey(value.cert).export({ type: 'spki', format: 'der' })).digest('base64');
  // Useful when a self-hosted reverse proxy verifies its upstream certificate.
  await writeFile(join(directory, 'host-cert.pem'), value.cert, { mode: 0o600 });
  return { ...value, pin };
}
