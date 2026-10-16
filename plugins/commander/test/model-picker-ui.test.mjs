import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {runInNewContext} from 'node:vm';
import * as helpers from '../client/model-picker-state.mjs';
const require=createRequire(import.meta.url),{transformSync}=require('esbuild');
const code=transformSync(readFileSync(new URL('../client/model-picker.jsx',import.meta.url),'utf8'),{loader:'jsx',format:'cjs'}).code;
const route={tool:'codex',providerId:'routergo',providerName:'RouterGo',modelId:'opaque:route/with:separators',nativeModelId:'native-model'};
const model={id:route.modelId,name:'Model X',reasoning:{defaultEffort:'high',efforts:[{id:'high',name:'High'}]}};
const catalog={tools:[{id:'codex',name:'Codex',installed:true,chatSupported:true,routeSupported:true},{id:'hermes',name:'Hermes',installed:true,chatSupported:true,routeSupported:false,routeReason:'供应商隔离待适配'}],routes:[route]};
const state={status:'ready',groups:[{id:'commander-codex',name:'Codex',models:[model]}],failures:[],current:null};
function render({provider=null,toolsOpen=false}={}){
 const values=[true,'codex',provider,'',catalog,false,0,toolsOpen,{position:'fixed'},'',''],actions=[],selections=[];let cursor=0,Component;
 const react={createElement:(type,props,...children)=>({type,props:props||{},children:children.flat(Infinity).filter(x=>x!==false&&x!=null)}),useState:()=>{const id=cursor++;return[values[id],value=>actions.push({id,value})]},useEffect(){},useId:()=> 'picker',useRef:initial=>({current:initial})};
 const module={exports:{}};
 runInNewContext(code,{module,exports:module.exports,URL,document:{createElement:()=>({remove(){}}),head:{append(){}}},require:id=>id==='react'?react:id==='react-dom'?{createPortal:node=>node}:id.includes('model-picker-state')?helpers:id.includes('iconsax')?{UIIcon:'Icon'}:id.includes('tool-brand')?{ToolBrandIcon:'Brand'}:{default:''}});
 module.exports.mountModelPicker({effect(){},slots:{inject:(_,cb)=>cb(),register:(_definition,component)=>{Component=component}}});
 const tree=Component({available:true,locked:false,useDirectory:()=>state,load:async()=>{},select:selection=>{selections.push(selection);return Promise.resolve({ok:true})}});
 const nodes=x=>x&&typeof x==='object'?[x,...x.children.flatMap(nodes)]:[];
 return {nodes:nodes(tree),actions,selections};
}
test('provider-first UI drills down without selecting or changing the running session',()=>{
 const view=render(),provider=view.nodes.find(node=>node.type==='button'&&node.props.className?.includes('cmd-model-provider'));
 assert(provider);provider.props.onClick();assert.deepEqual(view.actions,[{id:2,value:'routergo'},{id:3,value:''}]);assert.equal(view.selections.length,0);
 assert(view.nodes.some(node=>node.props['aria-label']==='选择 Agent 工具'));
});
test('model click passes original opaque ID and reasoning to official selection',()=>{
 const view=render({provider:'routergo'}),button=view.nodes.find(node=>node.type==='button'&&node.props.role==='menuitemradio');
 button.props.onClick();assert.equal(view.selections[0].provider,'commander-codex');assert.equal(view.selections[0].model,route.modelId);assert.equal(view.selections[0].reasoningEffort,'high');
});
test('installed unsupported tools remain visible and cannot be activated',()=>{
 const view=render({toolsOpen:true}),hermes=view.nodes.find(node=>node.type==='button'&&node.children.some(child=>child.type==='Brand'&&child.props.tool==='hermes'));
 assert(hermes);assert.equal(hermes.props.disabled,true);assert(view.nodes.some(node=>node.type==='small'&&node.children.includes('供应商隔离待适配')));
});
