// Opt-in: real official Harness assembly, isolated home/ports, no models or GUI.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,readFile,writeFile,symlink,rm} from 'node:fs/promises';
import {request} from 'node:https';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const root=fileURLToPath(new URL('../../../', import.meta.url));
const dir=await mkdtemp(join(tmpdir(),'link-assembly-'));
const node=process.env.LINK_TEST_NODE ?? join(root,'node_modules/.toolchain/node_modules/node/bin/node');
const dependencies=process.env.LINK_HARNESS_NODE_MODULES ?? join(root,'.local/web/home/profiles/web/node_modules');
const cloudOrigin='https://link-assembly.invalid';
let child,childStopped,spawnFailure,output='';
try {
 const home=join(dir,'home'), profile=join(home,'profiles/web'), workspace=join(dir,'workspace');
 await mkdir(profile,{recursive:true});await mkdir(workspace);await mkdir(join(dir,'commander/link'),{recursive:true});await writeFile(join(dir,'commander/link/devices.json'),JSON.stringify({enabled:true,host:'127.0.0.1',port:0,publicUrl:cloudOrigin,devices:[]}));
 await symlink(dependencies,join(profile,'node_modules'),process.platform === 'win32' ? 'junction' : 'dir');
 await writeFile(join(profile,'package.json'),JSON.stringify({name:'link-assembly-probe',private:true,dependencies:{'dsh-plus':`link:${root}/plugins/commander`},dsh:{profile:{bundles:['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app','dsh-plus']}}}));
 const probe=join(dir,'probe.mjs');
 await writeFile(probe,`export const inject=['connection']; export function apply(ctx) { ctx.effect(()=>ctx.connection.fetch.register({path:'/api/assembly-probe',methods:['POST'],requestBody:'buffered',fetch:()=>Response.json({services:Object.fromEntries(['connection','workspaceRegistry','typertGateway','sessionController','webServer','clientModules','commander'].map(k=>[k,Boolean(ctx.get(k))])),entries:Array.from(ctx.loader.entries()).filter(entry=>['commander','connection','modules','session-controller','typert-gateway'].includes(entry.options.id)).map(entry=>({id:entry.options.id,disabled:entry.disabled,state:entry.fiber?.state}))})}));}`);
 await writeFile(join(profile,'cordis.yml'),'[]\n');
 await writeFile(join(profile,'cordis.patch.yml'),`- id: commander
  config:
    dataDir: ${JSON.stringify(join(dir,'commander'))}
- id: session-log-deepseek
  config:
    enabled: false
- id: session-telemetry-otel
  disabled: true
- insert:
    - id: assembly-probe
      name: ${JSON.stringify(probe)}
`);
 child=spawn(node,['--import',join(root,'deepseek-harness/node_modules/tsx/dist/esm/index.mjs'),join(root,'deepseek-harness/apps/cli/src/bin.ts'),'--profile','web','--host','127.0.0.1','--port','0','--no-open'],{cwd:workspace,env:{PATH:process.env.PATH,HOME:join(dir,'user'),DSH_HOME:home,DSH_AGENTS_HOME:join(dir,'agents'),TSX_TSCONFIG_PATH:join(root,'deepseek-harness/tsconfig.json'),DSH_LINK_CLOUD_ORIGIN:cloudOrigin,DSH_LINK_CLOUD_AUTH_PORT:'0',DSH_TELEMETRY_DISABLED:'1',NO_COLOR:'1'},stdio:['ignore','pipe','pipe']});
 childStopped=new Promise(resolve=>{child.once('close',resolve);child.once('error',error=>{spawnFailure=error;resolve();});});
 for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>output+=chunk);
 let login; for(let i=0;i<300;i++){const m=output.match(/dsh web: (http:[/][/]127[.]0[.]0[.]1:[0-9]+[/][?]token=[A-Za-z0-9_-]+)/);if(m){login=new URL(m[1]);break;}if(spawnFailure||child.exitCode!==null||child.signalCode!==null)break;await new Promise(r=>setTimeout(r,100));}
 if(spawnFailure)throw spawnFailure;
 if(!login)throw Error('not-ready '+output.replace(/([?&]token=)[A-Za-z0-9_-]+/g,'$1[redacted]'));
 const auth=await fetch(login,{redirect:'manual'}),cookie=auth.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ');
 assert.ok(cookie,'owner login must set an authentication cookie');
 await new Promise(r=>setTimeout(r,100));
 const call = async (path, input, authenticated = true) => {
  const response = await fetch(login.origin + path, { method:'POST', headers:{...(authenticated ? {cookie} : {}),'content-type':'application/json'},body:JSON.stringify(input),signal:AbortSignal.timeout(10_000)});
  return {response, body:await response.text()};
 };
 const probeResult=await call('/api/assembly-probe',{});
 assert.equal(probeResult.response.status,200);
 const {services,entries}=JSON.parse(probeResult.body);
 assert.ok(Object.values(services).every(Boolean),JSON.stringify(services));
 assert.equal(entries.length,5,'all expected official service entries must exist');
 assert.ok(entries.every(entry=>!entry.disabled && entry.state===2),JSON.stringify(entries));
 assert.equal((await call('/api/commander-link',{action:'status'},false)).response.status,401);
 const status=await call('/api/commander-link',{action:'status'});
 assert.equal(status.response.status,200,status.body);
 assert.equal(status.response.headers.get('cache-control'),'no-store');
 const link=JSON.parse(status.body);
 assert.equal(link.enabled,true); assert.ok(link.port>0); assert.equal(link.error,null);
 assert.equal(link.cloudAccess.configured,true);
 const {cert}=JSON.parse(await readFile(join(dir,'commander/link/tls.json'),'utf8'));
 const tlsHealth=await new Promise((resolve,reject)=>{
  const req=request({hostname:'127.0.0.1',port:link.port,path:'/link/api/info',method:'GET',ca:cert},res=>{
   let body='';res.setEncoding('utf8');res.on('data',chunk=>body+=chunk);
   res.once('error',reject);res.once('end',()=>resolve({status:res.statusCode,body}));
  });
  req.setTimeout(10_000,()=>req.destroy(new Error('Link TLS health request timed out')));
  req.once('error',reject);req.end();
 });
 assert.equal(tlsHealth.status,200,tlsHealth.body);
 assert.equal(JSON.parse(tlsHealth.body).name,'DSH Link');
 const health=await fetch('http://127.0.0.1:'+link.port+'/link/', {signal:AbortSignal.timeout(10_000)}).catch(()=>null);
 assert.equal(health,null,'the Link listener accepts TLS, never plaintext');
 const invalid=await call('/api/commander-devices',{action:'invalid'});
 assert.equal(invalid.response.status,400,invalid.body);
 assert.match(JSON.parse(invalid.body).error,/不支持/);
 const disabled=await call('/api/commander-link',{action:'configure',enabled:false});
 assert.equal(disabled.response.status,200,disabled.body);
 assert.equal(JSON.parse(disabled.body).enabled,false);
 assert.equal((await call('/api/commander-link',{action:'status'})).response.status,200,'admin remains mounted after listener shutdown');
 console.log('PASS: real Harness Link injection, official exact Fetch registry, owner authentication, configured cloud carrier, enabled TLS startup, device route and listener shutdown.');
}finally{
 if(child&&!spawnFailure&&child.exitCode===null&&child.signalCode===null){
  child.kill('SIGTERM');
  let timer;
  try{await Promise.race([childStopped,new Promise(resolve=>{timer=setTimeout(resolve,5000);})]);}
  finally{clearTimeout(timer);}
  if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');
 }
 if(childStopped)await childStopped;
 await rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100});
}
