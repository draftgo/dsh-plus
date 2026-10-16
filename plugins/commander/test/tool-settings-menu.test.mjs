import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
test('tool dropdown styles reach through the shared Menu viewport',()=>{
 const css=readFileSync(new URL('../client/tool-settings.css',import.meta.url),'utf8');
 assert.doesNotMatch(css,/\.cmd-tool-select-menu\s*>\s*(?:button|input)/);
 assert.match(css,/\.cmd-tool-select-menu button\s*\{/);
 assert.match(css,/\.cmd-tool-select-menu input\s*\{/);
 const jsx=readFileSync(new URL('../client/tool-settings.jsx',import.meta.url),'utf8');
 assert.match(jsx,/disabled=\{disabled\} aria-label=\{label\}/);
 assert.match(jsx,/<Menu open=\{open && !disabled\}/);
});
