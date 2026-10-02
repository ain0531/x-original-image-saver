const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { harness, page } = require('./harness.cjs');
const start = h => h.request({ type: 'SAVE_ALL_VISIBLE_IMAGES', tabId: 1 });
const url = id => `https://pbs.twimg.com/media/${id}?format=jpg&name=orig`;
test('native bookmark route observation is reused without bootstrap and secrets stay out of local storage', async () => {
  const h = harness(); h.pages.push(page(['A'], 'cursor'), page(['B']));
  const route = 'https://x.com/i/api/graphql/OBSERVED/Bookmarks?variables=%7B%22cursor%22%3A%22old%22%7D&features=%7B%22observed_feature%22%3Atrue%7D';
  h.observe({ method: 'GET', tabId: 1, url: route, requestHeaders: [{ name: 'Authorization', value: 'Bearer private-test' }, { name: 'X-CSRF-Token', value: 'csrf-test' }] });
  assert.equal((await start(h)).ok, true); await h.done();
  assert.equal(h.createdTabs.length, 0); assert.equal(h.directRequests.length, 2);
  for (const request of h.directRequests) {
    const endpoint = new URL(request.url); assert.equal(endpoint.pathname, '/i/api/graphql/OBSERVED/Bookmarks');
    assert.equal(request.init.credentials, 'include'); assert.equal(request.init.headers['x-csrf-token'], 'csrf-test');
    assert.equal(JSON.parse(endpoint.searchParams.get('features')).observed_feature, true);
  }
  assert.equal(JSON.parse(new URL(h.directRequests[0].url).searchParams.get('variables')).cursor, undefined);
  assert.equal(JSON.parse(new URL(h.directRequests[1].url).searchParams.get('variables')).cursor, 'cursor');
  assert.ok(!JSON.stringify(h.store).includes('private-test')); assert.ok(!JSON.stringify(h.store).includes('csrf-test'));
  assert.ok(!JSON.stringify(h.store).includes('logged-in-account'));
});
test('a Likes request cannot authorize a non-bookmark direct route', async () => {
  const h = harness(); h.pages.push(page(['A']));
  h.observe({ method: 'GET', tabId: 1, url: 'https://x.com/i/api/graphql/OTHER/Likes?features=%7B%7D', requestHeaders: [{ name: 'authorization', value: 'Bearer native' }, { name: 'x-csrf-token', value: 'csrf-test' }] });
  assert.equal((await start(h)).ok, true); await h.done();
  assert.ok(h.directRequests.filter(request => request.url.includes('/graphql/')).every(request => new URL(request.url).pathname.endsWith('/Bookmarks')));
});
test('client metadata extraction uses current feature values and rejects unknown features', () => {
  const h = harness();
  const config = 'queryId:"NEW_ID",operationName:"Bookmarks",metadata:{featureSwitches:["known_feature"]}';
  const result = h.context.clientBookmarkConfig(config, { known_feature: false });
  assert.equal(result.route, 'https://x.com/i/api/graphql/NEW_ID/Bookmarks'); assert.equal(result.features.known_feature, false);
  assert.throws(() => h.context.clientBookmarkConfig(config, {}), /取得設定/);
  assert.equal(h.context.clientBookmarkConfig(config.replace('Bookmarks', 'Likes'), { known_feature: false }), undefined);
});
test('rate limits and account changes stop initial preparation without a tab or page-image fallback', async () => {
  for (const mode of ['http', 'account']) {
    const h = harness(); h.snap.urls = [url('DOM_ONLY')]; const fetch = h.context.fetch;
    h.context.fetch = async (raw, init) => {
      if (!raw.includes('/graphql/')) return fetch(raw, init);
      if (mode === 'http') return { ok: false, status: 429 };
      if (mode === 'account') h.auth = 'other-account';
      return { ok: true, json: async () => page(['A']) };
    };
    assert.equal((await start(h)).ok, false);
    assert.equal(h.calls.length, 0); assert.equal(h.createdTabs.length, 0);
    assert.equal(h.injections.length, 0);
  }
});
test('direct resume works after the originally active tab is closed', async () => {
  const h = harness(); h.pages.push(page(['A'], 'next'));
  await h.request({ type: 'SAVE_ALL_VISIBLE_IMAGES', tabId: 1, scrollSettings: { maxRounds: 1 } }); await h.done();
  h.chrome.tabs.get = async () => { throw new Error('Tab closed'); }; h.pages.push(page(['B']));
  assert.equal((await h.request({ type: 'RESUME_SAVE' })).ok, true); const result = await h.done(); assert.equal(result.stats.success, 2);
});
test('Chrome history imports completed originals by image ID including older and moved files', async () => {
  const h = harness({ savedMediaKeys: ['OLD|png'] }); h.pages.push(page(['OLD', 'NEW']));
  h.states.set(99, { id: 99, url: url('OLD'), finalUrl: url('OLD'), state: 'complete', exists: false, mime: 'image/jpeg', startTime: new Date(Date.now() - 400 * 86400000).toISOString() });
  assert.equal((await start(h)).ok, true); const result = await h.done();
  assert.equal(result.stats.skipped, 1); assert.equal(result.stats.success, 1); assert.equal(h.calls[0].url, url('NEW'));
  assert.equal(h.store['savedImage:OLD'].quality, 'orig'); assert.ok(h.store.imageHistoryDownloadIndexV1);
});
test('known IDs skip even when the Chrome history import is unavailable', async () => {
  const h = harness({ imageHistoryMigratedV2: true, 'savedImage:A': { savedAt: Date.now() - 1000, quality: 'orig' } }); h.pages.push(page(['A']));
  h.chrome.downloads.search = async () => { throw new Error('History unavailable'); };
  assert.equal((await start(h)).ok, true); const result = await h.done(); assert.equal(result.stats.skipped, 1); assert.equal(h.calls.length, 0);
});
test('unreadable or ambiguous history still saves fail safe', async () => {
  const h = harness({ imageHistoryMigratedV2: true, 'savedImage:A': { savedAt: Date.now() + 86400000, quality: 'orig' }, 'savedImage:B': { quality: 'unknown', savedAt: Date.now() } });
  h.pages.push(page(['A', 'B'])); assert.equal((await start(h)).ok, true); const result = await h.done(); assert.equal(result.stats.success, 2);
});
test('saved-ID lookup uses extension records without searching Chrome for every image', async () => {
  const h = harness({ imageHistoryMigratedV2: true, imageHistoryDownloadIndexV1: true, 'savedImage:A': { savedAt: Date.now() - 1000, quality: 'orig' } });
  h.pages.push(page(['A'], 'next'), page(['A'])); let searches = 0;
  h.chrome.downloads.search = async () => { searches++; throw new Error('Should not be called'); };
  await start(h); const result = await h.done(); assert.equal(result.stats.skipped, 1); assert.equal(searches, 0);
});
