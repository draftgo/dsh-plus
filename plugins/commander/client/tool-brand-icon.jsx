/* Tool brand assets from CC Switch and existing Paseo marks.
MIT License

Copyright (c) 2025 Jason Young

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.*/
import React from 'react';
import icons from './icons.json';
import brands from './assets/tool-brands/catalog.json';
export function ToolBrandIcon({ tool, size = 20 }) {
  const id = tool === 'claude-desktop' || tool === 'claude-code' ? 'claude' : tool;
  const src = brands[id] || (icons[id] ? 'data:image/svg+xml,' + encodeURIComponent(icons[id]) : null);
  return <span className="cmd-tool-brand" aria-hidden="true" style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: size, height: size, flexShrink: 0, verticalAlign: 'middle' }}>{src ? <img src={src} alt="" width={size} height={size} draggable={false} style={{ display: 'block', width: size, height: size, objectFit: 'contain' }} /> : <span style={{ fontSize: size * .7 }}>⌘</span>}</span>;
}
