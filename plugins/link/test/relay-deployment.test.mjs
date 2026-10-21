import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { validateRelayDeployment, relayDeploymentScript, relayManagementCommand, deployRelay } from '../src/server/relay-deployment.mjs';
const input = { publicIp: '8.8.8.8', email: 'owner@example.com', relayPort: 48730 };
test('relay deployment validates dedicated ports and explicit webroot, rejects unsafe inputs', () => {
  assert.equal(validateRelayDeployment(input).url, 'https://8.8.8.8:48730');
  for (const value of [{relayPort:80},{publicIp:'127.0.0.1'},{email:'x;id'}, {challengeMode:'webroot',webroot:'/tmp/../root'}, {challengeMode:'webroot',webroot:'/tmp/\nroot'}]) assert.throws(()=>validateRelayDeployment({...input,...value}));
  assert.equal(validateRelayDeployment({...input,challengeMode:'webroot',webroot:"/var/www/a'b"}).webroot,"/var/www/a'b");
});
test('generated deployment and management scripts parse without shell interpolation of input', () => {
  const config = validateRelayDeployment({...input,challengeMode:'webroot',webroot:"/var/www/a'b $(id)"});
  const script = relayDeploymentScript({...config,token:'private-token'},'/tmp/stage');
  assert.equal(spawnSync('bash',['-n'],{input:script,encoding:'utf8'}).status,0);
  for (const operation of ['status','logs','start','stop','restart','uninstall']) assert.equal(spawnSync('bash',['-n'],{input:relayManagementCommand(operation)}).status,0);
  assert.throws(()=>relayManagementCommand('rm -rf /'));
  assert.match(script,/User=xiaojiao-relay/);
  assert.match(script,/certbot>=5.4,<6/);
  assert.match(script,/await test\(80\)/);
});
test('deploy verifies public TLS before host configuration and returns no secret', async () => {
  const calls=[];let token;
  const execute=async(_client,command,options)=>{
    calls.push(command);
    if(command.includes('mktemp'))return {code:0,stdout:command.match(/\/tmp\/xiaojiao-relay-[a-f0-9]+/)[0]+'-abc123\n'};
    if(options?.stdin)assert.match(options.stdin,/Managed by Xiaojiao/);
    return {code:0,stdout:''};
  };
  const value=await deployRelay({client:{},input,execute,upload:async()=>{},assets:'/assets',step:()=>{},verify:async()=>calls.push('tls'),onRelay:async config=>{token=config.token;calls.push('host');}});
  assert(calls.indexOf('tls')<calls.indexOf('host'));
  assert.equal(value.relay.tls,'verified');assert.equal(value.relay.host,'pending');assert(!JSON.stringify(value).includes(token));
});
test('failed TLS never enables host routing and always removes staging files', async () => {
 let attached=false;const calls=[];
 const execute=async(_client,command)=>{calls.push(command);return {code:0,stdout:command.includes('mktemp')?command.match(/\/tmp\/xiaojiao-relay-[a-f0-9]+/)[0]+'-abc123\n':''};};
 await assert.rejects(deployRelay({client:{},input,execute,upload:async()=>{},assets:'/assets',step:()=>{},verify:async()=>{throw new Error('TLS failed');},onRelay:async()=>{attached=true;}}),/TLS failed/);
 assert.equal(attached,false);assert.match(calls.at(-1),/^rm -rf -- '\/tmp\/xiaojiao-relay-/);
});
test('all generated Node heredocs and persisted renewal scripts parse without execution', () => {
  const config={...validateRelayDeployment(input),token:'private-token'};
  const script=relayDeploymentScript(config,'/tmp/stage');
  const parts=[...script.matchAll(/<<'JS'\n([\s\S]*?)\nJS/g)].map(x=>x[1]);
  assert.equal(parts.length,3);
  for(const part of parts){ const result=spawnSync('node',['--input-type=module','--check'],{input:part,encoding:'utf8'}); assert.equal(result.status,0,result.stderr); }
  const files=new Map();
  const source=parts[2].replace(/import \{[^}]+\} from 'node:fs';/g,'');
  new Function('readFileSync','writeFileSync','mkdirSync','process',source)(()=>JSON.stringify(config),(name,value)=>files.set(name,value),()=>{}, {argv:['node','script','/opt/xiaojiao-relay','/usr/bin/node']});
  for(const [name,body] of files)if(name.endsWith('.mjs')){ const result=spawnSync('node',['--input-type=module','--check'],{input:body,encoding:'utf8'}); assert.equal(result.status,0,name+': '+result.stderr); }
  assert(!files.get('/opt/xiaojiao-relay/renew.mjs').includes('chown -R'));
});

test('generated systemd unit content contains real newlines', () => {
  const script = relayDeploymentScript({ ...validateRelayDeployment(input), token: 'secret' }, '/tmp/stage');
  const definition = script.split('\n').find(line => line.startsWith('const unit='));
  const service = script.split('\n').find(line => line.startsWith("unit('dsh-link-relay.service'"));
  const writes = [];
  new Function('writeFileSync', 'marker', 'node', 'root', definition + '\n' + service)((...args) => writes.push(args), '# managed', '/usr/bin/node', '/opt/xiaojiao-relay');
  assert.match(writes[0][1], /^# managed\n\[Unit\]\n/);
  assert.match(writes[0][1], /\n\[Service\]\nUser=xiaojiao-relay\n/);
  assert.equal(writes[0][1].includes('\\n'), false);
});
