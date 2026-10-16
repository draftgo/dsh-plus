import React from 'react';
import catalog from './assets/iconsax/catalog.json';
/** Vendored Iconsax assets, Linear for resting controls and Bold for selection. */
export function UIIcon({ name, size = 20, selected = false, className = '' }) {
  const asset = catalog[name] ?? catalog.plugins;
  return <span className={`cmd-ui-icon ${selected ? 'is-selected' : ''} ${className}`} style={{ width: size, height: size }} aria-hidden="true"><span className="cmd-ui-linear" dangerouslySetInnerHTML={{ __html: asset.linear }} /><span className="cmd-ui-bold" dangerouslySetInnerHTML={{ __html: asset.bold }} /></span>;
}
