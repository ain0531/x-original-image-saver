const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const flush = () => new Promise(resolve => setImmediate(resolve));
function buttonHarness(active = true, selections = {}) {
  class Element {
    constructor(tag) { this.tag = tag; this.children = []; this.attributes = {}; this.style = {}; this.listeners = {}; this.isConnected = true; }
    get parentElement() { return this.parent; }
    get nextElementSibling() {
      const siblings = this.parent?.children ?? [];
      return siblings[siblings.indexOf(this) + 1] ?? null;
    }
    append(...nodes) { for (const node of nodes) { if (node.parent) node.parent.children = node.parent.children.filter(child => child !== node); node.parent = this; this.children.push(node); } }
    after(node) {
      this.parent.append(node);
      const siblings = this.parent.children;
      siblings.pop();
      siblings.splice(siblings.indexOf(this) + 1, 0, node);
    }
    setAttribute(key, value) { this.attributes[key] = value; }
    getAttribute(key) { return this.attributes[key] ?? null; }
    toggleAttribute(key, force) { if (force) this.setAttribute(key, ''); else delete this.attributes[key]; }
    matches(selector) {
      const attribute = selector.match(/^:has\(> \[([^\]]+)\]\)$/)?.[1];
      return this.children.some(child => child.getAttribute(attribute) !== null);
    }
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
  const overlays = new Element('div');
  let observer, nextTimer = 0;
  const document = {
    documentElement: {}, querySelector: () => ({ querySelectorAll: () => articles }),
    querySelectorAll: selector => [...overlays.querySelectorAll(selector), ...articles.flatMap(article => article.querySelectorAll(selector))],
    createElement: tag => new Element(tag), addEventListener() {}, removeEventListener() {},
  };
  const chrome = { storage: { local: { get: async () => ({ specialSaveBookmarkFolders: selections }) }, onChanged: { addListener() {} } }, runtime: { id: 'test', getManifest: () => { if (!active) throw new Error('Extension context invalidated'); return {}; }, sendMessage: async message => { requests.push(message); throw new Error('No download messages allowed'); } } };
  class Observer { constructor(callback) { this.callback = callback; observer = this; } observe() {} disconnect() { this.disconnected = true; } }
  const listeners = new Map();
  const window = {
    addEventListener(type, listener) { listeners.set(type, listener); },
    removeEventListener(type, listener) { if (listeners.get(type) === listener) listeners.delete(type); },
  };
  const context = vm.createContext({ document, chrome, window, Element, location: { href: 'https://x.com/home' }, URL, MutationObserver: Observer,
    getComputedStyle: element => ({ display: 'block', flexDirection: 'row', ...element.style }),
    setInterval: callback => { intervals.push(callback); return intervals.length; }, clearInterval() {},
    setTimeout: (callback, ms) => { const id = ++nextTimer; if (ms === 100) queueMicrotask(callback); else timeouts.set(id, callback); return id; }, clearTimeout: id => timeouts.delete(id),
  });
  vm.runInContext(fs.readFileSync('dist/post-buttons.js', 'utf8'), context);
  const runScheduled = () => {
    for (const [id, callback] of [...timeouts]) { timeouts.delete(id); callback(); }
  };
  return {
    articles, requests, document, chrome, make, overlays, listeners, get observer() { return observer; },
    set active(value) { active = value; }, tick: () => intervals[0](),
    mutate(records = [{ type: 'childList' }]) { observer.callback(records); runScheduled(); },
    resize() { listeners.get('resize')(); runScheduled(); },
  };
}
const rows = article => article.querySelectorAll('[data-x-original-save]');
test('save row immediately follows the action group and targets only the clicked post', async () => {
  const h = buttonHarness();
  assert.equal(rows(h.articles[0]).length, 1);
  const group = h.articles[0].controls.like.parentElement;
  assert.equal(group.nextElementSibling, rows(h.articles[0])[0]);
  assert.equal(rows(group).length, 0);
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
test('redrawing the action group moves the same save row directly after it', async () => {
  const h = buttonHarness(), article = h.articles[0], row = rows(article)[0];
  const previousGroup = article.controls.like.parentElement;
  const replacementParent = h.document.createElement('div');
  const replacementGroup = h.document.createElement('div');
  const footer = h.document.createElement('div');
  replacementParent.style.display = 'flex';
  replacementGroup.setAttribute('role', 'group');
  previousGroup.remove();
  replacementGroup.append(article.controls.like, article.controls.bookmark);
  replacementParent.append(replacementGroup, footer);
  article.append(replacementParent);
  row.children[3].textContent = '保存結果';

  h.mutate();
  assert.deepEqual(replacementParent.children, [replacementGroup, row, footer]);
  assert.equal(rows(article).length, 1);
  assert.equal(row.children[3].textContent, '保存結果');
  assert.equal(row.getAttribute('data-x-original-save-wrap'), '');
  assert.match(row.style.cssText, /(?:^|;)width:100%;/);
  assert.match(row.children[0].style.cssText, /max-width:100%;.*overflow-wrap:anywhere/);

  replacementGroup.after = () => assert.fail('the save row is already in position');
  h.mutate();
  row.children[0].click(); await flush();
  assert.deepEqual(article.clicks, ['like', 'bookmark']);
});
test('manifest CSS wraps only horizontal flex parents, including after a layout change', () => {
  const script = require('../manifest.json').content_scripts.find(entry => entry.js.includes('dist/post-buttons.js'));
  const css = fs.readFileSync(script.css[0], 'utf8');
  assert.match(css, /:has\(> \[data-x-original-save\]\[data-x-original-save-wrap\]\)\s*\{\s*flex-wrap:\s*wrap/);

  const h = buttonHarness(), parent = h.articles[0], row = rows(parent)[0];
  const marker = 'data-x-original-save-wrap';
  assert.equal(row.getAttribute(marker), null);
  parent.style.display = 'inline-flex';
  parent.style.flexDirection = 'row-reverse';
  h.mutate([{ type: 'attributes', attributeName: 'style', target: parent }]);
  assert.equal(row.getAttribute(marker), '');

  parent.style.flexDirection = 'column';
  h.resize();
  assert.equal(row.getAttribute(marker), null);
  parent.style.flexDirection = 'column-reverse';
  h.mutate();
  assert.equal(row.getAttribute(marker), null);
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
test('missing controls use the bookmark fallback and report an unconfirmed response', async () => {
  const h = buttonHarness(), article = h.articles[0], row = rows(article)[0];
  h.chrome.runtime.sendMessage = async message => { h.requests.push(message); return { ok: true }; };
  article.controls.bookmark.remove(); row.children[0].click(); await flush();
  assert.match(row.children[1].textContent, /ブックマーク追加の応答を確認できません/);
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].type, 'SPECIAL_SAVE_BOOKMARK');
  assert.equal(row.children[0].getAttribute('aria-pressed'), 'false');
});
test('a share menu with a normal bookmark action stays closed while fallback and folder registration run', async () => {
  const h = buttonHarness(true, { login: { id: '10', name: '資料' } });
  h.articles.push(h.make('202')); h.mutate();
  const article = h.articles[1], row = rows(article)[0];
  article.controls.bookmark.remove();
  const share = h.document.createElement('button');
  share.setAttribute('data-testid', 'share');
  article.controls.like.parentElement.append(share);
  const menu = h.document.createElement('div'), item = h.document.createElement('div');
  menu.setAttribute('role', 'menu');
  item.setAttribute('role', 'menuitem');
  item.textContent = 'ブックマークに追加';
  item.listeners.click = () => article.clicks.push('menuBookmark');
  menu.append(item);
  share.listeners.click = () => { article.clicks.push('share'); h.overlays.append(menu); };

  h.chrome.runtime.sendMessage = async message => {
    h.requests.push(message);
    return message.type === 'SPECIAL_SAVE_BOOKMARK' ? { ok: true, verified: true }
      : { ok: true, configured: true, folder: { id: '10', name: '資料' } };
  };
  row.children[0].click(); await flush();
  assert.deepEqual(article.clicks, ['like']);
  assert.deepEqual(h.articles[0].clicks, []);
  assert.equal(h.overlays.children.length, 0);
  assert.deepEqual(h.requests.map(({ type, postId }) => [type, postId]), [
    ['SPECIAL_SAVE_BOOKMARK', '202'], ['SPECIAL_SAVE_FOLDER', '202'],
  ]);
  assert.match(row.children[1].textContent, /フォルダ「資料」に登録済み/);
});
test('a detail bookmark failure stays visible and prevents folder registration', async () => {
  const h = buttonHarness(true, { login: { id: '10', name: '資料' } });
  const article = h.articles[0], row = rows(article)[0];
  const error = '投稿詳細にブックマークボタンが見つかりません。';
  article.controls.bookmark.remove();
  h.chrome.runtime.sendMessage = async message => {
    h.requests.push(message);
    return { ok: false, error };
  };
  row.children[0].click(); await flush(); h.mutate();
  assert.deepEqual(h.requests.map(({ type, postId }) => [type, postId]), [['SPECIAL_SAVE_BOOKMARK', '101']]);
  assert.deepEqual(article.clicks, ['like']);
  assert.equal(row.children[1].textContent, error);
  assert.equal(row.children[0].getAttribute('aria-pressed'), 'false');
});
test('disabling extension removes its buttons and disconnects the observer', () => {
  const h = buttonHarness(); h.active = false; h.tick();
  assert.equal(h.document.querySelectorAll('[data-x-original-save]').length, 0); assert.equal(h.observer.disconnected, true);
  assert.equal(h.listeners.has('resize'), false);
  const disabled = buttonHarness(false); assert.equal(disabled.document.querySelectorAll('[data-x-original-save]').length, 0);
});

test('local save sits below special save and targets only the clicked timeline post', async () => {
  const h = buttonHarness(); h.articles.push(h.make('202')); h.mutate();
  const row = rows(h.articles[1])[0], button = row.children[2];
  assert.match(row.style.cssText, /flex-direction:column/);
  assert.equal(row.children[0].textContent, '特別保存'); assert.equal(button.textContent, 'ローカル保存');
  h.chrome.runtime.sendMessage = async message => {
    h.requests.push(message);
    return { ok: true, job: { id: 'job', status: 'done' }, busy: false, stats: { success: 3, skipped: 1, failed: 0 } };
  };
  button.click(); button.click(); await flush();
  assert.equal(h.requests.length, 1); assert.equal(h.requests[0].type, 'LOCAL_SAVE_POST'); assert.equal(h.requests[0].postId, '202');
  assert.deepEqual(h.articles[1].clicks, []); assert.deepEqual(h.articles[0].clicks, []);
  assert.match(row.children[3].textContent, /保存完了: 3/); assert.match(row.children[3].textContent, /保存済み: 1/);
  assert.equal(button.disabled, false); assert.equal(button.textContent, 'ローカル保存');
  h.mutate(); assert.equal(rows(h.articles[1]).length, 1); assert.equal(rows(h.articles[1])[0].children.length, 4);
});

test('local save monitors its job until completion and exposes download failures', async () => {
  const h = buttonHarness(), row = rows(h.articles[0])[0], button = row.children[2];
  h.chrome.runtime.sendMessage = async message => {
    h.requests.push(message);
    const done = message.type === 'GET_LOCAL_SAVE_STATUS';
    return { ok: true, job: { id: 'job', status: done ? 'review' : 'running', endedBy: 'current-post', issues: [] }, busy: !done, stats: { success: 0, skipped: 0, failed: done ? 1 : 0 }, failures: done ? ['A: NETWORK_FAILED'] : [] };
  };
  button.click(); await flush(); assert.equal(button.disabled, true);
  h.mutate(); await flush();
  assert.equal(h.requests[1].type, 'GET_LOCAL_SAVE_STATUS'); assert.equal(h.requests[1].jobId, 'job');
  assert.equal(h.requests[1].postId, '101'); assert.equal(button.disabled, false);
  assert.match(row.children[3].textContent, /NETWORK_FAILED/);
});

test('local save errors remain next to that post and preserve special-save controls', async () => {
  const h = buttonHarness(), row = rows(h.articles[0])[0];
  h.chrome.runtime.sendMessage = async () => ({ ok: false, error: '保存処理中です。' });
  row.children[2].click(); await flush();
  assert.match(row.children[3].textContent, /保存処理中/); assert.equal(row.children[2].disabled, false);
  assert.equal(row.children[0].textContent, '特別保存'); assert.deepEqual(h.articles[0].clicks, []);
});

test('recycled timeline article never saves using its old post ID', async () => {
  const h = buttonHarness(), article = h.articles[0], row = rows(article)[0];
  article.querySelector('a[href]').href = 'https://x.com/user/status/999';
  row.children[2].click(); await flush(); assert.deepEqual(h.requests, []);
  h.mutate(); assert.equal(rows(article)[0].getAttribute('data-x-original-save'), '999');
});

test('folder special save adds an already bookmarked post and reports the exact folder', async () => {
  const h = buttonHarness(true, { login: { id: '10', name: '資料' } });
  await flush(); h.mutate();
  const article = h.articles[0], row = rows(article)[0];
  article.controls.like.setAttribute('data-testid', 'unlike'); article.controls.bookmark.setAttribute('data-testid', 'removeBookmark');
  h.chrome.runtime.sendMessage = async message => { h.requests.push(message); return { ok: true, configured: true, folder: { id: '10', name: '資料' } }; };
  h.mutate(); assert.equal(row.children[0].getAttribute('aria-pressed'), 'false');
  row.children[0].click(); await flush();
  assert.deepEqual(article.clicks, []); assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].type, 'SPECIAL_SAVE_FOLDER'); assert.equal(h.requests[0].postId, '101');
  assert.match(row.children[1].textContent, /フォルダ「資料」に登録済み/);
});
test('folder rejection remains visible and retry never toggles the native bookmark off', async () => {
  const h = buttonHarness(true, { login: { id: '10', name: '資料' } }); await flush(); h.mutate();
  const row = rows(h.articles[0])[0];
  h.chrome.runtime.sendMessage = async () => ({ ok: false, error: '保存先が消失' });
  row.children[0].click(); await flush();
  assert.match(row.children[1].textContent, /フォルダ登録.*保存先が消失/);
  assert.equal(row.children[0].getAttribute('aria-pressed'), 'false');
  row.children[0].click(); await flush(); assert.deepEqual(h.articles[0].clicks, ['like', 'bookmark']);
});

test('native X article replacement during both controls still registers the folder and displays the result on the new row', async () => {
  const h = buttonHarness(true, { login: { id: '10', name: '資料' } }); await flush(); h.mutate();
  const original = h.articles[0], clicked = rows(original)[0].children[0];
  original.controls.like.listeners.click = () => {
    const next = h.make('101'); next.controls.like.setAttribute('data-testid', 'unlike');
    next.controls.bookmark.listeners.click = () => {
      const newest = h.make('101'); newest.controls.like.setAttribute('data-testid', 'unlike'); newest.controls.bookmark.setAttribute('data-testid', 'removeBookmark');
      next.isConnected = false; h.articles[0] = newest; h.mutate();
      assert.equal(rows(newest)[0].children[0].disabled, true);
      rows(newest)[0].children[0].click();
    };
    original.isConnected = false; h.articles[0] = next; h.mutate();
  };
  h.chrome.runtime.sendMessage = async message => { h.requests.push(message); return { ok: true, configured: true, folder: { id: '10', name: '資料' } }; };
  clicked.click(); await flush(); h.mutate();
  assert.equal(h.requests.length, 1); assert.equal(h.requests[0].postId, '101');
  assert.match(rows(h.articles[0])[0].children[1].textContent, /フォルダ「資料」に登録済み/);
  assert.equal(rows(h.articles[0])[0].children[0].disabled, false);
  const final = h.make('101'); h.articles[0].isConnected = false; h.articles[0] = final; h.mutate();
  assert.match(rows(final)[0].children[1].textContent, /フォルダ「資料」に登録済み/);
});
test('a row replaced while the folder request is pending keeps its error visible', async () => {
  const h = buttonHarness(true, { login: { id: '10', name: '資料' } }); await flush(); h.mutate();
  let finish;
  h.chrome.runtime.sendMessage = () => new Promise(resolve => { finish = resolve; });
  rows(h.articles[0])[0].children[0].click(); await flush();
  const next = h.make('101'); next.controls.like.setAttribute('data-testid', 'unlike'); next.controls.bookmark.setAttribute('data-testid', 'removeBookmark');
  h.articles[0].isConnected = false; h.articles[0] = next; h.mutate();
  assert.match(rows(next)[0].children[1].textContent, /指定フォルダへ登録しています/);
  finish({ ok: false, error: '指定フォルダに含まれていません' }); await flush(); h.mutate();
  assert.match(rows(next)[0].children[1].textContent, /フォルダ登録.*含まれていません/);
});
