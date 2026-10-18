/** Run once. Only the public key is distributed; keep the private file outside version control. */
import { generateKeyPairSync } from 'node:crypto';
import { mkdir, writeFile, access } from 'node:fs/promises';
const privatePath = new URL('../../.local/release-keys/dsh-plus-update-private.pem', import.meta.url);
const publicPath = new URL('../../plugins/commander/shared/update-public-key.pem', import.meta.url);
for (const path of [privatePath, publicPath]) {
  try { await access(path); throw new Error('更新签名密钥已存在，拒绝覆盖'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
await mkdir(new URL('./', privatePath), { recursive: true, mode: 0o700 });
await writeFile(privatePath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600, flag: 'wx' });
await writeFile(publicPath, publicKey.export({ type: 'spki', format: 'pem' }), { flag: 'wx' });
console.log('已生成更新签名密钥。私钥仅存 .local/release-keys/dsh-plus-update-private.pem；发布前将其安全配置到 GitHub Actions 的 DSH_PLUS_UPDATE_PRIVATE_KEY Secret。');
