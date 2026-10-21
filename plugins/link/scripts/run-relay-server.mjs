import { readFile, stat } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { createRelayServer } from '../src/transport/relay-server.mjs';

const fail = message => { process.stderr.write(message + '\n'); process.exitCode = 1; };
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--config') {
  fail('用法: node run-relay-server.mjs --config /path/to/relay.json');
} else {
  let relay;
  try {
    const configPath = resolve(args[1]), configStat = await stat(configPath);
    if (configStat.mode & 0o077 || typeof process.getuid === 'function' && configStat.uid !== process.getuid()) throw new Error('中继配置文件必须由当前服务用户拥有且权限为 0600');
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    if (!Number.isInteger(config.port) || config.port < 20000 || config.port > 49151) throw new Error('中继必须使用 20000–49151 的专用端口');
    for (const field of ['keyFile', 'certFile']) if (typeof config[field] !== 'string' || !config[field]) throw new Error('需配置 TLS keyFile 与 certFile');
    const keyPath = resolve(dirname(configPath), config.keyFile), certPath = resolve(dirname(configPath), config.certFile);
    const keyStat = await stat(keyPath);
    if (keyStat.mode & 0o077 || typeof process.getuid === 'function' && keyStat.uid !== process.getuid()) throw new Error('TLS 私钥必须由当前服务用户拥有且权限为 0600');
    const [key, cert] = await Promise.all([readFile(keyPath), readFile(certPath)]);
    relay = await createRelayServer({ host: config.host || '0.0.0.0', port: config.port, publicUrl: config.publicUrl, token: config.token, identity: { key, cert } });
    process.stdout.write(`Link 自建中继已监听 ${relay.origin}，TLS 在中继终止。\n`);
    const stop = () => { void relay.close().finally(() => process.exit()); };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
  } catch (error) { fail(error.message); }
}
