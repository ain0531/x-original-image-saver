const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const { harness, page, flush } = require('./harness.cjs');
const url = (id = 'IMAGE', format = 'jpg') => `https://pbs.twimg.com/media/${id}?format=${format}&name=orig`;
const start = h => h.request({ type: 'SAVE_ALL_VISIBLE_IMAGES', tabId: 1 });

test('media identity and original URL normalize legacy and query formats', () => {
  const h = harness();
  assert.equal(h.context.parseMediaUrl('https://pbs.twimg.com/media/IMAGE.jpg:large').origUrl, url());
  assert.equal(h.context.parseMediaUrl('https://foreign.example/media/IMAGE.jpg'), null);
  assert.equal(h.context.parseMediaUrl('https://pbs.twimg.com/media/IMAGE?format=exe'), null);
});
test('batch saves bookmark data directly without tabs or DOM injection', async () => {
  const h = harness(); h.snap.urls = [url()];
  assert.equal((await start(h)).ok, true);
  const result = await h.done();
  assert.equal(result.stats.success, 1);
  assert.equal(result.job.source, 'direct');
  assert.equal(result.job.endedBy, 'timeline-end');
  assert.equal(result.job.status, 'done');
  assert.equal(h.injections.length, 0); assert.equal(h.createdTabs.length, 0);
  assert.equal(h.calls[0].url, url());
  assert.equal(h.calls[0].saveAs, false);
});
test('network pagination saves unseen original images without DOM scroll', async () => {
  const h = harness(); h.available = true; h.snap.urls = [url('RECOMMENDATION')]; h.pages.push(page(['A', 'B'], 'next'), page(['C']));
  await start(h); const result = await h.done();
  assert.equal(result.job.source, 'direct'); assert.equal(result.job.endedBy, 'timeline-end');
  assert.equal(result.stats.success, 3);
  assert.ok(!h.calls.some(call => call.url.includes('RECOMMENDATION')));
  assert.ok(h.calls.every(call => call.url.endsWith('name=orig')));
  assert.deepEqual(h.directRequests.filter(call => call.url.includes('/graphql/')).map(call => JSON.parse(new URL(call.url).searchParams.get('variables')).cursor ?? null), [null, 'next']);
  assert.equal(h.injections.length, 0);
});
test('format variants are one image and verified existing originals are skipped', async () => {
  const h = harness(); h.snap.urls = [url('A'), url('A', 'png')];
  await start(h); await h.done(); assert.equal(h.calls.length, 1);
  await start(h); const result = await h.done(); assert.equal(h.calls.length, 1); assert.equal(result.stats.skipped, 1);
});
test('unknown history is saved fail safe, but known IDs remain saved after file deletion', async () => {
  const h = harness({ savedMediaMap: { 'A|jpg': Date.now() } }); h.snap.urls = [url('A')];
  await start(h); await h.done(); assert.equal(h.calls.length, 1);
  h.states.get(1).exists = false;
  h.states.clear(); await start(h); const result = await h.done(); assert.equal(h.calls.length, 1); assert.equal(result.stats.skipped, 1);
});
test('old history migrates real timestamps; large downloads cannot confirm originals', async () => {
  const stamp = Date.now() - 1000;
  const h = harness({ savedMediaMap: { 'A|jpg': stamp, 'A|png': stamp - 1000 } }); h.snap.urls = [url('A')];
  h.states.set(99, { id: 99, url: url('A').replace('orig', 'large'), finalUrl: url('A').replace('orig', 'large'), state: 'complete', exists: true, mime: 'image/jpeg' });
  await start(h); await h.done(); assert.equal(h.calls.length, 1); assert.equal(h.store.savedMediaMap, undefined);
});
test('confirmed image IDs do not expire after 180 days or depend on Chrome history', async () => {
  const h = harness({ imageHistoryMigratedV2: true, 'savedImage:A': { savedAt: Date.now() - 181 * 86400000, quality: 'orig', downloadId: 99 } });
  h.states.set(99, { id: 99, url: url('A'), finalUrl: url('A'), exists: true, state: 'complete', mime: 'image/jpeg' }); h.snap.urls = [url('A')];
  h.states.clear(); await start(h); const result = await h.done(); assert.equal(h.calls.length, 0); assert.equal(result.stats.skipped, 1);
});
test('original transfer failure is retained; no large fallback is attempted', async () => {
  const h = harness(); h.snap.urls = [url()];
  h.chrome.downloads.download = async options => { h.calls.push(options); throw new Error('NETWORK_FAILED'); };
  await start(h); const result = await h.done();
  assert.equal(result.stats.failed, 1); assert.equal(h.calls.length, 1);
  assert.equal(h.store['savedImage:IMAGE'], undefined);
  assert.ok(result.failures[0].includes('NETWORK_FAILED'));
});
test('a source error retains and downloads already collected images', async () => {
  const h = harness(); h.available = true; h.pages.push(page(['A'], 'next'), { errors: [{ message: 'rate limit' }] });
  await start(h); const result = await h.done();
  assert.equal(result.stats.success, 1); assert.equal(result.job.status, 'paused'); assert.equal(result.job.cursor, 'next');
});
test('page limit reports partial acquisition and retains cursor for resume', async () => {
  const h = harness(); h.available = true; h.pages.push(page(['A'], 'next'));
  await h.request({ type: 'SAVE_ALL_VISIBLE_IMAGES', tabId: 1, scrollSettings: { maxRounds: 1 } });
  const result = await h.done(); assert.equal(result.job.endedBy, 'max-rounds'); assert.equal(result.job.status, 'review'); assert.equal(result.job.cursor, 'next');
  h.pages.push(page(['B'])); await h.request({ type: 'RESUME_SAVE' }); const resumed = await h.done(); assert.equal(resumed.stats.success, 2);
});
test('new head start preserves failed work instead of discarding it', async () => {
  const h = harness(); h.snap.urls = [url('A')];
  const download = h.chrome.downloads.download;
  h.chrome.downloads.download = async () => { throw new Error('temporary'); };
  await start(h); await h.done();
  h.chrome.downloads.download = download; h.snap.urls = [url('B')];
  await start(h); const result = await h.done(); assert.equal(result.stats.success, 2);
});
test('worker restart reconciles known download IDs without downloading twice', async () => {
  const scope = JSON.stringify(['https://x.com/i/history', 'ブックマーク', 'account']);
  const h = harness({ imageHistoryMigratedV2: true, imageSaveJob: { id: 'job', tabId: 1, url: 'https://x.com/i/history', scope, documentId: 1, source: 'loaded', status: 'running', sourceDone: true, endedBy: 'loaded-only', issues: [], rounds: 0 }, 'imageSaveTask:job:A': { media: { mediaId: 'A', format: 'jpg', origUrl: url('A') }, state: 'downloading', downloadId: 99 } });
  h.states.set(99, { id: 99, state: 'complete', exists: true, mime: 'image/jpeg', url: url('A'), finalUrl: url('A') });
  const result = await h.done(); assert.equal(result.stats.success, 1); assert.equal(h.calls.length, 0);
});
test('four transfers run concurrently while source retrieval continues', async () => {
  const h = harness(); h.available = true; h.pages.push(page(['A', 'B', 'C', 'D', 'E']));
  const original = h.chrome.downloads.download;
  h.chrome.downloads.download = async options => { const id = await original(options); h.states.get(id).state = 'in_progress'; return id; };
  await start(h);
  for (let n = 0; n < 50 && h.calls.length < 4; n++) await new Promise(r => setTimeout(r, 10));
  assert.equal(h.calls.length, 4);
  for (const item of h.states.values()) item.state = 'complete';
  h.chrome.downloads.download = original;
  const result = await h.done(); assert.equal(result.stats.success, 5);
});
test('unrecognized response is never considered successful empty timeline', () => {
  const h = harness(); assert.throws(() => h.context.parseBookmarkPage({ data: { unknown: {} } }), /応答形式/);
  const data = page(['A']); data.data.bookmark_timeline_v2.timeline.instructions[0].entries[0].content.itemContent.tweet_results.result = { __typename: 'TweetUnavailable' };
  const result = h.context.parseBookmarkPage(data); assert.equal(result.issues.length, 1); assert.equal(result.ended, false);
});
test('completion with HTML response or resized redirect does not create history', async () => {
  for (const mode of ['mime', 'redirect']) {
    const h = harness(); h.snap.urls = [url()]; const download = h.chrome.downloads.download;
    h.chrome.downloads.download = async options => { const id = await download(options); if (mode === 'mime') h.states.get(id).mime = 'text/html'; else h.states.get(id).finalUrl = url().replace('orig', 'large'); return id; };
    await start(h); const result = await h.done(); assert.equal(result.stats.failed, 1); assert.equal(h.store['savedImage:IMAGE'], undefined);
  }
});
test('manifest installs MAIN capture at document_start and toolbar side panel', () => {
  const manifest = JSON.parse(fs.readFileSync('manifest.json', 'utf8'));
  assert.equal(manifest.content_scripts[0].world, 'MAIN'); assert.equal(manifest.content_scripts[0].run_at, 'document_start');
  assert.equal(manifest.side_panel.default_path, 'sidepanel.html'); assert.equal(manifest.action.default_popup, undefined);
});


