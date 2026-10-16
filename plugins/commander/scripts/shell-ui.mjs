import {readFile} from 'node:fs/promises';
import {dirname} from 'node:path';
import {build as esbuild} from 'esbuild';
const once=(source,before,after)=>{if(source.split(before).length!==2)throw Error('Official shell changed: '+before.slice(0,80));return source.replace(before,after);};
export function shellUi(){return {name:'commander-shell-ui',setup(build){
  build.onLoad({filter:/ui-settings-general\/src\/client\/SettingsRoot\.tsx$/},async({path})=>{
    let source=await readFile(path,'utf8');
    source=once(source,'function navIcon(id: string) {',
      'function navIcon(id: string) {\n'+
      '  if (id === "harness-tools") return <svg className={css.navIcon} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M14 6a5 5 0 0 0-6 6L3 17a2.8 2.8 0 0 0 4 4l5-5a5 5 0 0 0 6-6l-3 3-4-4 3-3Z" /></svg>\n'+
      '  if (id === "voice") return <svg className={css.navIcon} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true"><path d="M3 10v4m4-7v10m5-14v18m5-14v10m4-7v4" /></svg>');
    return {contents:source,loader:'tsx',resolveDir:dirname(path)};
  });
  build.onLoad({filter:/ui-sidebar\/src\/client\/SidebarRoot\.tsx$/},async({path})=>{
    let source=await readFile(path,'utf8');
    source=once(source,'const wide = windowsTitlebar ? !collapsed : !collapsed || !settled','const wide = !collapsed');
    source=once(source,'style={wide ? { width: collapsed ? lastWideWidth.current : width } : undefined}', "style={{ width: '100%', minWidth: 0 }}");
    source=once(source,'css.root, !wide && css.collapsed, !wide && everWide.current && css.railIn,', "css.root, 'cmd-shell-sidebar', !wide && css.collapsed,");
    return {contents:source,loader:'tsx',resolveDir:dirname(path)};
  });
  build.onLoad({filter:/ui-layout\/src\/client\/AppFrame\.tsx$/},async({path})=>{
    let source=await readFile(path,'utf8');source=once(source,'className={css.frame}', "className={css.frame + ' cmd-shell-frame'}");
    source=once(source,'data-animating={animating > 0 || undefined}', 'data-animating={animating > 0 || undefined}\n      data-plus-shell');
    return {contents:source,loader:'tsx',resolveDir:dirname(path)};
  });
  build.onLoad({filter:/(?:ui-layout|ui-sidebar|ui-settings-general)\/src\/client\/.*\.module\.css$/},async({path})=>{
    const result=await esbuild({stdin:{contents:'import styles from '+JSON.stringify(path)+'; export default styles;',resolveDir:dirname(path)},bundle:true,write:false,outdir:'/tmp/commander-shell-css-memory',format:'cjs',loader:{'.css':'local-css'},logLevel:'silent'});
    const js=result.outputFiles.find(f=>f.path.endsWith('.js')),css=result.outputFiles.find(f=>f.path.endsWith('.css'));if(!js||!css)throw Error('Shell stylesheet failed');const module={exports:{}};new Function('module','exports',js.text)(module,module.exports);
    const id='commander-shell-'+path.split('/').at(-1);return {loader:'js',contents:'const id='+JSON.stringify(id)+';if(!document.getElementById(id)){const style=document.createElement("style");style.id=id;style.textContent='+JSON.stringify(css.text)+';document.head.append(style);}export default '+JSON.stringify(module.exports.default)+';'};
  });
}};}
