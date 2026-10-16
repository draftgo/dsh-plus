import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import * as helpers from '../client/sidebar-state.mjs';

const require = createRequire(import.meta.url);
const { transformSync } = require('esbuild');
const source = readFileSync(new URL('../client/index.jsx', import.meta.url), 'utf8');
const code = transformSync(source + '\nexport { Projects }; export function setSidebarSnapshot(snapshot, defaultId) { data = snapshot; defaultWorkspaceId = defaultId; }', { loader: 'jsx', format: 'cjs' }).code;

function render(activeSessionId, options = {}) {
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity).filter(child => child !== false && child != null) }),
    useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
    useRef: initial => ({ current: initial }), useEffect() {},
    useSyncExternalStore: (_subscribe, snapshot) => snapshot(),
  };
  const module = { exports: {} };
  runInNewContext(code, { module, exports: module.exports, localStorage: { getItem: () => null }, require: id => id === 'react' ? react : id.endsWith('sidebar-state.mjs') ? helpers : {} });
  const sessions = ['first', 'second', 'third'];
  module.exports.setSidebarSnapshot(options.commander ?? { loaded: true, projects: [{ id: 'recent', isDefault: true, sessionIds: sessions }], sessions: [] }, options.defaultId);
  const snapshot = { byId: Object.fromEntries(sessions.map(id => [id, { id, title: id, retainedBy: id === activeSessionId ? { mainView: 1 } : {}, blank: false }])) };
  const host = {
    sessions: { list: { getSnapshot: () => snapshot } },
    workspaces: { list: { getSnapshot: () => options.workspaces ?? ({ archivedSessionIds: [] }) } },
    uiSession: { sessionStatus: { getSnapshot: () => new Map() } },
  };
  const tree = module.exports.Projects({ host, open() {}, newSession: options.newSession ?? (() => {}) });
  const walk = node => node && typeof node === 'object' ? [node, ...node.children.flatMap(walk)] : [];
  return walk(tree);
}

test('loaded sidebar has no selected row while no conversation is open', () => {
  const nodes = render(undefined);
  assert.equal(nodes.filter(node => node.props.className?.split(' ').includes('cmd-session')).length, 3);
  assert.equal(nodes.filter(node => node.props.className?.split(' ').includes('cmd-selected')).length, 0);
  assert.equal(nodes.filter(node => node.props['aria-current'] === 'page').length, 0);
  assert.equal(nodes.filter(node => node.props.className?.split(' ').includes('is-selected')).length, 0);
});

test('restoring and switching current conversation selects exactly one matching row', () => {
  for (const active of ['first', 'second', 'third']) {
    const nodes = render(active), selected = nodes.filter(node => node.props['aria-current'] === 'page');
    assert.equal(selected.length, 1);
    assert(selected[0].children.some(child => child.type === 'span' && child.children.includes(active)));
    assert.equal(nodes.filter(node => node.props.className?.split(' ').includes('cmd-selected')).length, 1);
    assert.equal(nodes.filter(node => node.props.className?.split(' ').includes('is-selected')).length, 1);
  }
});

test('official workspaces render projects and conversations before Commander state returns', () => {
  const calls=[],nodes=render('first',{
    commander:{loaded:false,projects:[],sessions:[]},defaultId:'recent',
    workspaces:{phase:'ready',archivedSessionIds:[],items:[{workspaceId:'recent',title:'default',sessionIds:['first','second']},{workspaceId:'fresh',title:'Fresh project',sessionIds:['third']}]},
    newSession:id=>calls.push(id),
  });
  assert(nodes.some(node=>node.type==='span'&&node.children.includes('Fresh project')));
  assert.equal(nodes.filter(node=>node.props.className?.split(' ').includes('cmd-session')).length,2);
  assert.equal(nodes.filter(node=>node.props['aria-current']==='page').length,1);
  assert.equal(nodes.some(node=>node.children.includes('正在读取项目…')),false);
  nodes.find(node=>node.props['aria-label']==='在 Fresh project 新聊天').props.onClick();
  assert.deepEqual(calls,['fresh']);
});

test('ready empty official workspaces clear stale projects and rows', () => {
  const nodes=render(undefined,{workspaces:{phase:'ready',items:[],archivedSessionIds:[]}});
  assert.equal(nodes.filter(node=>node.props.className?.split(' ').includes('cmd-session')).length,0);
  assert.equal(nodes.some(node=>node.children.includes('暂无项目')),true);
});