test('history write failure retains a complete download ID; resume records without redownload', async () => {
  const h = harness(); h.snap.urls = [url('A')];
  const set = h.chrome.storage.local.set;
  let fail = true;
  h.chrome.storage.local.set = async rows => { if (fail && rows['savedImage:A']) throw new Error('disk unavailable'); return set(rows); };
  await start(h); const stopped = await h.done();
  assert.equal(stopped.job.status, 'paused'); assert.equal(stopped.stats.pending, 1); assert.equal(h.calls.length, 1);
  fail = false;
  await h.request({ type: 'RESUME_SAVE' }); const resumed = await h.done();
  assert.equal(resumed.stats.success, 1); assert.equal(h.calls.length, 1);
});
test('late-loading image URL is collected without scrolling and its warning resolves', async () => {
  const h = harness(); h.snap.issues = ['投稿 1: 読み込まれていない画像があります。']; h.snap.loading = true;
  await h.request({ type: 'SAVE_CURRENT_TWEET_IMAGES', tabId: 1 });
  h.snap.urls = [url('LATE')]; h.snap.issues = []; h.snap.loading = false;
  const result = await h.done();
  assert.equal(result.stats.success, 1);
  assert.ok(!result.job.issues.some(issue => issue.includes('読み込まれていない画像')));
  assert.ok(h.injections.every(call => call.world === 'MAIN' || call.args.length === 1));
});
test('actual injected DOM reader uses currentSrc and restricts collection to primary post articles', async () => {
  const h = harness();
  const article = { querySelectorAll: selector => selector === 'img' ? [{ currentSrc: url('REAL'), getAttribute: () => url('STALE') }] : selector.includes('removeBookmark') ? [{ closest: () => article }] : [], querySelector: () => null };
  const recommendation = { querySelectorAll: selector => selector === 'img' ? [{ currentSrc: url('UNBOOKMARKED') }] : [], querySelector: () => null };
  const root = { querySelector: selector => selector.includes('aria-selected') ? { textContent: 'ブックマーク' } : null, querySelectorAll: () => [article, recommendation] };
  h.context.document = { querySelector: selector => selector.includes('AccountSwitcher') ? null : root };
  h.context.location = { href: h.snap.pageUrl, pathname: '/i/history' };
  h.context.performance = { timeOrigin: 1 };
  h.context.window = { scrollY: 123, innerHeight: 900, scrollBy: () => { throw new Error('scroll is forbidden'); } };
  h.context.document.documentElement = { scrollHeight: 5000 };
  h.chrome.scripting.executeScript = async options => [{ result: await options.func(...options.args) }];
  const result = await h.context.snapshot(1);
  assert.equal(result.urls.length, 1); assert.equal(result.urls[0], url('REAL'));
  assert.equal(result.excludedPosts, 1);
  assert.equal(h.context.window.scrollY, 123);
});

