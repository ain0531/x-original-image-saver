const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const flush = () => new Promise(resolve => setImmediate(resolve));

function harness({ get, sendMessage } = {}) {
  const elements = new Map();
  const messages = [];
  const document = { getElementById: id => {
    if (!elements.has(id)) elements.set(id, {
      value: '', checked: true, disabled: false, textContent: '',
      addEventListener: (_, listener) => { elements.get(id).click = listener; },
    });
    return elements.get(id);
  } };
  const chrome = {
    tabs: { query: async () => [{ id: 1, url: 'https://x.com/home' }] },
    storage: { local: { get: get ?? (async () => ({})), set: async () => {} } },
    runtime: { sendMessage: async message => {
      messages.push(message);
      return sendMessage ? sendMessage(message) : { ok: true, removed: 1 };
    } },
  };
  const context = vm.createContext({ document, chrome, window: { confirm: () => true } });
  vm.runInContext(fs.readFileSync('dist/popup.js', 'utf8').replace(/export\s*\{\s*\};?/g, ''), context);
  return { elements, context, chrome, messages };
}

test('popup displays messaging failures and re-enables buttons', async () => {
  const h = harness({ sendMessage: async () => { throw new Error('connection lost'); } });
  await flush();
  h.elements.get('save-current-tweet').click();
  assert.equal(h.elements.get('clear-saved-history').disabled, true);
  await flush();
  assert.match(h.elements.get('status').textContent, /connection lost/);
  assert.equal(h.elements.get('save-current-tweet').disabled, false);
});

test('popup suppresses repeated clicks until the request finishes', async () => {
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
  assert.match(h.elements.get('status').textContent, /Downloaded: 1/);
});

test('history deletion goes through the worker', async () => {
  const h = harness(); await flush();
  h.elements.get('clear-saved-history').click();
  await flush();
  assert.equal(h.messages[0].type, 'CLEAR_SAVED_HISTORY');
  assert.match(h.elements.get('status').textContent, /Removed items: 1/);
});

test('initialization failures are visible and leave controls usable', async () => {
  const h = harness({ get: async () => { throw new Error('storage unavailable'); } });
  await flush();
  assert.match(h.elements.get('status').textContent, /storage unavailable/);
  assert.equal(h.elements.get('save-current-tweet').disabled, false);
});

test('scroll settings clamp invalid and excessive values', async () => {
  const h = harness(); await flush();
  h.elements.get('stable-rounds-needed').value = '0.5';
  h.elements.get('max-rounds').value = '99999';
  h.elements.get('scroll-ratio').value = '5';
  const settings = h.context.readScrollSettingsFromInputs();
  assert.equal(settings.stableRoundsNeeded, 1);
  assert.equal(settings.maxRounds, 1000);
  assert.equal(settings.scrollRatio, 1);
  const invalid = h.context.normalizeScrollSettings({ maxRounds: Infinity, maxElapsedSeconds: -1 });
  assert.equal(invalid.maxRounds, 20);
  assert.equal(invalid.maxElapsedSeconds, 30);
});
