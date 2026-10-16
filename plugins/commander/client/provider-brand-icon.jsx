import React from 'react';
import brands from './assets/provider-brands/catalog.json';
import { providerBrand, providerInitial } from './provider-brand.mjs';

export function ProviderBrandIcon({ id, name, declared = false, size = 20 }) {
  const brand = providerBrand(id, declared), src = brands[brand];
  return <span className="cmd-provider-brand" data-provider-brand={brand || 'custom'} aria-hidden="true" style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, width: size, height: size, verticalAlign: 'middle' }}>{src ? <img src={src} alt="" width={size} height={size} draggable={false} style={{ display: 'block', width: size, height: size, objectFit: 'contain', filter: 'none' }} /> : <span className="cmd-provider-brand-initial" style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: size, height: size, borderRadius: 5, background: 'var(--dsw-alias-interactive-bg-hover, #8881)', fontSize: Math.max(11, size * .6), fontWeight: 600, lineHeight: 1 }}>{providerInitial(name, id)}</span>}</span>;
}
