const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { flush } = require('./harness.cjs');
function optionsHarness(tabs = [{ id: 1, title: 'Xのブックマーク' }]) {
  const elements = new Map(), requests = [];
  const document = { getElementById(id) {
    if (!elements.has(id)) elements.set(id, { value: '', options: [], disabled: false, textContent: '', listeners: {}, addEventListener(type, fn) { this.listeners[type] = fn; }, replaceChildren(...nodes) { this.options = nodes; this.value = nodes[0]?.value ?? ''; } });
    return elements.get(id);
  } };
  let handler = async message => message.type === 'LIST_BOOKMARK_FOLDERS' ? { ok: true, account: 'login', folders: [{ id: '10', name: '<資料>' }] } : { ok: true, selected: { id: '10', name: '<資料>' } };
  class Option { constructor(text, value) { this.textContent = text; this.value = value; } }
  const chrome = { tabs: { query: async () => tabs }, runtime: { sendMessage: async message => { requests.push(message); return handler(message); } } };
  vm.runInNewContext(fs.readFileSync('dist/bookmark-folder-options.js', 'utf8'), { document, chrome, Option });
  return { elements, requests, set handler(value) { handler = value; }, click(id) { elements.get(id).listeners.click(); } };
}
test('folder settings require a loaded account, preserve names as text and save only the chosen ID', async () => {
  const h = optionsHarness(); await flush();
  assert.equal(h.elements.get('save-bookmark-folder').disabled, false);
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].type, 'LIST_BOOKMARK_FOLDERS');
  const selection = h.elements.get('bookmark-selection');
  assert.equal(selection.options[1].textContent, '<資料>'); selection.value = '10';
  h.click('save-bookmark-folder'); await flush();
  assert.equal(h.requests[1].account, 'login'); assert.equal(h.requests[1].folderId, '10'); assert.equal(h.requests[1].tabId, 1);
  assert.match(h.elements.get('bookmark-status').textContent, /登録先.*設定しました/);
  h.elements.get('bookmark-tab').listeners.change(); assert.equal(h.elements.get('save-bookmark-folder').disabled, true);
});
test('load errors leave registration disabled and settings can still be cleared', async () => {
  const h = optionsHarness(); await flush(); h.handler = async () => ({ ok: false, error: '取得失敗' });
  h.click('load-bookmark-folders'); await flush();
  assert.match(h.elements.get('bookmark-status').textContent, /取得失敗/);
  assert.equal(h.elements.get('save-bookmark-folder').disabled, true);
  assert.equal(h.elements.get('bookmark-selection').options.length, 1);
  assert.equal(h.elements.get('bookmark-selection').options[0].value, '');
  assert.match(h.elements.get('bookmark-selection').options[0].textContent, /利用できません/);
  h.handler = async () => ({ ok: true }); h.click('clear-bookmark-folders'); await flush();
  assert.equal(h.requests.at(-1).type, 'CLEAR_BOOKMARK_FOLDERS');
  assert.match(h.elements.get('bookmark-status').textContent, /解除しました/);
});
test('without an X tab, load is disabled and an empty valid list is distinguished from failure', async () => {
  const empty = optionsHarness([]); await flush(); assert.equal(empty.elements.get('load-bookmark-folders').disabled, true);
  const h = optionsHarness(); await flush(); h.handler = async () => ({ ok: true, account: 'login', folders: [] });
  h.click('load-bookmark-folders'); await flush();
  assert.match(h.elements.get('bookmark-status').textContent, /既存フォルダはありません/);
  assert.equal(h.elements.get('save-bookmark-folder').disabled, false);
});
