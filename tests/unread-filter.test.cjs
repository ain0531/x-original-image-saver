const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { harness, flush } = require('./harness.cjs');
const plain = value => JSON.parse(JSON.stringify(value));
const xTab = (id, url = 'https://x.com/home') => ({ id: 'test', frameId: 0, url, tab: { id, url } });

function backgroundHarness() {
  const h = harness(); const sent = [];
  h.chrome.tabs.query = async options => { assert.deepEqual(plain(options.url), ['https://x.com/*', 'https://twitter.com/*']); return [{ id: 1 }, { id: 2 }]; };
  h.chrome.tabs.sendMessage = async (tabId, message) => { sent.push({ tabId, message }); };
  return { ...h, sent, request: h.request };
}
test('read posts are recorded in session storage only while the filter is on', async () => {
  const h = backgroundHarness();
  assert.deepEqual(plain(await h.request({ type: 'GET_UNREAD_FILTER' })), { ok: true, enabled: false, ids: [] });
  assert.deepEqual(plain(await h.request({ type: 'MARK_POSTS_READ', postIds: ['1'] }, xTab(1))), { ok: true, added: 0 });
  assert.equal(h.session.unreadFilter, undefined);
  assert.deepEqual(plain(await h.request({ type: 'SET_UNREAD_FILTER', enabled: true })), { ok: true, enabled: true });
  assert.deepEqual(plain(h.sent).map(row => row.message), [{ type: 'UNREAD_FILTER_STATE', enabled: true }, { type: 'UNREAD_FILTER_STATE', enabled: true }]);
  h.sent.length = 0;
  assert.deepEqual(plain(await h.request({ type: 'MARK_POSTS_READ', postIds: ['1', '2', '1'] }, xTab(1))), { ok: true, added: 2 });
  assert.deepEqual(plain(await h.request({ type: 'MARK_POSTS_READ', postIds: ['2', '3'] }, xTab(2))), { ok: true, added: 1 });
  assert.deepEqual(plain(h.sent), [{ tabId: 2, message: { type: 'UNREAD_FILTER_READ', postIds: ['1', '2'] } }, { tabId: 1, message: { type: 'UNREAD_FILTER_READ', postIds: ['3'] } }]);
  assert.deepEqual(plain(h.session.unreadFilter), { enabled: true, ids: ['1', '2', '3'] });
  await h.request({ type: 'SET_UNREAD_FILTER', enabled: false });
  assert.deepEqual(plain(await h.request({ type: 'MARK_POSTS_READ', postIds: ['4'] }, xTab(1))), { ok: true, added: 0 });
  assert.deepEqual(plain(h.session.unreadFilter), { enabled: false, ids: ['1', '2', '3'] });
  assert.deepEqual(plain(await h.request({ type: 'GET_UNREAD_FILTER' }, xTab(1))), { ok: true, enabled: false, ids: ['1', '2', '3'] });
});
test('unread filter requests are accepted only from the side panel and X tabs', async () => {
  const h = backgroundHarness();
  assert.equal((await h.request({ type: 'SET_UNREAD_FILTER', enabled: true }, xTab(1))).ok, false);
  assert.equal((await h.request({ type: 'SET_UNREAD_FILTER', enabled: 'yes' })).ok, false);
  assert.equal((await h.request({ type: 'MARK_POSTS_READ', postIds: ['1'] })).ok, false);
  assert.equal((await h.request({ type: 'MARK_POSTS_READ', postIds: ['1'] }, xTab(1, 'https://example.com/'))).ok, false);
  assert.equal((await h.request({ type: 'MARK_POSTS_READ', postIds: ['abc'] }, xTab(1))).ok, false);
  assert.equal((await h.request({ type: 'GET_UNREAD_FILTER' }, { id: 'other', url: 'chrome-extension://test/sidepanel.html' })).ok, false);
  assert.equal(h.session.unreadFilter, undefined);
});

