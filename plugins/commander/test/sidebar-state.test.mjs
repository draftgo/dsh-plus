import test from 'node:test';
import assert from 'node:assert/strict';
import {isRecentWorkspace,projectWorkspaces,recentRows,startSidebarSession,isSidebarSessionSelected,sidebarWorkspaces,ensureSidebarWorkspace,sidebarSessionStatus} from '../client/sidebar-state.mjs';
const projects=[{id:'auto',isDefault:true,title:'default-workspace',path:'/home/user/Documents/deepseek-harness/default-workspace'},{id:'user',title:'default-workspace',path:'/projects/default-workspace'},{id:'named',title:'自己的项目',path:'/projects/named'}];
test('session list resolves waiting, running and completed from official and native facts',()=>{
 const official={blank:false,running:false};
 assert.equal(sidebarSessionStatus(official), 'completed');
 assert.equal(sidebarSessionStatus({...official,running:true}), 'running');
 assert.equal(sidebarSessionStatus(official,{running:true,pendingInteraction:{kind:'question'}}), 'waiting');
 assert.equal(sidebarSessionStatus(official,undefined,{status:'waiting'}), 'waiting');
 assert.equal(sidebarSessionStatus(official,undefined,{status:'running'}), 'running');
 assert.equal(sidebarSessionStatus(official,undefined,{status:'idle',turnId:'turn'}), 'completed');
 assert.equal(sidebarSessionStatus(undefined,undefined,{status:'idle',turnId:'turn'}), 'completed');
 assert.equal(sidebarSessionStatus(official,{running:true},{status:'idle',turnId:'previous'}), 'running');
 assert.equal(sidebarSessionStatus({...official,running:true},{running:false}), 'completed');
});
test('fresh, unknown, disconnected and failed sessions are never marked completed',()=>{
 for(const official of [undefined,{blank:true,running:false},{blank:false}])assert.equal(sidebarSessionStatus(official),undefined);
 for(const status of ['idle','connecting','disconnected','closed','failed'])assert.equal(sidebarSessionStatus({blank:false,running:false},undefined,{status}),status);
});
test('Recent recovery receives official identity and survives unavailable Documents discovery',async()=>{
 const requests=[],recover=async args=>{requests.push(args);return {workspaceId:'recovered'};};
 for(const initializeDefault of [async()=>({workspaceId:'official'}),async()=>undefined,async()=>{throw Error('Documents unavailable');}]){
  assert.equal((await ensureSidebarWorkspace({workspaces:{initializeDefault}},recover)).workspaceId,'recovered');
 }
 assert.deepEqual(requests,[{workspaceId:'official'},{workspaceId:undefined},{workspaceId:undefined}]);
 await assert.rejects(ensureSidebarWorkspace({workspaces:{initializeDefault:async()=>undefined}},async()=>{throw Error('permission denied');}),/permission denied/);
});
test('Recent is host default identity, never a merely matching user title',()=>{assert.equal(isRecentWorkspace(projects[0]),true);assert.equal(isRecentWorkspace(projects[1]),false);assert.equal(isRecentWorkspace({path:'/user/deepseek-harness/default-workspace'}),false);assert.deepEqual(projectWorkspaces(projects).map(p=>p.id),['user','named']);});
test('Recent rows contain default workspace only',()=>{assert.deepEqual(recentRows([{projectId:'auto',id:'a'},{projectId:'user',id:'b'},{cwd:projects[0].path,id:'c'}],projects).map(p=>p.id),['a','c']);});
test('missing paths never merge unrelated project rows into Recent',()=>{assert.deepEqual(recentRows([{projectId:'auto',id:'a'},{projectId:'user',id:'b'}],[{id:'auto',isDefault:true}]).map(p=>p.id),['a']);});
test('generic new chat explicitly targets Recent, project add targets selected project',async()=>{const calls=[],host={workspaces:{initializeDefault:async()=>{throw Error('unexpected');}},uiWorkspace:{startSession:id=>calls.push(id)}};await startSidebarSession(host,projects);await startSidebarSession(host,projects,'named');assert.deepEqual(calls,['auto','named']);});
test('missing default cannot silently reuse last project',async()=>{const host={workspaces:{initializeDefault:async()=>undefined},uiWorkspace:{startSession:()=>assert.fail('must not start last project')}};await assert.rejects(startSidebarSession(host,projects.slice(1)),/最近工作区/);});
test('official workspaces provide current titles, grouping and default identity before Commander state',()=>{
 const snapshot={phase:'ready',items:[{workspaceId:'auto',title:'official recent',path:'/current',sessionIds:['new']},{workspaceId:'fresh',title:'fresh project',path:'/fresh',sessionIds:['fresh-session']}]};
 const result=sidebarWorkspaces(snapshot,projects,'auto');
 assert.deepEqual(result.map(p=>[p.id,p.title,p.isDefault,p.sessionIds]),[['auto','official recent',true,['new']],['fresh','fresh project',false,['fresh-session']]]);
 assert.deepEqual(projectWorkspaces(result).map(p=>p.id),['fresh']);
 assert.deepEqual(recentRows([{id:'new',projectId:'auto'},{id:'fresh-session',projectId:'fresh'}],result).map(p=>p.id),['new']);
 assert.equal(Object.hasOwn(snapshot.items[0],'id'),false);
});
test('ready empty official list does not resurrect deleted fallback projects',()=>{
 assert.deepEqual(sidebarWorkspaces({phase:'ready',items:[]},projects),[]);
 assert.deepEqual(sidebarWorkspaces({phase:'pending',items:[]},projects).map(p=>p.id),['auto','user','named']);
});
test('pending official items beat fallback and retain matching known default identity',()=>{
 const result=sidebarWorkspaces({phase:'pending',items:[{workspaceId:'auto',title:'recent',sessionIds:[]}]},projects);
 assert.equal(result.length,1);assert.equal(result[0].isDefault,true);
 assert.equal(sidebarWorkspaces({phase:'ready',items:[{workspaceId:'auto'}]},projects,'fresh')[0].isDefault,false);
});
test('new chat reads the latest official snapshot instead of waiting for Commander polling',async()=>{
 const calls=[],host={workspaces:{list:{getSnapshot:()=>({phase:'ready',items:[{workspaceId:'fresh-default',sessionIds:[]},{workspaceId:'fresh-project',sessionIds:[]}]})},initializeDefault:async()=>{throw Error('must use official snapshot');}},uiWorkspace:{startSession:id=>calls.push(id)}};
 await startSidebarSession(host,projects,undefined,'fresh-default');await startSidebarSession(host,projects,'fresh-project','fresh-default');
 assert.deepEqual(calls,['fresh-default','fresh-project']);
});
test('new chat does not reuse a removed fallback default when official list is ready',async()=>{
 const calls=[],host={workspaces:{list:{getSnapshot:()=>({phase:'ready',items:[]})},initializeDefault:async()=>({workspaceId:'initialized'})},uiWorkspace:{startSession:id=>calls.push(id)}};
 await startSidebarSession(host,projects);assert.deepEqual(calls,['initialized']);
});
test('new chat repairs Recent before starting, while explicit project creation bypasses recovery',async()=>{
 const calls=[],host={workspaces:{list:{getSnapshot:()=>({phase:'ready',items:[]})},initializeDefault:async()=>assert.fail('recovery owns initialization')},uiWorkspace:{startSession:id=>calls.push(id)}};
 let repairs=0;
 const ensure=async()=>{repairs++;return {workspaceId:'repaired'};};
 assert.equal(await startSidebarSession(host,projects,undefined,'auto',ensure),'repaired');
 await startSidebarSession(host,projects,'named','repaired',ensure);
 assert.equal(repairs,1);assert.deepEqual(calls,['repaired','named']);
});
test('failed Recent recovery never starts a session in a stale or unrelated workspace',async()=>{
 const host={workspaces:{},uiWorkspace:{startSession:()=>assert.fail('must not start')}};
 await assert.rejects(startSidebarSession(host,projects,undefined,'auto',async()=>{throw Error('directory unavailable');}),/directory unavailable/);
});
test('loading and new chat never select rows without an active session',()=>{
 const rows=[{id:'first'},{id:'second'},{id:'native',native:true},{id:'null-owner',ownerSessionId:null,native:true}];
 for(const active of [undefined,null,''])assert.deepEqual(rows.filter(row=>isSidebarSessionSelected(row,active)),[]);
});
test('restored current session is the only selected Harness row',()=>{
 const rows=[{id:'first'},{id:'second'},{id:'third'}];
 for(const active of ['first','second','third'])assert.deepEqual(rows.filter(row=>isSidebarSessionSelected(row,active)).map(row=>row.id),[active]);
 assert.deepEqual(rows.filter(row=>isSidebarSessionSelected(row,undefined)),[]);
});
test('native owner matches only its primary or adopted session, not every delegate',()=>{
 const rows=[{id:'primary',native:true,ownerSessionId:'harness'},{id:'child',native:true,parentId:'primary',ownerSessionId:'harness'},{id:'adopted',native:true,parentId:'primary',ownerSessionId:'independent',harnessAdopted:true},{id:'other',native:true,ownerSessionId:'unrelated'}];
 assert.deepEqual(rows.filter(row=>isSidebarSessionSelected(row,'harness')).map(row=>row.id),['primary']);
 assert.deepEqual(rows.filter(row=>isSidebarSessionSelected(row,'independent')).map(row=>row.id),['adopted']);
});
