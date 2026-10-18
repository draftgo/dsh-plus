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
  const snapshot = { byId: Object.fromEntries(sessions.map(id => [id, { id, title: id, retainedBy: id === activeSessionId ? { mainView: 1 } : {}, blank: false, running: false }])) };
  const host = {
    sessions: { list: { getSnapshot: () => snapshot } },
    workspaces: { list: { getSnapshot: () => options.workspaces ?? ({ archivedSessionIds: [] }) } },
    remoteAccess: { source: () => ({ subscribe: () => () => {}, getSnapshot: () => true }) },
    uiSession: { sessionStatus: { getSnapshot: () => options.statuses ?? new Map() } },
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

test('live official sessions light their workspace without adding a global toolbar indicator', () => {
  for (const [status, expected] of [[{}, undefined], [{ running: true }, 'running'], [{ running: true, pendingInteraction: true }, 'waiting']]) {
    const nodes = render(undefined, {
      defaultId: 'recent', statuses: new Map([['third', status]]),
      workspaces: { phase: 'ready', items: [{ workspaceId: 'recent', sessionIds: ['first', 'second'] }, { workspaceId: 'project', title: 'Project', sessionIds: ['third'] }] },
    });
    const activity = nodes.filter(node => node.props.className === 'cmd-project-activity');
    assert.equal(activity.length, expected ? 1 : 0);
    assert.equal(activity[0]?.props.status, expected);
    const toolbar = nodes.find(node => node.props['aria-label'] === '快捷工具栏');
    assert.equal(toolbar.children.length, 2, 'only new chat and search remain');
  }
});

test('Recent shows activity for its default workspace', () => {
  const nodes = render(undefined, { statuses: new Map([['first', { pendingInteraction: true }]]) });
  const label = nodes.find(node => node.props.className === 'cmd-section-label');
  assert.equal(label.children.find(node => typeof node === 'object')?.props.status, 'waiting');
});

test('session list exposes completed, running and waiting icons without keeping workspace activity lit after completion', () => {
  const nodes=render(undefined,{statuses:new Map([['second',{running:true}],['third',{running:true,pendingInteraction:{kind:'question'}}]])});
  const rows=nodes.filter(node=>node.props.className?.split(' ').includes('cmd-session'));
  assert.deepEqual(rows.map(row=>row.children.find(child=>typeof child==='object')?.props.status),['completed','running','waiting']);
  const completed=render(undefined);
  assert.equal(completed.some(node=>node.props.className==='cmd-project-activity'),false);
  assert.equal(completed.find(node=>node.props.className==='cmd-section-label').children.filter(child=>typeof child==='object').length,0);
});

test('archived and dismissed official sessions do not keep workspace activity visible', () => {
  for (const archived of [true, false]) {
    const nodes = render(undefined, {
      defaultId: 'recent', statuses: new Map([['third', { running: true }]]),
      commander: { loaded: true, sessions: [], projects: [], deletedHarnessIds: archived ? [] : ['third'] },
      workspaces: { phase: 'ready', archivedSessionIds: archived ? ['third'] : [], items: [{ workspaceId: 'project', sessionIds: ['third'] }] },
    });
    assert.equal(nodes.some(node => node.props.className === 'cmd-project-activity'), false);
  }
});