function pageHarness({ enabled = true, ids = [], path = '/home' } = {}) {
  class Element {
    constructor(tag) { this.tag = tag; this.children = []; this.attributes = {}; this.isConnected = true; const props = {}; this.props = props; this.style = { setProperty: (k, v) => { props[k] = v; }, removeProperty: k => { delete props[k]; } }; }
    get parentElement() { return this.parent ?? null; }
    getBoundingClientRect() { for (let n = this; n; n = n.parent) if (n.rect) return n.rect; return { top: 1000, bottom: 1200, height: 200 }; }
    click() { this.clicks = (this.clicks ?? 0) + 1; }
    get tagName() { return this.tag.toUpperCase(); }
    contains(node) { for (let n = node; n; n = n.parent) if (n === this) return true; return false; }
    getElementsByTagName(tag) { return this.querySelectorAll(tag); }
    append(...nodes) { for (const node of nodes) { node.parent = this; this.children.push(node); } }
    setAttribute(k, v) { this.attributes[k] = v; } getAttribute(k) { return this.attributes[k] ?? null; }
    hasAttribute(k) { return k in this.attributes; } removeAttribute(k) { delete this.attributes[k]; }
    matches(s) { if (s.includes(',')) return s.split(',').some(part => this.matches(part.trim())); const a = s.match(/^\[([^=\]]+)(?:="([^"]+)")?\]$/); return a ? a[2] ? this.attributes[a[1]] === a[2] : a[1] in this.attributes : this.tag === s; }
    closest(s) { return this.matches(s) ? this : this.parent?.closest(s) ?? null; }
    querySelectorAll(s) { const all = this.children.flatMap(c => [c, ...c.querySelectorAll('*')]); return s === '*' ? all : all.filter(c => s === 'a[href]' ? c.tag === 'a' : c.matches(s)); }
    querySelector(s) { return this.querySelectorAll(s)[0] ?? null; }
  }
  const column = new Element('div'); column.setAttribute('data-testid', 'primaryColumn');
  const post = id => {
    const cell = new Element('div'), article = new Element('article'), link = new Element('a');
    cell.setAttribute('data-testid', 'cellInnerDiv'); link.href = 'https://x.com/user/status/' + id; link.append(new Element('time'));
    article.append(link); cell.append(article); column.append(cell); return { cell, article };
  };
  const timeouts = new Map(), messages = [], listeners = [], bridged = []; let nextTimer = 0, mutation, visibilityCallback, observed = new Set(), active = true;
  const location = { pathname: path, href: 'https://x.com' + path, origin: 'https://x.com' };
  const document = { documentElement: {}, visibilityState: 'visible', addEventListener() {}, removeEventListener() {}, querySelector: s => column.matches(s) ? column : column.querySelector(s), querySelectorAll: s => column.querySelectorAll(s) };
  const chrome = { runtime: { id: 'test', getManifest: () => { if (!active) throw new Error('invalidated'); return {}; },
    onMessage: { addListener: l => listeners.push(l), removeListener() {} },
    sendMessage: async message => { messages.push(message); return message.type === 'GET_UNREAD_FILTER' ? { ok: true, enabled, ids } : { ok: true }; } } };
  class Mutation { constructor(cb) { mutation = cb; } observe() {} disconnect() {} }
  class Intersection { constructor(cb) { visibilityCallback = cb; } observe(el) { observed.add(el); } unobserve(el) { observed.delete(el); } disconnect() { observed.clear(); } }
  const intervals = [];
  const context = vm.createContext({ document, chrome, location, URL, Element, innerHeight: 800, scrollY: 500, sessionStorage: { setItem() {}, removeItem() {} }, window: { postMessage: (data, origin) => { assert.equal(origin, 'https://x.com'); bridged.push(JSON.parse(JSON.stringify(data))); } }, MutationObserver: Mutation, IntersectionObserver: Intersection,
    setInterval: cb => { intervals.push(cb); return intervals.length; }, clearInterval() {},
    setTimeout: (cb, ms) => { const id = ++nextTimer; timeouts.set(id, { cb, ms }); return id; }, clearTimeout: id => timeouts.delete(id) });
  const run = ms => { for (const [id, t] of [...timeouts]) if (ms === undefined || t.ms === ms) { timeouts.delete(id); t.cb(); } };
  return { post, column, messages, bridged, location, observed, context, run,
    async start() { vm.runInContext(fs.readFileSync('dist/unread-filter.js', 'utf8'), context); await flush(); },
    mutate() { mutation(); run(80); },
    added(...nodes) { mutation([{ addedNodes: nodes }]); },
    see(article, ratio = 1, bottom = 500) { visibilityCallback([{ target: article, isIntersecting: ratio > 0, intersectionRatio: ratio, intersectionRect: { height: ratio * 100 }, boundingClientRect: { bottom }, rootBounds: { top: 0 } }]); },
    send(message) { listeners.forEach(l => l(message, { id: 'test' })); },
    set active(v) { active = v; }, tick: () => intervals[0]() };
}
const hidden = cell => cell.props.display === 'none';
test('home timeline hides previously read posts and keeps the post being read visible', async () => {
  const p = pageHarness({ ids: ['1'] });
  const old = p.post('1'), fresh = p.post('2');
  await p.start();
  assert.equal(hidden(old.cell), true); assert.equal(hidden(fresh.cell), false);
  assert.equal(p.observed.has(fresh.article), true); assert.equal(p.observed.has(old.article), false);
  p.see(fresh.article, 0.3); p.run(500); assert.equal(p.messages.filter(m => m.type === 'MARK_POSTS_READ').length, 0);
  p.see(fresh.article, 0.6); p.see(fresh.article, 0); p.run(500); p.run(1000);
  assert.equal(p.messages.filter(m => m.type === 'MARK_POSTS_READ').length, 0, 'leaving before 0.5s does not count');
  p.see(fresh.article, 0.6); p.run(500); p.run(1000);
  assert.deepEqual(plain(p.messages.filter(m => m.type === 'MARK_POSTS_READ')), [{ type: 'MARK_POSTS_READ', postIds: ['2'] }]);
  p.mutate(); assert.equal(hidden(fresh.cell), false, 'the post just read stays visible');
  fresh.cell.isConnected = false; p.column.children = p.column.children.filter(c => c !== fresh.cell);
  const again = p.post('2'); p.mutate();
  assert.equal(hidden(again.cell), false, 'a post read on this page is not hidden when X renders it again');
  assert.equal(p.observed.has(again.article), false);
  assert.deepEqual(p.bridged, [{ __xOriginalUnread: true, enabled: true, ids: ['1'] }, { __xOriginalUnread: true, ids: ['2'] }]);
});
test('filter does nothing outside home, while off, and restores posts when turned off or invalidated', async () => {
  const away = pageHarness({ ids: ['1'], path: '/i/bookmarks' }); const a = away.post('1'); await away.start();
  assert.equal(hidden(a.cell), false); assert.equal(away.observed.size, 0);
  const off = pageHarness({ enabled: false, ids: ['1'] }); const b = off.post('1'), c = off.post('2'); await off.start();
  assert.equal(hidden(b.cell), false); assert.equal(off.observed.size, 0);
  off.see(c.article); off.run(); assert.equal(off.messages.some(m => m.type === 'MARK_POSTS_READ'), false);
  const p = pageHarness({ ids: ['1'] }); const d = p.post('1'); await p.start();
  assert.equal(hidden(d.cell), true);
  p.send({ type: 'UNREAD_FILTER_STATE', enabled: false }); assert.equal(hidden(d.cell), false);
  assert.deepEqual(p.bridged.at(-1), { __xOriginalUnread: true, enabled: false });
  p.send({ type: 'UNREAD_FILTER_STATE', enabled: true }); await flush(); assert.equal(hidden(d.cell), true);
  p.location.pathname = '/user'; p.mutate(); assert.equal(hidden(d.cell), false);
  p.location.pathname = '/home'; p.mutate(); assert.equal(hidden(d.cell), true);
  p.active = false; p.tick(); assert.equal(hidden(d.cell), false);
  assert.deepEqual(p.bridged.at(-1), { __xOriginalUnread: true, enabled: false });
});
test('posts read in another tab are hidden on their next render', async () => {
  const p = pageHarness(); const a = p.post('5'); await p.start();
  p.send({ type: 'UNREAD_FILTER_READ', postIds: ['5'] }); p.mutate();
  assert.deepEqual(p.bridged.at(-1), { __xOriginalUnread: true, ids: ['5'] });
  assert.equal(hidden(a.cell), false);
  a.cell.isConnected = false; p.column.children = []; const b = p.post('5'); p.mutate();
  assert.equal(hidden(b.cell), true);
});

test('read posts added by X are hidden in the mutation callback before any delayed scan', async () => {
  const p = pageHarness({ ids: ['7'] }); await p.start();
  const old = p.post('7'), fresh = p.post('8');
  p.added(old.cell, fresh.cell);
  assert.equal(hidden(old.cell), true); assert.equal(hidden(fresh.cell), false);
  assert.equal(p.observed.has(fresh.article), true);
  const visible = p.post('7'); visible.cell.rect = { top: 100, bottom: 300, height: 200 }; p.added(visible.cell);
  assert.equal(hidden(visible.cell), false, 'a read post drawn inside the visible area is left alone');
  const outside = pageHarness({ ids: ['9'] }); await outside.start();
  const stray = outside.post('9'); outside.column.children = []; stray.cell.parent = undefined;
  outside.added(stray.cell); assert.equal(hidden(stray.cell), false);
});

test('the new posts bar on the home timeline is opened only while it is on screen', async () => {
  const bar = (p, text, rect) => { const cell = new p.column.constructor('div'), button = new p.column.constructor('div');
    cell.setAttribute('data-testid', 'cellInnerDiv'); button.setAttribute('role', 'button'); button.textContent = text; button.rect = rect;
    cell.append(button); p.column.children.unshift(cell); cell.parent = p.column; return button; };
  const p = pageHarness(); await p.start();
  const offscreen = bar(p, '12件のポストを表示', { top: -200, bottom: -150, height: 50 }); p.mutate();
  assert.equal(offscreen.clicks, undefined);
  offscreen.rect = { top: 0, bottom: 50, height: 50 }; p.mutate();
  assert.equal(offscreen.clicks, 1);
  const pill = bar(p, 'ポストしました', { top: 0, bottom: 50, height: 50 });
  const english = pageHarness(); await english.start();
  const show = bar(english, 'Show 3 posts', { top: 10, bottom: 60, height: 50 }); english.mutate();
  assert.equal(show.clicks, 1); assert.equal(pill.clicks, undefined);
  const off = pageHarness({ enabled: false }); await off.start();
  const idle = bar(off, '5件のポストを表示', { top: 0, bottom: 50, height: 50 }); off.mutate();
  assert.equal(idle.clicks, undefined);
  const away = pageHarness({ path: '/user' }); await away.start();
  const profile = bar(away, '5件のポストを表示', { top: 0, bottom: 50, height: 50 }); away.mutate();
  assert.equal(profile.clicks, undefined);
});

test('returning to the very top releases posts read on this page, hiding only cells below the viewport', async () => {
  const p = pageHarness();
  const a = p.post('11'), b = p.post('12'), c = p.post('13');
  await p.start(); p.context.scrollY = 1500;
  for (const item of [a, b, c]) { p.see(item.article, 1); p.run(500); }
  a.cell.rect = { top: -600, bottom: -400, height: 200 };
  b.cell.rect = { top: 100, bottom: 300, height: 200 };
  c.cell.rect = { top: 900, bottom: 1100, height: 200 };
  p.mutate();
  assert.equal([a, b, c].some(item => hidden(item.cell)), false, 'scrolling back part way hides nothing');
  p.column.children = p.column.children.filter(cell => cell !== c.cell);
  const again = p.post('13'); p.mutate();
  assert.equal(hidden(again.cell), false, 'a post read on this page is not hidden before returning to the top');
  p.context.scrollY = 0; p.mutate();
  assert.equal(hidden(a.cell), false, 'never hidden above the viewport');
  assert.equal(hidden(b.cell), false, 'never hidden on screen');
  assert.equal(hidden(again.cell), true, 'hidden below the viewport after returning to the top');
  p.column.children = p.column.children.filter(cell => cell !== b.cell);
  const later = p.post('12'); p.context.scrollY = 300; p.mutate();
  assert.equal(hidden(later.cell), true, 'hidden when X draws it below the viewport later');
  const above = p.post('11'); above.cell.rect = { top: -900, bottom: -700, height: 200 }; p.mutate();
  assert.equal(hidden(above.cell), false, 'drawn above the viewport: left alone so the screen does not move');
});

test('at the top, read posts X redraws are hidden before paint even inside the viewport', async () => {
  const p = pageHarness({ ids: ['21'] }); p.context.scrollY = 0;
  const restored = p.post('21'); restored.cell.rect = { top: 100, bottom: 300, height: 200 };
  await p.start();
  assert.equal(hidden(restored.cell), true, 'a post read on an earlier page, restored at the top on load');
  const current = p.post('22'); current.cell.rect = { top: 300, bottom: 500, height: 200 };
  p.added(current.cell); p.see(current.article, 1); p.run(500);
  p.mutate();
  assert.equal(hidden(current.cell), false, 'reading at the top without scrolling away releases nothing');
  p.column.children = p.column.children.filter(cell => cell !== current.cell);
  const redrawn = p.post('22'); redrawn.cell.rect = { top: 300, bottom: 500, height: 200 }; p.added(redrawn.cell);
  assert.equal(hidden(redrawn.cell), false, 'still not released');
  p.context.scrollY = 2000; p.mutate();
  p.context.scrollY = 0;
  p.column.children = p.column.children.filter(cell => cell !== redrawn.cell);
  const top = p.post('22'); top.cell.rect = { top: 300, bottom: 500, height: 200 }; p.added(top.cell);
  assert.equal(hidden(top.cell), true, 'after a jump back to the top, the redrawn read post is hidden before paint');
});

test('a post that appeared and was scrolled past the top counts as read even when skimmed quickly', async () => {
  const p = pageHarness(); const skimmed = p.post('31'), below = p.post('32'), never = p.post('33');
  await p.start();
  p.see(skimmed.article, 0.2); p.see(skimmed.article, 0, -10);
  p.see(below.article, 0.2); p.see(below.article, 0, 1200);
  p.see(never.article, 0, -10);
  p.run(1000);
  assert.deepEqual(plain(p.messages.filter(m => m.type === 'MARK_POSTS_READ')), [{ type: 'MARK_POSTS_READ', postIds: ['31'] }]);
});

test('returning to the top tells the page filter which posts to drop from X, except those on screen', async () => {
  const p = pageHarness();
  const a = p.post('41'), b = p.post('42');
  await p.start(); p.context.scrollY = 1500;
  p.see(a.article, 1); p.run(500); p.see(b.article, 1); p.run(500);
  a.cell.rect = { top: 100, bottom: 300, height: 200 };
  b.cell.rect = { top: 1000, bottom: 1200, height: 200 };
  p.mutate();
  p.context.scrollY = 0; p.mutate();
  assert.deepEqual(p.bridged.filter(m => m.release), [{ __xOriginalUnread: true, release: ['42'] }]);
});
