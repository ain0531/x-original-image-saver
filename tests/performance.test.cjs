const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { harness, page } = require('./harness.cjs');
const start = h => h.request({ type: 'SAVE_ALL_VISIBLE_IMAGES', tabId: 1 });
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const countFullReads = h => {
  const get = h.chrome.storage.local.get; const counter = { full: 0 };
  h.chrome.storage.local.get = async keys => { if (keys == null) counter.full++; return get(keys); };
  return counter;
};

test('download change events finish a transfer before the fallback poll while status stays live', async () => {
  const h = harness(); h.pages.push(page(['A']));
  const original = h.chrome.downloads.download;
  h.chrome.downloads.download = async options => { const id = await original(options); h.states.get(id).state = 'in_progress'; return id; };
  await start(h);
  for (let n = 0; n < 100 && !h.calls.length; n++) await wait(5);
  await wait(20);
  const during = await h.request({ type: 'GET_SAVE_STATUS' });
  assert.equal(during.stats.pending, 1); assert.equal(during.stats.success, 0);
  const completedAt = Date.now();
  for (const item of h.states.values()) item.state = 'complete';
  h.downloadChanged([...h.states.keys()][0]);
  let status;
  for (let n = 0; n < 200; n++) { status = await h.request({ type: 'GET_SAVE_STATUS' }); if (status.stats.success === 1) break; await wait(5); }
  assert.equal(status.stats.success, 1);
  assert.ok(Date.now() - completedAt < 500, `completion took ${Date.now() - completedAt}ms`);
  assert.equal((await h.done()).job.status, 'done');
});

test('transient bookmark request failures keep the learned route; a rejected route is discarded', async () => {
  for (const [status, kept] of [[429, true], [503, true], [404, false], [401, false]]) {
    const h = harness();
    h.observe({ method: 'GET', tabId: 1, url: 'https://x.com/i/api/graphql/OBSERVED/Bookmarks?variables=%7B%7D&features=%7B%7D', requestHeaders: [{ name: 'authorization', value: 'Bearer native' }, { name: 'x-csrf-token', value: 'csrf-test' }] });
    const direct = vm.runInContext('directBookmarks', h.context);
    const identity = await direct.login(1);
    await vm.runInContext('directBookmarks.captures', h.context);
    assert.ok(h.session['bookmarkDirect:0']);
    const fetch = h.context.fetch;
    h.context.fetch = async (raw, init) => new URL(raw).pathname.includes('/graphql/') ? { ok: false, status } : fetch(raw, init);
    await assert.rejects(direct.page(identity.storeId, identity.scope, 'cursor'), new RegExp(`HTTP ${status}`));
    assert.equal(!!h.session['bookmarkDirect:0'], kept, `HTTP ${status}`);
  }
});

test('identical observed requests do not rewrite the session template', async () => {
  const h = harness(); let writes = 0;
  const set = h.chrome.storage.session.set; h.chrome.storage.session.set = async rows => { writes++; return set(rows); };
  const details = { method: 'GET', tabId: 1, url: 'https://x.com/i/api/graphql/OBSERVED/Bookmarks?variables=%7B%7D&features=%7B%22a%22%3Atrue%7D', requestHeaders: [{ name: 'authorization', value: 'Bearer native' }, { name: 'x-csrf-token', value: 'csrf-test' }] };
  h.observe(details); h.observe(details); h.observe(details);
  const direct = vm.runInContext('directBookmarks', h.context); await direct.login(1);
  await vm.runInContext('directBookmarks.captures', h.context);
  assert.equal(writes, 1);
  h.observe({ ...details, url: details.url.replace('%22a%22', '%22b%22') });
  await vm.runInContext('directBookmarks.captures', h.context);
  assert.equal(writes, 2); assert.deepEqual(h.session['bookmarkDirect:0'].features, { a: true, b: true });
});

test('history checks read only the requested keys once the Chrome import is done', async () => {
  const h = harness({ imageHistoryMigratedV2: true, imageHistoryDownloadIndexV1: true, 'savedImage:A': { savedAt: Date.now() - 1000, quality: 'orig' } });
  const counter = countFullReads(h);
  const history = vm.runInContext('new ImageHistory()', h.context);
  const result = await history.confirmedMany([{ mediaId: 'A', format: 'jpg', origUrl: '' }, { mediaId: 'B', format: 'jpg', origUrl: '' }]);
  assert.equal(result.get('A'), 0); assert.equal(result.get('B'), null);
  assert.equal(counter.full, 0);
});

test('local save results are pruned by recorded keys without reading every saved ID', async () => {
  const done = { job: { status: 'done' } };
  const initial = { imageHistoryMigratedV2: true, imageHistoryDownloadIndexV1: true };
  for (let n = 1; n <= 101; n++) {
    initial['localSaveRequest:old' + n] = { id: 'old' + n, order: n, tabId: 1, postId: '1', state: 'finished', result: done, keys: ['localSaveJob:old' + n, 'localSaveTask:old' + n + ':old' + n + ':M'] };
    initial['localSaveJob:old' + n] = { id: 'old' + n }; initial['localSaveTask:old' + n + ':old' + n + ':M'] = {};
  }
  const preferences = { maxPages: 20, maxSeconds: 30, folder: '', fileName: '{mediaId}_orig.{format}' };
  const snap = { pageUrl: 'https://x.com/user/status/1', scope: 'post', documentId: 1, urls: [], posts: ['1'], issues: [], loading: false, bottom: false, y: 0 };
  initial['localSaveRequest:new'] = { id: 'new', order: 102, tabId: 1, postId: '1', snap, preferences, state: 'queued' };
  const h = harness(initial);
  for (let n = 0; n < 200 && h.store['localSaveRequest:new'].state !== 'finished'; n++) await wait(5);
  for (let n = 0; n < 50 && h.store['localSaveRequest:old1']; n++) await wait(5);
  assert.equal(h.store['localSaveRequest:new'].state, 'finished');
  assert.deepEqual(h.store['localSaveRequest:new'].keys, ['localSaveJob:new']);
  for (const key of ['localSaveRequest:old1', 'localSaveJob:old1', 'localSaveTask:old1:old1:M', 'localSaveRequest:old2']) assert.equal(key in h.store, false, key);
  assert.ok(h.store['localSaveRequest:old3']);
});
