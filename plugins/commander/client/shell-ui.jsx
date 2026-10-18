import React, { useEffect, useMemo } from 'react';
import { AppFrame } from '../../../deepseek-harness/packages/client/ui-layout/src/client/AppFrame.tsx';
import { createResponsiveLayoutActions } from './responsive-layout.mjs';
import { SidebarRoot } from '../../../deepseek-harness/packages/client/ui-sidebar/src/client/SidebarRoot.tsx';
import { SettingsRoot } from '../../../deepseek-harness/packages/client/ui-settings-general/src/client/SettingsRoot.tsx';
/** Reversible views retain the official owner's stores, injections and child-slot declarations. */
export function recentTranslation(locale,original){return function(namespace,key,params){return key==='workspace.defaultName'?(locale.getLocale().active==='zh'?'最近':'Recent'):original.call(this,namespace,key,params);};}

function ResponsiveAppFrame(props) {
  const actions = useMemo(() => createResponsiveLayoutActions(props.actions), [props.actions]);
  useEffect(() => () => actions.dispose(), [actions]);
  return <AppFrame {...props} actions={actions} />;
}

export function mountShellUi(ctx){
  for(const [name,owns,component] of [['root','sidebar',ResponsiveAppFrame],['sidebar','sidebar.workspaces',SidebarRoot],['sidebar.settings','settings.section',SettingsRoot]])ctx.effect(()=>{
    const entry=ctx.slots.entries(name).find(item=>item.children?.[owns]);if(!entry)throw Error('Official shell entry is unavailable: '+name);
    const original=entry.component;entry.component=component;return ()=>{if(entry.component===component)entry.component=original;};
  });
  // Preserve the official stable bound translators, including already-mounted views.
  ctx.effect(()=>{
    const locale=ctx.locale,original=locale.translate;
    if(typeof original!=='function')throw Error('Official locale translation adapter is unavailable');
    const translate=recentTranslation(locale,original);
    locale.translate=translate;return ()=>{if(locale.translate===translate)locale.translate=original;};
  });
}
