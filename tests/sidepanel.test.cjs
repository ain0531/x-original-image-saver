const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const flush = () => new Promise(resolve => setImmediate(resolve));

test('an open side panel resolves the current window active tab for every save', async () => {
  const h = harness({ sendMessage: async () => ({
    ok: true, stats: { total: 0, success: 0, skipped: 0, failed: 0 },
  }) });
  await flush();
  let id = 11;
  h.chrome.tabs.query = async options => {
    assert.equal(options.active, true);
    assert.equal(options.currentWindow, true);
    return [{ id, url: 'https://x.com/home' }];
  };
  h.elements.get('save-current-tweet').click(); await flush();
  id = 12;
  h.elements.get('save-current-tweet').click(); await flush();
  assert.deepEqual(h.messages.map(message => message.tabId), [11, 12]);
});

function harness({ get, sendMessage } = {}) {
  const elements = new Map();
  const messages = [];
  const document = { getElementById: id => {
    if (!elements.has(id)) elements.set(id, {
      value: '', checked: !['specify-save-location', 'like-on-save'].includes(id), disabled: false, textContent: '',
      addEventListener: (event, listener) => { elements.get(id)[event] = listener; },
    });
    return elements.get(id);
  } };
  const chrome = {
    tabs: { query: async () => [{ id: 1, url: 'https://x.com/home' }] },
    storage: { local: { get: get ?? (async () => ({})), set: async () => {} } },
    runtime: { openOptionsPage: async () => {}, sendMessage: async message => {
      if (message.type === 'GET_SAVE_STATUS') return { ok: true };
      messages.push(message);
      return sendMessage ? sendMessage(message) : { ok: true, removed: 1 };
    } },
  };
  const context = vm.createContext({ document, chrome, window: { confirm: () => true }, setInterval: () => 1 });
  vm.runInContext(fs.readFileSync('dist/sidepanel.js', 'utf8').replace(/export\s*\{\s*\};?/g, ''), context);
  return { elements, context, chrome, messages };
}

test('side panel displays messaging failures and re-enables buttons', async () => {
  const h = harness({ sendMessage: async () => { throw new Error('connection lost'); } });
  await flush();
  h.elements.get('save-current-tweet').click();
  assert.equal(h.elements.get('clear-saved-history').disabled, true);
  await flush();
  assert.match(h.elements.get('status').textContent, /connection lost/);
  assert.equal(h.elements.get('save-current-tweet').disabled, false);
});

test('side panel suppresses repeated clicks until the request finishes', async () => {
  let resolve;
  const pending = new Promise(r => { resolve = r; });
  const h = harness({ sendMessage: () => pending });
  await flush();
  const button = h.elements.get('save-current-tweet');
  button.click(); button.click();
  await flush();
  assert.equal(h.messages.length, 1);
  resolve({ ok: true, stats: { total: 1, success: 1, skipped: 0, failed: 0 } });
  await flush();
  assert.equal(button.disabled, false);
  assert.match(h.elements.get('status').textContent, /保存完了: 1/);
});

test('history deletion goes through the worker', async () => {
  const h = harness(); await flush();
  h.elements.get('clear-saved-history').click();
  await flush();
  assert.equal(h.messages[0].type, 'CLEAR_SAVED_HISTORY');
  assert.match(h.elements.get('status').textContent, /消去件数: 1/);
});

test('initialization failures are visible and leave controls usable', async () => {
  const h = harness({ get: async () => { throw new Error('storage unavailable'); } });
  await flush();
  assert.match(h.elements.get('status').textContent, /storage unavailable/);
  assert.equal(h.elements.get('save-current-tweet').disabled, false);
});

test('side panel opens the registered options page', async () => {
  const h = harness(); await flush(); let opened = false;
  h.chrome.runtime.openOptionsPage = async () => { opened = true; };
  h.elements.get('open-options').click(); await flush(); assert.equal(opened, true);
  const manifest = JSON.parse(fs.readFileSync('manifest.json', 'utf8'));
  assert.equal(manifest.options_ui.page, 'options.html'); assert.equal(manifest.options_ui.open_in_tab, true);
});

test('save location checkbox defaults off and toggles only individual Save As requests', async () => {
  const html = fs.readFileSync('sidepanel.html', 'utf8');
  const input = html.match(/<input\b[^>]*id="specify-save-location"[^>]*>/)?.[0];
  assert.ok(input); assert.ok(!/\bchecked\b/.test(input));
  assert.ok(html.indexOf('id="save-current-tweet"') < html.indexOf('id="specify-save-location"'));
  const h = harness(); await flush();
  const checkbox = h.elements.get('specify-save-location');
  assert.equal(checkbox.checked, false);
  h.elements.get('save-current-tweet').click(); await flush();
  assert.equal(h.messages[0].saveAs, false);
  checkbox.checked = true;
  h.elements.get('save-current-tweet').click(); await flush();
  assert.equal(h.messages[1].saveAs, true);
  h.elements.get('save-all-visible').click(); await flush();
  assert.equal(h.messages[2].saveAs, false);
});

test('like checkbox defaults off, restores the shared setting and persists changes before saving', async () => {
  const input = fs.readFileSync('sidepanel.html', 'utf8').match(/<input\b[^>]*id="like-on-save"[^>]*>/)?.[0];
  assert.ok(input); assert.ok(!/\bchecked\b/.test(input));
  const h = harness(); await flush();
  assert.equal(h.elements.get('like-on-save').checked, false);
  const restored = harness({ get: async () => ({ likeOnSave: true }) }); await flush();
  assert.equal(restored.elements.get('like-on-save').checked, true);
  const writes = []; let release;
  restored.chrome.storage.local.set = async row => { writes.push(row); await new Promise(resolve => { release = resolve; }); };
  const checkbox = restored.elements.get('like-on-save'); checkbox.checked = false; checkbox.change();
  restored.elements.get('save-current-tweet').click(); await flush();
  assert.equal(writes[0].likeOnSave, false); assert.equal(restored.messages.length, 0);
  release(); await flush(); assert.equal(restored.messages[0].type, 'SAVE_CURRENT_TWEET_IMAGES');
});

test('save-location checkbox restores and writes the shared local-save setting before a sidebar save', async () => {
  const h = harness({ get: async () => ({ specifySaveLocation: true }) }); await flush();
  const checkbox = h.elements.get('specify-save-location'); assert.equal(checkbox.checked, true);
  const writes = []; let release;
  h.chrome.storage.local.set = async row => { writes.push(row); await new Promise(resolve => { release = resolve; }); };
  checkbox.checked = false; checkbox.change();
  h.elements.get('save-current-tweet').click(); await flush();
  assert.equal(writes[0].specifySaveLocation, false); assert.equal(h.messages.length, 0);
  release(); await flush(); assert.equal(h.messages[0].saveAs, false);
});
