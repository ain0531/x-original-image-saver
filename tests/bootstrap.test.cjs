const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { harness, page, nativeBootstrap } = require('./harness.cjs');
const start = h => h.request({ type: 'SAVE_ALL_VISIBLE_IMAGES', tabId: 1 });
const unknownClient = h => {
  const fetch = h.context.fetch;
  h.context.fetch = async (raw, init) => raw.includes('/i/bookmarks') ? { ok: true, url: raw, text: async () => '<html>Unknown client</html>' } : fetch(raw, init);
};

test('unknown client initializes from one inactive native tab, closes it and continues via data', async () => {
  const h = harness(); unknownClient(h); nativeBootstrap(h, page(['A', 'B'], 'next'));
  h.pages.push(page(['C']));
  assert.equal((await start(h)).ok, true);
  assert.deepEqual(h.removedTabs, [2]);
  assert.equal(h.createdTabs[0].active, false); assert.equal(h.createdTabs[0].windowId, 1);
  const result = await h.done(); assert.equal(result.stats.success, 3);
  assert.equal(result.job.status, 'done'); assert.equal(result.job.rounds, 2);
  assert.equal(h.session.bookmarkBootstrapTab, undefined);
  assert.equal(h.injections.length, 1); assert.equal(h.injections[0].world, 'MAIN');
  const requests = h.directRequests.filter(call => call.url.includes('/graphql/'));
  assert.equal(requests.length, 1); assert.equal(JSON.parse(new URL(requests[0].url).searchParams.get('variables')).cursor, 'next');
  h.pages.push(page(['D'])); assert.equal((await start(h)).ok, true); await h.done();
  assert.equal(h.createdTabs.length, 1); assert.ok(!h.removedTabs.includes(1));
});

test('first data request rejected by X can initialize from native response without a second click', async () => {
  for (const status of [401, 403]) {
    const h = harness(); nativeBootstrap(h, page(['A'])); const fetch = h.context.fetch;
    h.context.fetch = async (raw, init) => raw.includes('/TEST_QUERY/Bookmarks') ? { ok: false, status } : fetch(raw, init);
    assert.equal((await start(h)).ok, true); const result = await h.done();
    assert.equal(result.stats.success, 1); assert.deepEqual(h.removedTabs, [2]);
    h.context.fetch = async raw => ({ ok: false, status });
    assert.equal((await start(h)).ok, false); assert.equal(h.createdTabs.length, 1);
  }
});

test('malformed native response is not replaced with DOM images and its tab is closed', async () => {
  const h = harness(); unknownClient(h); nativeBootstrap(h, { data: { home: {} } });
  h.snap.urls = ['https://pbs.twimg.com/media/WRONG.jpg'];
  const result = await start(h); assert.equal(result.ok, false); assert.match(result.error, /応答形式/);
  assert.equal(h.calls.length, 0); assert.deepEqual(h.removedTabs, [2]);
  assert.equal(h.session.bookmarkBootstrapTab, undefined);
});

test('account change while native initialization runs stops and closes only its own tab', async () => {
  const h = harness(); unknownClient(h); nativeBootstrap(h);
  const create = h.chrome.tabs.create;
  h.chrome.tabs.create = async options => { const tab = await create(options); h.auth = 'different-account'; return tab; };
  const result = await start(h); assert.equal(result.ok, false); assert.match(result.error, /アカウント/);
  assert.equal(h.calls.length, 0); assert.deepEqual(h.removedTabs, [2]);
});

test('native initialization timeout closes the temporary tab', async () => {
  const h = harness(); unknownClient(h); nativeBootstrap(h);
  h.chrome.scripting.executeScript = async () => [{ result: { available: false } }];
  let now = Date.now();
  h.context.Date = class extends Date { static now() { return now; } };
  h.context.setTimeout = (callback, ms) => { now += ms; return setImmediate(callback); };
  h.context.clearTimeout = clearImmediate;
  const result = await start(h); assert.equal(result.ok, false); assert.match(result.error, /30秒/);
  assert.equal(h.calls.length, 0); assert.deepEqual(h.removedTabs, [2]);
  assert.equal(h.session.bookmarkBootstrapTab, undefined);
});

test('logout redirect closes the initialization tab without downloading', async () => {
  const h = harness(); unknownClient(h); nativeBootstrap(h);
  h.backgroundSnap.pageUrl = 'https://x.com/i/flow/login';
  const result = await start(h); assert.equal(result.ok, false); assert.match(result.error, /ログイン/);
  assert.deepEqual(h.removedTabs, [2]); assert.equal(h.calls.length, 0);
});

test('history redirect waits for the bookmark header to mount before accepting the first page', async () => {
  const h = harness(); unknownClient(h); nativeBootstrap(h, page(['A']));
  h.backgroundSnap.pageUrl = 'https://x.com/i/history';
  let polls = 0;
  h.chrome.scripting.executeScript = async () => [{ result: { available: true, scope: JSON.stringify([h.backgroundSnap.pageUrl, ++polls === 1 ? '' : 'ブックマーク', 'account']), documentId: 2, data: page(['A']) } }];
  assert.equal((await start(h)).ok, true); assert.equal((await h.done()).stats.success, 1);
  assert.equal(polls, 2); assert.deepEqual(h.removedTabs, [2]);
});

test('worker restart cleans up a recorded initialization tab before preparing a new job', async () => {
  const h = harness(); await h.done();
  await h.chrome.tabs.create({ url: 'https://x.com/i/bookmarks', active: false });
  h.session.bookmarkBootstrapTab = { tabId: 2 };
  const direct = vm.runInContext('new DirectBookmarks()', h.context);
  await direct.prepare(1);
  assert.deepEqual(h.removedTabs, [2]); assert.equal(h.session.bookmarkBootstrapTab, undefined);
});
