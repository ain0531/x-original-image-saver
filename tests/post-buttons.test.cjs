const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const flush = () => new Promise(resolve => setImmediate(resolve));
function buttonHarness(active = true) {
  class Element {
    constructor(tag) { this.tag = tag; this.children = []; this.attributes = {}; this.style = {}; this.listeners = {}; this.isConnected = true; }
    get parentElement() { return this.parent; }
    append(...nodes) { for (const node of nodes) { if (node.parent) node.parent.children = node.parent.children.filter(child => child !== node); node.parent = this; this.children.push(node); } }
    appendChild(node) { this.append(node); }
    setAttribute(key, value) { this.attributes[key] = value; }
    getAttribute(key) { return this.attributes[key] ?? null; }
    closest(tag) { return this.tag === tag ? this : this.parent?.closest(tag) ?? null; }
    querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
    querySelectorAll(selector) {
      const all = this.children.flatMap(child => [child, ...child.querySelectorAll('*')]);
      if (selector === '*') return all;
      return all.filter(child => selector.split(',').some(raw => {
        const s = raw.trim();
        if (s === 'a[href]') return child.tag === 'a';
        const attr = s.match(/^\[([^=\]]+)(?:="([^"]+)")?\]$/);
        return attr ? attr[2] ? child.getAttribute(attr[1]) === attr[2] : child.getAttribute(attr[1]) !== null : child.tag === s;
      }));
    }
    addEventListener(type, listener) { this.listeners[type] = listener; }
    click() { this.listeners.click?.({ preventDefault() {}, stopPropagation() {} }); }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter(node => node !== this); this.isConnected = false; }
  }
  const make = id => {
    const article = new Element('article'), link = new Element('a'), group = new Element('div');
    link.href = 'https://x.com/user/status/' + id; link.append(new Element('time'));
    group.setAttribute('role', 'group'); article.append(link, group);
    article.controls = {}; article.clicks = [];
    for (const [off, on] of [['like', 'unlike'], ['bookmark', 'removeBookmark']]) {
      const control = new Element('button'); control.setAttribute('data-testid', off);
      control.listeners.click = () => { article.clicks.push(off); if (!control.fail) control.setAttribute('data-testid', on); };
      article.controls[off] = control; group.append(control);
    }
    return article;
  };
  const articles = [make('101')], timeouts = new Map(), intervals = [], requests = [];
  let observer, nextTimer = 0;
  const document = {
    documentElement: {}, querySelector: () => ({ querySelectorAll: () => articles }),
    querySelectorAll: selector => articles.flatMap(article => article.querySelectorAll(selector)),
    createElement: tag => new Element(tag), addEventListener() {}, removeEventListener() {},
  };
  const chrome = { runtime: { id: 'test', getManifest: () => { if (!active) throw new Error('Extension context invalidated'); return {}; }, sendMessage: async message => { requests.push(message); throw new Error('No download messages allowed'); } } };
  class Observer { constructor(callback) { this.callback = callback; observer = this; } observe() {} disconnect() { this.disconnected = true; } }
  const context = vm.createContext({ document, chrome, location: { href: 'https://x.com/home' }, URL, MutationObserver: Observer,
    setInterval: callback => { intervals.push(callback); return intervals.length; }, clearInterval() {},
    setTimeout: (callback, ms) => { const id = ++nextTimer; if (ms === 100) queueMicrotask(callback); else timeouts.set(id, callback); return id; }, clearTimeout: id => timeouts.delete(id),
  });
  vm.runInContext(fs.readFileSync('dist/post-buttons.js', 'utf8'), context);
  return { articles, requests, document, make, get observer() { return observer; }, set active(value) { active = value; }, tick: () => intervals[0](), mutate() { observer.callback(); for (const [id, callback] of [...timeouts]) { timeouts.delete(id); callback(); } } };
}
const rows = article => article.querySelectorAll('[data-x-original-save]');
test('button is in the action row, follows new posts, likes and bookmarks only the clicked post', async () => {
  const h = buttonHarness();
  assert.equal(rows(h.articles[0]).length, 1);
  assert.equal(rows(h.articles[0])[0].parentElement.getAttribute('role'), 'group');
  h.mutate(); assert.equal(rows(h.articles[0]).length, 1);
  h.articles.push(h.make('202')); h.mutate();
  const row = rows(h.articles[1])[0], button = row.children[0], status = row.children[1];
  button.click(); button.click(); await flush();
  assert.deepEqual(h.articles[1].clicks, ['like', 'bookmark']);
  assert.deepEqual(h.articles[0].clicks, []); assert.deepEqual(h.requests, []);
  assert.equal(button.getAttribute('aria-pressed'), 'true'); assert.equal(button.textContent, '特別保存済み');
  assert.equal(status.textContent, 'いいね・ブックマーク済み'); assert.equal(button.disabled, false);
  button.click(); await flush(); assert.deepEqual(h.articles[1].clicks, ['like', 'bookmark']);
});
test('existing like is preserved, bookmark alone is added, and native changes update state', async () => {
  const h = buttonHarness(), article = h.articles[0], button = rows(article)[0].children[0];
  article.controls.like.setAttribute('data-testid', 'unlike');
  button.click(); await flush(); assert.deepEqual(article.clicks, ['bookmark']);
  article.controls.like.setAttribute('data-testid', 'like'); h.mutate();
  assert.equal(button.getAttribute('aria-pressed'), 'false'); assert.equal(button.textContent, '特別保存');
});
test('partial failure is reported and retry does not undo the successful action', async () => {
  const h = buttonHarness(), article = h.articles[0], row = rows(article)[0];
  article.controls.bookmark.fail = true;
  row.children[0].click(); await flush();
  assert.match(row.children[1].textContent, /ブックマークの反映を確認できません/);
  assert.equal(row.children[0].getAttribute('aria-pressed'), 'false');
  article.controls.bookmark.fail = false; row.children[0].click(); await flush();
  assert.deepEqual(article.clicks, ['like', 'bookmark', 'bookmark']); assert.deepEqual(h.requests, []);
});
test('missing controls report failure without downloading', async () => {
  const h = buttonHarness(), article = h.articles[0], row = rows(article)[0];
  article.controls.bookmark.remove(); row.children[0].click(); await flush();
  assert.match(row.children[1].textContent, /ブックマークの操作ボタンを確認できません/);
  assert.deepEqual(h.requests, []);
});
test('disabling extension removes its buttons and disconnects the observer', () => {
  const h = buttonHarness(); h.active = false; h.tick();
  assert.equal(h.document.querySelectorAll('[data-x-original-save]').length, 0); assert.equal(h.observer.disconnected, true);
  const disabled = buttonHarness(false); assert.equal(disabled.document.querySelectorAll('[data-x-original-save]').length, 0);
});