test('current-post route enriches a one-image DOM with all four native photo URLs', async () => {
  const h = harness(); h.snap.posts = ['101']; h.snap.urls = [url('A')];
  h.cached.push({ postId: '101', urls: [url('A'), url('B'), url('C'), url('D')], complete: true });
  await h.request({ type: 'SAVE_CURRENT_TWEET_IMAGES', tabId: 1 }); const result = await h.done();
  assert.equal(result.stats.success, 4); assert.equal(result.job.source, 'current');
  assert.ok(!result.job.issues.some(issue => issue.includes('全画像')));
  assert.equal(new Set(h.calls.map(call => call.url)).size, 4);
});

test('batch on other pages saves native bookmarks without any tabs or page images', async () => {
  for (const [path, selected] of [['/home', 'おすすめ'], ['/user/status/123', ''], ['/user', ''], ['/i/history', 'いいね'], ['/i/history', ''], ['/i/history', 'Likes']]) {
    const h = harness(); h.snap.pageUrl = 'https://x.com' + path;
    h.snap.scope = JSON.stringify([h.snap.pageUrl, selected, 'account']);
    h.snap.urls = [url('OTHER')]; h.available = true; h.pages.push(page(['BOOKMARK']));
    const result = await start(h);
    assert.equal(result.ok, true, path + selected); await h.done();
    assert.equal(h.createdTabs.length, 0); assert.equal(h.injections.length, 0);
    assert.equal(h.store.imageSaveJob.source, 'direct'); assert.equal(h.store.imageSaveJob.background, true);
    assert.equal(h.calls.length, 1); assert.equal(h.calls[0].url, url('BOOKMARK'));
    assert.equal(h.snap.pageUrl, 'https://x.com' + path);
  }
});
test('a non-X page also starts bookmark saving without navigating the active tab', async () => {
  const h = harness(); h.snap.pageUrl = 'https://example.com/'; h.pages.push(page(['A']));
  assert.equal((await start(h)).ok, true); await h.done();
  assert.equal(h.calls[0].url, url('A')); assert.equal(h.snap.pageUrl, 'https://example.com/');
});
test('tab-free resume continues its cursor and reuses cached connection settings', async () => {
  const h = harness(); h.snap.pageUrl = 'https://x.com/home'; h.pages.push(page(['A'], 'next'));
  await h.request({ type: 'SAVE_ALL_VISIBLE_IMAGES', tabId: 1, scrollSettings: { maxRounds: 1 } }); await h.done();
  h.pages.push(page(['B'])); assert.equal((await h.request({ type: 'RESUME_SAVE' })).ok, true); await h.done();
  h.pages.push(page(['C'])); assert.equal((await start(h)).ok, true); await h.done();
  assert.equal(h.createdTabs.length, 0); assert.equal(h.calls.length, 3);
  assert.ok(h.directRequests.some(call => call.url.includes('/graphql/') && JSON.parse(new URL(call.url).searchParams.get('variables')).cursor === 'next'));
  assert.equal(h.directRequests.filter(call => call.url.includes('/main.')).length, 1);
});
test('missing login stops without opening tabs or downloading', async () => {
  const h = harness(); h.snap.pageUrl = 'https://x.com/home'; h.auth = '';
  const result = await start(h); assert.equal(result.ok, false); assert.match(result.error, /ログイン/);
  assert.deepEqual(h.createdTabs, []); assert.equal(h.calls.length, 0);
});
test('unsupported X client settings report failure if the initialization tab cannot open', async () => {
  const h = harness(); h.snap.urls = [url('DOM_ONLY')];
  h.context.fetch = async () => ({ ok: true, url: 'https://x.com/i/bookmarks', text: async () => '<html>Unknown client</html>' });
  h.chrome.tabs.create = async () => { throw new Error('Initialization tab unavailable'); };
  const result = await start(h); assert.equal(result.ok, false); assert.match(result.error, /Initialization tab unavailable/);
  assert.equal(h.createdTabs.length, 0); assert.equal(h.calls.length, 0); assert.equal(h.injections.length, 0);
});
test('background preparation timeout reports failure when initialization tab is unavailable', async () => {
  const h = harness();
  h.context.setTimeout = (callback, ms) => { if (ms === 15000) queueMicrotask(callback); return 1; };
  h.context.clearTimeout = () => {};
  h.context.fetch = async (_, init) => new Promise((resolve, reject) => { init.signal.addEventListener('abort', () => reject(new Error('Aborted'))); });
  h.chrome.tabs.create = async () => { throw new Error('Initialization tab unavailable'); };
  const result = await start(h);
  assert.equal(result.ok, false); assert.match(result.error, /Initialization tab unavailable/);
  assert.equal(h.createdTabs.length, 0); assert.equal(h.calls.length, 0); assert.equal(h.store.imageSaveJob, undefined);
});
test('current-post saving does not create a background bookmark tab', async () => {
  const h = harness(); h.snap.pageUrl = 'https://x.com/home'; h.snap.urls = [url('CURRENT')];
  assert.equal((await h.request({ type: 'SAVE_CURRENT_TWEET_IMAGES', tabId: 1 })).ok, true); await h.done();
  assert.equal(h.createdTabs.length, 0); assert.equal(h.calls[0].url, url('CURRENT')); assert.equal(h.calls[0].saveAs, false);
});
test('bookmark page recognition accepts legacy, folders, history bookmarks and English tabs', () => {
  const h = harness();
  for (const [path, selected] of [['/i/bookmarks', ''], ['/i/bookmarks/123', 'folder'], ['/i/history', 'ブックマーク'], ['/i/history', 'Bookmarks']]) {
    const pageUrl = 'https://x.com' + path;
    assert.doesNotThrow(() => h.context.assertBookmarkScope(pageUrl, JSON.stringify([pageUrl, selected, 'account'])));
  }
});
test('tab-free resume works on likes but rejects an account change', async () => {
  const h = harness(); h.available = true; h.pages.push(page(['A'], 'next'));
  await h.request({ type: 'SAVE_ALL_VISIBLE_IMAGES', tabId: 1, scrollSettings: { maxRounds: 1 } }); await h.done();
  h.snap.scope = JSON.stringify([h.snap.pageUrl, 'いいね', 'account']); h.snap.urls = [url('OTHER')];
  h.pages.push(page(['B'])); assert.equal((await h.request({ type: 'RESUME_SAVE' })).ok, true); await h.done();
  h.auth = 'other-account'; const result = await h.request({ type: 'RESUME_SAVE' });
  assert.equal(result.ok, false); assert.match(result.error, /アカウント/); assert.equal(h.calls.length, 2);
});
test('worker restart pauses legacy batch jobs created outside bookmarks', async () => {
  const scope = JSON.stringify(['https://x.com/home', 'おすすめ', 'account']);
  const h = harness({ imageSaveJob: { id: 'bad', tabId: 1, url: 'https://x.com/home', scope, source: 'loaded', status: 'running', sourceDone: true, issues: [] }, 'imageSaveTask:bad:A': { media: { mediaId: 'A', format: 'jpg', origUrl: url('A') }, state: 'pending' } });
  const result = await h.done(); assert.equal(result.job.status, 'paused'); assert.equal(h.calls.length, 0);
});
test('network route saves every attachment and only skips the image actually saved', async () => {
  const h = harness(); h.snap.urls = [url('A')]; await start(h); await h.done();
  h.available = true;
  const data = page(['101']);
  data.data.bookmark_timeline_v2.timeline.instructions[0].entries[0].content.itemContent.tweet_results.result.legacy.extended_entities.media = ['A', 'B', 'C', 'D'].map(id => ({ type: 'photo', media_url_https: url(id) }));
  h.pages.push(data); await start(h); const result = await h.done();
  assert.equal(result.stats.skipped, 1); assert.equal(result.stats.success, 3); assert.equal(h.calls.length, 4);
});
test('extended tweet attachment arrays supply every photo; single-entity lists remain unverified', () => {
  const h = harness(); const data = page(['101']);
  const legacy = data.data.bookmark_timeline_v2.timeline.instructions[0].entries[0].content.itemContent.tweet_results.result.legacy;
  legacy.entities = { media: legacy.extended_entities.media.slice(0, 1) };
  legacy.extended_tweet = { extended_entities: { media: ['A', 'B', 'C', 'D'].map(id => ({ type: 'photo', media_url_https: url(id) })) } };
  delete legacy.extended_entities;
  assert.equal(h.context.parseBookmarkPage(data).media.length, 4);
  delete legacy.extended_tweet;
  const partial = h.context.parseBookmarkPage(data);
  assert.equal(partial.ended, false); assert.ok(partial.issues.some(issue => issue.includes('全画像')));
});
