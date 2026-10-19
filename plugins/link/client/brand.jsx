import React from 'react';
import logo from '../../../assets/brand/dsh-plus-logo.svg';
import favicon from '../../../assets/brand/favicon.svg';

export const brandIcon = `data:image/svg+xml,${encodeURIComponent(logo)}`;
const faviconIcon = `data:image/svg+xml,${encodeURIComponent(favicon)}`;

export function BrandLogo({ size = 32, className = '', decorative = false }) {
  return <img src={brandIcon} width={size} height={size} className={className} alt={decorative ? '' : '小角'} style={{ display: 'block', flex: 'none' }} />;
}

/** Keep both official light/dark favicon nodes branded; restore them when the plugin unloads. */
export function mountBrand(ctx) {
  ctx.effect(() => {
    const links = [...document.querySelectorAll('link[rel~="icon"]')];
    const previous = links.map(link => [link, link.getAttribute('href'), link.getAttribute('type')]);
    const created = !links.length;
    if (created) { const link = document.createElement('link'); link.rel = 'icon'; document.head.append(link); links.push(link); }
    for (const link of links) { link.href = faviconIcon; link.type = 'image/svg+xml'; }
    return () => {
      if (created) links[0].remove();
      for (const [link, href, type] of previous) {
        if (href === null) link.removeAttribute('href'); else link.setAttribute('href', href);
        if (type === null) link.removeAttribute('type'); else link.setAttribute('type', type);
      }
    };
  });
}
