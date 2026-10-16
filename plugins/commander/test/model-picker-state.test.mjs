import test from 'node:test';
import assert from 'node:assert/strict';
import {availableTools, currentToolId, providersForTool, selectionReasoningEffort} from '../client/model-picker-state.mjs';
const route={tool:'codex',providerId:'routergo',providerName:'RouterGo',modelId:'opaque:/not/a/provider+model',nativeModelId:'native/model'};
const groups=[{id:'routergo',name:'RouterGo',models:[{id:'deepseek-test',name:'DS'}]},{id:'commander-codex',name:'Codex',models:[{id:route.modelId,name:'Codex test'},{id:'unmapped',name:'Do not guess'}]},{id:'commander-claude',models:[{id:route.modelId,name:'Other tool'}]}];
test('reasoning choices follow exact capabilities instead of stale session state',()=>{
 const current={provider:'routergo',model:'m',reasoningEffort:'off'};
 assert.equal(selectionReasoningEffort('routergo',{id:'m'},current),undefined);
 const model={id:'m',reasoning:{defaultEffort:'high',efforts:[{id:'high'},{id:'off'}]}};
 assert.equal(selectionReasoningEffort('routergo',model,current),'off');
 assert.equal(selectionReasoningEffort('routergo',model,{...current,reasoningEffort:'removed'}),'high');
 assert.equal(selectionReasoningEffort('other',model,current),'high');
 assert.equal(selectionReasoningEffort('routergo',model,current,'high'),'high');
 assert.throws(()=>selectionReasoningEffort('routergo',model,current,'invalid'),/不支持/);
 assert.throws(()=>selectionReasoningEffort('routergo',{id:'m'},current,'off'),/不支持/);
 assert.equal(selectionReasoningEffort('routergo',{id:'m',reasoning:{defaultEffort:'removed',efforts:[{id:'high'}]}},current),undefined);
});
test('tool list is installed catalog only and preserves visible unsupported tools',()=>{
 const tools=availableTools({tools:[{id:'deepseek',name:'duplicate'},{id:'codex',name:'Codex',installed:true,chatSupported:true,routeSupported:true},{id:'hermes',installed:true,chatSupported:true,routeSupported:false},{id:'pi',installed:false,chatSupported:true,routeSupported:true},{id:'helper',installed:true,chatSupported:false,routeSupported:true}]});
 assert.deepEqual(tools.map(x=>x.id),['deepseek','codex','hermes']); assert.equal(tools[2].routeSupported,false);
});
test('third party providers remain providers beneath DeepSeek rather than tools',()=>{
 assert.equal(currentToolId('routergo'),'deepseek'); assert.equal(currentToolId('commander-codex'),'codex');
 const providers=providersForTool(groups,{routes:[route]},'deepseek'); assert.deepEqual(providers.map(x=>x.id),['routergo']); assert.equal(providers[0].models[0].group.id,'routergo');
});
test('native tools use route metadata and preserve opaque model IDs unchanged',()=>{
 const providers=providersForTool(groups,{routes:[route,{...route,tool:'claude',providerId:'wrong'}]},'codex');
 assert.deepEqual(providers.map(x=>x.id),['routergo']); assert.equal(providers[0].models.length,1); assert.equal(providers[0].models[0].model.id,route.modelId); assert.equal(providers[0].models[0].nativeModelId,'native/model');
 assert.deepEqual(providersForTool(groups,{},'codex'),[]);
});
