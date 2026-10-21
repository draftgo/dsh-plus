import { randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { request } from 'node:https';
import { join } from 'node:path';
import { validateConfig as validateCertificateConfig } from '../../scripts/ip-certificate.mjs';

const ROOT = '/opt/xiaojiao-relay';
const MARKER = '# Managed by Xiaojiao relay deployment v1';
const quote = value => "'" + String(value).replaceAll("'", "'\\''") + "'";
export function validateRelayDeployment(input) {
  const publicIp = String(input.publicIp ?? '').trim();
  if (!isIP(publicIp) || /^(?:0\.|10\.|127\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(publicIp) || publicIp === '::1' || /^(?:f[cd]|fe80:)/i.test(publicIp)) throw new Error('请输入服务器实际公网 IP');
  const relayPort = Number(input.relayPort ?? 48730);
  if (!Number.isInteger(relayPort) || relayPort < 20000 || relayPort > 49151) throw new Error('中继端口须为 20000–49151');
  if (!/^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,63}$/.test(input.email ?? '')) throw new Error('请输入有效联系邮箱');
  const challengeMode = input.challengeMode ?? 'standalone';
  if (!['standalone', 'webroot'].includes(challengeMode)) throw new Error('不支持的证书验证方式');
  const webroot = challengeMode === 'standalone' ? ROOT + '/challenge' : input.webroot;
  if (typeof webroot !== 'string' || !webroot.startsWith('/') || /[\x00-\x1f]/.test(webroot) || webroot.split('/').includes('..')) throw new Error('请填写现有反向代理的绝对 webroot 路径');
  validateCertificateConfig({ ip: publicIp, email: input.email, webroot, stateDir: ROOT + '/state', challengePort: 80, relayPort, confirmPublicIp: true });
  return { publicIp, relayPort, email: input.email, challengeMode, webroot, url: 'https://' + (isIP(publicIp) === 6 ? '[' + publicIp + ']' : publicIp) + ':' + relayPort };
}
export function verifyRelayTls(url) {
  return new Promise((resolve, reject) => {
    const req = request(new URL('/', url), { timeout: 15000 }, res => { let body = ''; res.on('data', value => { body += value; if (body.length > 4096) req.destroy(new Error('中继健康响应异常')); }); res.on('end', () => res.statusCode === 404 && body === 'Link 路径未授权' ? resolve() : reject(new Error('公网 TLS 可连接，但服务身份响应不符'))); res.on('error', reject); });
    req.on('error', reject); req.on('timeout', () => req.destroy(new Error('公网 TLS 检查超时，请检查中继端口和安全组'))); req.end();
  });
}
export function relayDeploymentScript(config, stage) {
  const payload = Buffer.from(JSON.stringify(config)).toString('base64');
  return `set -eu
[ "$(id -u)" = 0 ] || { echo '需要 root 或免密 sudo'; exit 1; }
command -v systemctl >/dev/null
systemctl show-environment >/dev/null
command -v python3 >/dev/null
NODE=$(command -v node)
case "$NODE" in /root/*|/home/*) echo "请先将 Node 22+ 安装到系统路径，再部署独立中继服务"; exit 1;; esac
node -e 'if(Number(process.versions.node.split(".")[0])<22)process.exit(1)'
ROOT=${quote(ROOT)}
MARKER=${quote(MARKER)}
if [ -e "$ROOT" ]; then [ ! -L "$ROOT" ] && [ "$(cat "$ROOT/.managed" 2>/dev/null)" = "$MARKER" ] || { echo '目标目录非本工具所有，拒绝接管'; exit 1; }; fi
for unit in dsh-link-relay.service dsh-link-relay-challenge.service dsh-link-ip-certificate-renew.service dsh-link-ip-certificate-renew.timer; do
 if [ -e "/etc/systemd/system/$unit" ] || [ -L "/etc/systemd/system/$unit" ]; then [ ! -L "/etc/systemd/system/$unit" ] && [ "$(head -n 1 "/etc/systemd/system/$unit")" = "$MARKER" ] || { echo '已有同名单元，拒绝覆盖'; exit 1; }; fi
done
mkdir -p "$ROOT"
printf '%s\\n' "$MARKER" > "$ROOT/.managed"
chmod 711 "$ROOT"
id xiaojiao-relay >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin xiaojiao-relay
cp ${quote(stage + '/run-relay-server.mjs')} "$ROOT/run-relay-server.mjs"
cp ${quote(stage + '/ip-certificate.mjs')} "$ROOT/ip-certificate.mjs"
chmod 644 "$ROOT/run-relay-server.mjs" "$ROOT/ip-certificate.mjs"
node --input-type=module - "$ROOT" ${quote(payload)} <<'JS'
import {writeFileSync} from 'node:fs';
const [root,data]=process.argv.slice(2);const c=JSON.parse(Buffer.from(data,'base64'));
writeFileSync(root+'/deploy.json',JSON.stringify(c),{mode:0o600});
writeFileSync(root+'/package.json',JSON.stringify({private:true,dependencies:{ws:'8.19.0'}}),{mode:0o600});
JS
cd "$ROOT"
npm install --omit=dev --ignore-scripts --no-audit --no-fund
python3 -m venv "$ROOT/certbot"
"$ROOT/certbot/bin/pip" install 'certbot>=5.4,<6'
node --input-type=module - "$ROOT" "$NODE" <<'JS'
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {createServer} from 'node:net';
import {spawnSync} from 'node:child_process';
const [root,node]=process.argv.slice(2),c=JSON.parse(readFileSync(root+'/deploy.json'));
const marker=${JSON.stringify(MARKER)};
const unit=(name,value)=>writeFileSync('/etc/systemd/system/'+name,marker+'\\n'+value,{mode:0o644});
const test=port=>new Promise((ok,bad)=>{const s=createServer();s.once('error',()=>bad(new Error('端口 '+port+' 已占用；不会停止现有服务')));s.listen(port,'::',()=>s.close(ok));});
const prior=spawnSync('systemctl',['is-active','--quiet','dsh-link-relay.service']).status===0;
if(!prior)await test(c.relayPort);
if(c.challengeMode==='standalone'){
 const challengeActive=spawnSync('systemctl',['is-active','--quiet','dsh-link-relay-challenge.service']).status===0;
 if(!challengeActive)await test(80);mkdirSync(c.webroot,{recursive:true});
 const script="import http.server,os,socket;os.chdir("+JSON.stringify(c.webroot)+");S=type('S',(http.server.ThreadingHTTPServer,),{'address_family':socket.AF_INET6});S.address_family=socket.AF_INET6;S(('::',80),http.server.SimpleHTTPRequestHandler).serve_forever()";
 writeFileSync(root+'/challenge.py',script,{mode:0o600});
 unit('dsh-link-relay-challenge.service','[Service]\\nExecStart=/usr/bin/python3 '+root+'/challenge.py\\nProtectSystem=strict\\nProtectHome=true\\nNoNewPrivileges=true\\nCapabilityBoundingSet=CAP_NET_BIND_SERVICE\\n[Install]\\nWantedBy=multi-user.target\\n');
}
JS
systemctl daemon-reload
${config.challengeMode === 'standalone' ? 'systemctl enable --now dsh-link-relay-challenge.service' : 'test -d ' + quote(config.webroot)}
node "$ROOT/ip-certificate.mjs" issue --state-dir "$ROOT/state" --ip ${quote(config.publicIp)} --email ${quote(config.email)} --webroot ${quote(config.webroot)} --challenge-port 80 --relay-port ${config.relayPort} --confirm-public-ip true --certbot "$ROOT/certbot/bin/certbot"
node --input-type=module - "$ROOT" "$NODE" <<'JS'
import {readFileSync,writeFileSync} from 'node:fs';
const [root,node]=process.argv.slice(2),c=JSON.parse(readFileSync(root+'/deploy.json'));
const marker=${JSON.stringify(MARKER)};
const unit=(name,value)=>writeFileSync('/etc/systemd/system/'+name,marker+'\\n'+value,{mode:0o644});
const certDir=root+'/service-certs';
writeFileSync(root+'/relay.json',JSON.stringify({host:c.publicIp.includes(':')?'::':'0.0.0.0',port:c.relayPort,publicUrl:c.url,token:c.token,keyFile:certDir+'/privkey.pem',certFile:certDir+'/fullchain.pem'}),{mode:0o600});
const publish="import {copyFileSync,chmodSync,chownSync,renameSync} from 'node:fs';import {spawnSync} from 'node:child_process';const [root]=process.argv.slice(2),src=root+'/state/dsh-link-ip-certificate/active/',dst=root+'/service-certs/';for(const n of ['fullchain.pem','privkey.pem']){const t=dst+'.'+n+'.tmp';copyFileSync(src+n,t);chmodSync(t,n==='privkey.pem'?0o600:0o644);const r=spawnSync('chown',['xiaojiao-relay:xiaojiao-relay',t]);if(r.status!==0)throw new Error('证书权限设置失败');renameSync(t,dst+n)}";
import {mkdirSync} from 'node:fs';mkdirSync(certDir,{recursive:true,mode:0o755});writeFileSync(root+'/publish-cert.mjs',publish,{mode:0o600});
unit('dsh-link-relay.service','[Unit]\\nAfter=network-online.target\\n[Service]\\nUser=xiaojiao-relay\\nExecStart='+node+' '+root+'/run-relay-server.mjs --config '+root+'/relay.json\\nRestart=on-failure\\nRestartSec=5\\nUMask=0077\\nNoNewPrivileges=true\\nCapabilityBoundingSet=\\nProtectSystem=strict\\nProtectHome=true\\nPrivateTmp=true\\n[Install]\\nWantedBy=multi-user.target\\n');
const args=['renew','--state-dir',root+'/state','--ip',c.publicIp,'--email',c.email,'--webroot',c.webroot,'--challenge-port','80','--relay-port',String(c.relayPort),'--confirm-public-ip','true','--certbot',root+'/certbot/bin/certbot'];
// Shell quoting then systemd escaping is unnecessary: persist a fixed script with JSON argv.
writeFileSync(root+'/renew.mjs',"import {spawnSync} from 'node:child_process';import {existsSync,writeFileSync,unlinkSync} from 'node:fs';const pending="+JSON.stringify(root+'/renew-pending')+";const r=spawnSync(process.execPath,"+JSON.stringify([root+'/ip-certificate.mjs',...args])+",{encoding:'utf8'});if(r.status!==0){process.stderr.write(r.stderr||'证书续期失败');process.exit(1)};process.stdout.write(r.stdout);const changed=JSON.parse(r.stdout.trim()).changed;if(changed||existsSync(pending)){writeFileSync(pending,'1',{mode:0o600});const p=spawnSync(process.execPath,["+JSON.stringify(root+'/publish-cert.mjs')+","+JSON.stringify(root)+"],{stdio:'inherit'});if(p.status!==0)process.exit(1);const s=spawnSync('systemctl',['try-restart','dsh-link-relay.service'],{stdio:'inherit'});if(s.status!==0)process.exit(s.status??1);unlinkSync(pending)}",{mode:0o600});
unit('dsh-link-ip-certificate-renew.service','[Service]\\nType=oneshot\\nUMask=0077\\nExecStart='+node+' '+root+'/renew.mjs\\n');
unit('dsh-link-ip-certificate-renew.timer','[Timer]\\nOnCalendar=daily\\nRandomizedDelaySec=1h\\nPersistent=true\\n[Install]\\nWantedBy=timers.target\\n');
JS
mkdir -p "$ROOT/service-certs"
node "$ROOT/publish-cert.mjs" "$ROOT"
chown xiaojiao-relay:xiaojiao-relay "$ROOT/relay.json"
systemctl daemon-reload
systemctl enable --now dsh-link-ip-certificate-renew.timer
systemctl enable dsh-link-relay.service
systemctl restart dsh-link-relay.service
systemctl is-active --quiet dsh-link-relay.service
`;
}
export async function deployRelay({ client, input, execute, upload, assets, step, onRelay, verify = verifyRelayTls }) {
  const config = validateRelayDeployment(input); let token = randomBytes(32).toString('base64url');
  // Preserve an existing registered relay identity on retry; read only our marked directory.
  const saved = await execute(client, 'if [ "$(id -u)" = 0 ]; then bash -s; else sudo -n bash -s; fi', { stdin: 'if [ ! -L ' + quote(ROOT) + ' ] && [ "$(cat ' + quote(ROOT + '/.managed') + ' 2>/dev/null)" = ' + quote(MARKER) + ' ] && [ -f ' + quote(ROOT + '/relay.json') + ' ]; then cat ' + quote(ROOT + '/relay.json') + '; fi' });
  if (saved.code !== 0) throw new Error('需要 root 或免密 sudo 才能部署中继');
  if (saved.stdout.trim()) { let previous; try { previous = JSON.parse(saved.stdout); } catch { throw new Error('现有中继配置损坏，请先检查服务器'); } if (previous.publicUrl !== config.url) throw new Error('现有中继地址不同，请先卸载原中继'); if (!/^[A-Za-z0-9_-]{32,256}$/.test(previous.token ?? '')) throw new Error('现有中继身份无效'); token = previous.token; }
  const nonce = randomBytes(16).toString('hex');
  const result = await execute(client, 'umask 077; mktemp -d /tmp/xiaojiao-relay-' + nonce + '-XXXXXX');
  const stage = result.stdout.trim();
  if (result.code !== 0 || !new RegExp('^/tmp/xiaojiao-relay-' + nonce + '-[A-Za-z0-9]+$').test(stage)) throw new Error('无法建立中继临时目录');
  try {
    step('上传中继与证书工具');
    for (const name of ['run-relay-server.mjs','ip-certificate.mjs']) await upload(client, join(assets, name), stage + '/' + name);
    step('检查端口、申请公网证书并安装服务');
    const deployed = await execute(client, 'if [ "$(id -u)" = 0 ]; then bash -s; else sudo -n bash -s; fi', { stdin: relayDeploymentScript({...config,token}, stage), timeout: 25 * 60 * 1000 });
    if (deployed.code !== 0) throw new Error((deployed.stderr || deployed.stdout || '中继部署失败').split(token).join('[redacted]').slice(-3000));
    step('验证公网可信 TLS'); await verify(config.url);
    step('接入本机 Link'); try { await onRelay({ ...config, token }); } catch { throw new Error('中继服务及可信 TLS 已部署，但本机接入失败；请修正本机配置后重试部署'); }
    return { relay: { url: config.url, publicIp: config.publicIp, port: config.relayPort, tls: 'verified', host: 'pending' } };
  } finally { await execute(client, 'rm -rf -- ' + quote(stage), { timeout: 10000 }).catch(() => {}); }
}
export function relayManagementCommand(operation) {
  const prefix = 'set -eu; ROOT=' + quote(ROOT) + '; [ ! -L "$ROOT" ] && [ "$(cat "$ROOT/.managed")" = ' + quote(MARKER) + ' ]; ';
  const commands = { status: 'systemctl is-active dsh-link-relay.service', logs: 'journalctl -u dsh-link-relay.service -n 80 --no-pager -o cat', start: 'systemctl start dsh-link-relay.service', stop: 'systemctl stop dsh-link-relay.service', restart: 'systemctl restart dsh-link-relay.service' };
  if (Object.hasOwn(commands, operation)) return prefix + commands[operation];
  if (operation !== 'uninstall') throw new Error('不支持的中继操作');
  return prefix + `for unit in dsh-link-relay.service dsh-link-relay-challenge.service dsh-link-ip-certificate-renew.service dsh-link-ip-certificate-renew.timer; do if [ -e "/etc/systemd/system/$unit" ] || [ -L "/etc/systemd/system/$unit" ]; then [ ! -L "/etc/systemd/system/$unit" ] && [ "$(head -n 1 "/etc/systemd/system/$unit")" = ${quote(MARKER)} ]; fi; done; for unit in dsh-link-relay.service dsh-link-relay-challenge.service dsh-link-ip-certificate-renew.timer; do systemctl disable --now "$unit" 2>/dev/null || true; done; rm -f /etc/systemd/system/dsh-link-relay.service /etc/systemd/system/dsh-link-relay-challenge.service /etc/systemd/system/dsh-link-ip-certificate-renew.service /etc/systemd/system/dsh-link-ip-certificate-renew.timer; systemctl daemon-reload; rm -rf -- "$ROOT"`;
}
