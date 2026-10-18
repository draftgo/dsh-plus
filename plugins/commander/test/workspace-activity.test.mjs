import test from 'node:test';
import assert from 'node:assert/strict';
import { workspaceActivity } from '../client/sidebar-state.mjs';

const project={id:'project',path:'/projects/app',sessionIds:['official','owner']};

test('workspace activity links project ids, directories and official session membership',()=>{
  for(const session of [
    {id:'native',projectId:'project'},
    {id:'native',cwd:'/projects/app'},
    {id:'official'},
    {id:'delegate',native:true,parentId:'primary',ownerSessionId:'owner'},
  ])assert.equal(workspaceActivity(project,[{...session,status:'running'}]),'running');
  assert.equal(workspaceActivity({workspaceId:'project'},[{projectId:'project',status:'connecting'}]),'connecting');
});

test('waiting wins across sessions and providers, then running, then connecting',()=>{
  const sessions=[
    {id:'official',provider:'deepseek',status:'connecting'},
    {id:'native',projectId:'project',provider:'codex',status:'running'},
    {id:'delegate',ownerSessionId:'owner',provider:'claude',status:'waiting'},
  ];
  assert.equal(workspaceActivity(project,sessions),'waiting');
  assert.equal(workspaceActivity(project,[...sessions].reverse()),'waiting');
  assert.equal(workspaceActivity(project,sessions.slice(0,2)),'running');
  assert.equal(workspaceActivity(project,sessions.slice(0,1)),'connecting');
});

test('inactive and archived sessions never keep a workspace lit',()=>{
  for(const status of ['idle','completed','failed','stopped',undefined]){
    assert.equal(workspaceActivity(project,[{id:'official',status}]),null);
  }
  assert.equal(workspaceActivity(project,[{id:'official',status:'waiting',archived:true}]),null);
  assert.equal(workspaceActivity(project,[]),null);
});

test('unrelated sessions and missing identity cannot activate another workspace',()=>{
  const sessions=[
    {id:'other',projectId:'another-project',cwd:'/projects/other',status:'waiting'},
    {id:'other-delegate',ownerSessionId:'another-owner',status:'running'},
    {status:'connecting'},
  ];
  assert.equal(workspaceActivity(project,sessions),null);
  assert.equal(workspaceActivity({},sessions),null);
  assert.equal(workspaceActivity(undefined,sessions),null);
  assert.equal(workspaceActivity(null,sessions),null);
  assert.equal(workspaceActivity({id:'',path:'',sessionIds:[]},sessions),null);
});
