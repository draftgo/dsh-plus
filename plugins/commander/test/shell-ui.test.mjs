import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {transform} from 'esbuild';
import {shellUi} from '../scripts/shell-ui.mjs';
import {createResponsiveLayoutActions} from '../client/responsive-layout.mjs';
const handlers=[];shellUi().setup({onLoad:(meta,callback)=>handlers.push({...meta,callback})});
test('viewport commits only at breakpoints on narrow frames and coalesces desktop resizing',()=>{
  const commits=[], scheduled=new Map();let next=0;
  const actions=createResponsiveLayoutActions({setViewportWidth:width=>commits.push(width)},(fn,delay)=>{const id=++next;scheduled.set(id,{fn,delay});return id},id=>scheduled.delete(id));
  actions.setViewportWidth(800);assert.deepEqual(commits,[800]);
  actions.setViewportWidth(760);actions.setViewportWidth(540);assert.deepEqual(commits,[800]);
  actions.setViewportWidth(1030);assert.deepEqual(commits,[800,1030]);
  actions.setViewportWidth(1100);actions.setViewportWidth(1180);assert.deepEqual(commits,[800,1030]);
  assert.equal(scheduled.size,1);assert.equal([...scheduled.values()][0].delay,90);
  [...scheduled.values()][0].fn();assert.deepEqual(commits,[800,1030,1180]);
  actions.setViewportWidth(760);assert.deepEqual(commits,[800,1030,1180,760]);
  actions.dispose();
});
for(const [pkg,file]of [['ui-settings-general','SettingsRoot.tsx'],['ui-sidebar','SidebarRoot.tsx'],['ui-layout','AppFrame.tsx']])test('build-only '+file+' adapter compiles without modifying upstream',async()=>{const path=fileURLToPath(new URL('../../../deepseek-harness/packages/client/'+pkg+'/src/client/'+file,import.meta.url)),before=await readFile(path,'utf8'),handler=handlers.find(h=>h.filter.test(path)),result=await handler.callback({path});assert.equal(result.loader,'tsx');await transform(result.contents,{loader:'tsx'});assert.equal(await readFile(path,'utf8'),before);if(file==='SettingsRoot.tsx'){assert.match(result.contents,/id === "harness-tools"/);assert.match(result.contents,/id === "voice"/);}if(file==='SidebarRoot.tsx'){assert.match(result.contents,/const wide = !collapsed/);assert.doesNotMatch(result.contents,/css\.railIn,/);}});
test('locale adapter preserves existing bound translators and forwards all other keys',async()=>{
  const {transformSync}=await import('esbuild'),{runInNewContext}=await import('node:vm');const source=await readFile(new URL('../client/shell-ui.jsx',import.meta.url),'utf8');const code=transformSync(source,{loader:'jsx',format:'cjs'}).code,module={exports:{}};runInNewContext(code,{module,exports:module.exports,require:()=>({}),Error});const locale={getLocale:()=>({active:'zh'}),translate:(ns,key)=>ns+':'+key},oldBound=key=>locale.translate('workspace',key);locale.translate=module.exports.recentTranslation(locale,locale.translate);assert.equal(oldBound('workspace.defaultName'),'最近');assert.equal(oldBound('other'),'workspace:other');
});
