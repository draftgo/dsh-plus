import React, { useSyncExternalStore } from 'react';
import { Tooltip, IconDarkOutlineMedium, IconLightOutlineMedium } from '@deepseek-ai/dsh-client-ui-primitives';

export function createThemeSource(ctx) {
  return {
    getSnapshot: () => ctx.theme.getTheme(),
    subscribe: listener => ctx.on('theme/change', listener),
    setTheme: preference => ctx.theme.setTheme(preference),
  };
}

export function ThemeLauncher({ theme }) {
  const snapshot = useSyncExternalStore(theme.subscribe, theme.getSnapshot);
  const dark = snapshot.active.colorScheme === 'dark';
  const label = dark ? '切换到浅色模式' : '切换到深色模式';
  const Icon = dark ? IconLightOutlineMedium : IconDarkOutlineMedium;
  return <Tooltip label={label} delayMs={450} portal>
    <button type="button" className="cmd-archive-launcher cmd-theme-launcher" aria-label={label}
      onClick={() => theme.setTheme(theme.getSnapshot().active.colorScheme === 'dark' ? 'light' : 'dark')}>
      <Icon size={16} />
    </button>
  </Tooltip>;
}
