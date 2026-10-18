import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {runInNewContext} from 'node:vm';
import * as helpers from '../client/model-picker-state.mjs';
import { nativeActivityLabel } from '../client/native-activity.mjs';
import { SlotCore } from '../../../deepseek-harness/packages/client/ui-slots/lib/index.js';
const require=createRequire(import.meta.url),{transformSync}=require('esbuild');
const code=transformSync(readFileSync(new URL('../client/model-picker.jsx',import.meta.url),'utf8'),{loader:'jsx',format:'cjs'}).code;
const route={tool:'codex',providerId:'routergo',providerName:'RouterGo',modelId:'opaque:route/with:separators',nativeModelId:'native-model'};
const model={id:route.modelId,name:'Model X',reasoning:{defaultEffort:'high',efforts:[{id:'high',name:'High'}]}};
const catalog={tools:[{id:'codex',name:'Codex',installed:true,chatSupported:true,routeSupported:true},{id:'hermes',name:'Hermes',installed:true,chatSupported:true,routeSupported:false,routeReason:'供应商隔离待适配'}],routes:[route]};
const state={status:'ready',groups:[{id:'commander-codex',name:'Codex',models:[model]}],failures:[],current:null};
test('model picker activates against the official single and list slot contracts', () => {
 const core=new SlotCore(), cleanups=[];
 core.register({name:'root',children:{'conversation.input.model':{kind:'single',scope:'session'},'conversation.input.dock':{kind:'list',scope:'session'}}},()=>null);
 const module={exports:{}};
 runInNewContext(code,{module,exports:module.exports,document:{createElement:()=>({remove(){}}),head:{append(){}}},require:()=>({})});
 try {
  module.exports.mountModelPicker({effect:fn=>cleanups.push(fn()),slots:{inject:(_name,callback)=>cleanups.push(callback()),register:(options,component)=>core.register(options,component)}});
  assert.equal(core.entries('conversation.input.model').length,1);
  const entries=core.entries('conversation.input.dock');
  assert.equal(entries.length,1);
  assert.equal(entries[0].options.id,'commander-native-activity');
 } finally {for(const cleanup of cleanups.reverse())cleanup();}
});
function render({provider=null,toolsOpen=false,directory=catalog,groups=state.groups,catalogLoading=false,catalogError='',sessionBinding=null,bindingError=''}={}){
 const values=[true,'codex',provider,'',directory,catalogLoading,0,toolsOpen,{position:'fixed'},'',catalogError,sessionBinding,bindingError],actions=[],selections=[],opened=[];let cursor=0,Component,definition;
 const react={createElement:(type,props,...children)=>({type,props:props||{},children:children.flat(Infinity).filter(x=>x!==false&&x!=null)}),useState:()=>{const id=cursor++;return[values[id],value=>actions.push({id,value})]},useEffect(){},useId:()=> 'picker',useRef:initial=>({current:initial})};
 const module={exports:{}};
 runInNewContext(code,{module,exports:module.exports,URL,document:{createElement:()=>({remove(){}}),head:{append(){}}},require:id=>id==='react'?react:id==='react-dom'?{createPortal:node=>node}:id.includes('model-picker-state')?helpers:id.includes('iconsax')?{UIIcon:'Icon'}:id.includes('tool-brand')?{ToolBrandIcon:'Brand'}:{default:''}});
 const shell={children:{'settings.section':{}},store:{create:()=>({actions:{openSection:id=>opened.push(id)}})}};
 module.exports.mountModelPicker({effect(){},sessions:{subagentAddress:()=>undefined},modelDirectories:{directoryFor:()=>({store:{},load:async()=>{},select:async()=>{}})},slots:{entries:()=>[shell],inject:(slot,cb)=>{if(slot==='conversation.input.model')cb();},register:(entry,component)=>{Component=component;definition=entry}}});
 const tree=Component({available:true,locked:false,useDirectory:()=>({...state,groups}),load:async()=>{},openToolSettings:()=>opened.push('harness-tools'),select:selection=>{selections.push(selection);return Promise.resolve({ok:true})}});
 const nodes=x=>x&&typeof x==='object'?[x,...x.children.flatMap(nodes)]:[];
 return {nodes:nodes(tree),actions,selections,opened,inject:definition.inject};
}
test('provider-first UI drills down without selecting or changing the running session',()=>{
 const view=render(),provider=view.nodes.find(node=>node.type==='button'&&node.props.className?.includes('cmd-model-provider'));
 assert(provider);provider.props.onClick();assert.deepEqual(view.actions,[{id:2,value:'routergo'},{id:3,value:''}]);assert.equal(view.selections.length,0);
 assert(view.nodes.some(node=>node.props['aria-label']==='选择 Agent 工具'));
});
test('bound routed conversation keeps its tool and supplier fixed while allowing model selection',()=>{
 const view=render({sessionBinding:{bound:true,provider:'codex',model:'one',route:{providerId:'routergo',model:'one'}}});
 const trigger=view.nodes.find(node=>node.props.className==='cmd-model-trigger');
 const tool=view.nodes.find(node=>node.props.className==='cmd-model-tool-trigger');
 assert.equal(trigger.props.disabled,false); assert.match(trigger.props['aria-label'],/切换模型/);
 assert.doesNotMatch(view.nodes.find(node=>node.props.className==='cmd-model-caption').children.join(''),/已绑定/);
 assert.equal(tool.props.disabled,true);
});
test('model click passes original opaque ID and reasoning to official selection',()=>{
 const view=render({provider:'routergo'}),button=view.nodes.find(node=>node.type==='button'&&node.props.role==='menuitemradio');
 button.props.onClick();assert.equal(view.selections[0].provider,'commander-codex');assert.equal(view.selections[0].model,route.modelId);assert.equal(view.selections[0].reasoningEffort,'high');
});
test('installed unsupported tools remain visible and cannot be activated',()=>{
 const view=render({toolsOpen:true}),hermes=view.nodes.find(node=>node.type==='button'&&node.children.some(child=>child.type==='Brand'&&child.props.tool==='hermes'));
 assert(hermes);assert.equal(hermes.props.disabled,true);assert(view.nodes.some(node=>node.type==='small'&&node.children.includes('供应商隔离待适配')));
});
test('subscription provider can select its native tool model while other tools stay disabled', () => {
 const identity={id:'openai-codex',name:'ChatGPT',authMode:'subscription',harnessTools:['codex'],tools:['codex'],nativeRequired:true,configured:true};
 const routed={...route,providerId:identity.id,providerName:identity.name,authMode:'subscription'};
 const directory={...catalog,providers:[identity],routes:[routed]};
 const view=render({provider:identity.id,toolsOpen:true,directory});
 const other=view.nodes.find(node=>node.type==='button'&&node.props.role==='menuitemradio'&&node.children.some(child=>child.type==='Brand'&&child.props.tool==='deepseek'));
 assert.equal(other.props.disabled,true); other.props.onClick(); assert.equal(view.actions.length,0);
 const choose=view.nodes.find(node=>node.type==='button'&&node.props.role==='menuitemradio'&&node.children.some(child=>child.type==='span'&&child.children.includes('Model X')));
 assert.equal(choose.props.disabled,false); choose.props.onClick(); assert.equal(view.selections[0].provider,'commander-codex');
 const configure=view.nodes.find(node=>node.type==='button'&&node.children.includes('打开 Harness 工具'));
 configure.props.onClick(); assert.deepEqual(view.opened,['harness-tools']);
});
test('missing subscription authentication shows guidance and never presents a selectable model', () => {
 const identity={id:'openai-codex',name:'ChatGPT',authMode:'subscription',harnessTools:['codex'],tools:['codex'],nativeRequired:true,configured:false};
 const view=render({provider:identity.id,directory:{...catalog,providers:[identity],routes:[]},groups:[]});
 assert.equal(view.nodes.some(node=>node.props.role==='menuitemradio'),false);
 assert(view.nodes.some(node=>node.type==='button'&&node.children.includes('打开 Harness 工具')));
});
test('subscription guidance opens the shell-owned Harness section through its actual store contract', () => {
 const view=render(); view.inject('session').openToolSettings();
 assert.deepEqual(view.opened,['harness-tools']);
});
test('model selection waits for fresh permission metadata and stays disabled on permission lookup errors', () => {
 for(const options of [{catalogLoading:true},{catalogError:'offline'},{directory:null}]) {
  const view=render({provider:'routergo',...options});
  const button=view.nodes.find(node=>node.type==='button'&&node.props.role==='menuitemradio');
  if(button){assert.equal(button.props.disabled,true);button.props.onClick();}
  assert.equal(view.selections.length,0);
 }
});
test('native activity projects Codex command start, completion and output without creating executable LLM calls', () => {
 const label = nativeActivityLabel;
 assert.deepEqual(label({type:'item',data:{phase:'item/started',item:{type:'commandExecution',command:'npm test'}}}),{label:'正在调用命令',detail:'npm test',state:'running'});
 assert.deepEqual(label({type:'item',data:{phase:'item/completed',item:{type:'commandExecution',command:'npm test'}}}),{label:'命令已完成',detail:'npm test',state:'done'});
 assert.deepEqual(label({type:'tool.output',data:{text:'tests passed\n'}}),{label:'命令输出',detail:'tests passed',state:'running'});
 assert.equal(label({type:'text.delta',data:{text:'ignored'}}),null);
});
