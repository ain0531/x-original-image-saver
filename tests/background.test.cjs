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
test('loaded images save without any scrolling and report the limited range', async () => {
  const h = harness(); h.snap.urls = [url()];
  assert.equal((await start(h)).ok, true);
  const result = await h.done();
  assert.equal(result.stats.success, 1);
  assert.equal(result.job.source, 'loaded');
  assert.equal(result.job.endedBy, 'loaded-only');
  assert.equal(result.job.status, 'review');
  assert.ok(h.injections.every(call => call.world === 'MAIN' || call.args.length === 1));
  assert.equal(h.calls[0].url, url());
  assert.equal(h.calls[0].saveAs, false);
});
test('network pagination saves unseen original images without DOM scroll', async () => {
  const h = harness(); h.available = true; h.pages.push(page(['A', 'B'], 'next'), page(['C']));
  await start(h); const result = await h.done();
  assert.equal(result.job.source, 'network'); assert.equal(result.job.endedBy, 'timeline-end');
  assert.equal(result.stats.success, 3);
  assert.ok(h.calls.every(call => call.url.endsWith('name=orig')));
  assert.deepEqual(h.injections.filter(call => call.world === 'MAIN').map(call => call.args[1]), [null, null, 'next']);
  assert.ok(h.injections.every(call => call.world === 'MAIN' || call.args.length === 1));
});
test('format variants are one image and verified existing originals are skipped', async () => {
  const h = harness(); h.snap.urls = [url('A'), url('A', 'png')];
  await start(h); await h.done(); assert.equal(h.calls.length, 1);
  await start(h); const result = await h.done(); assert.equal(h.calls.length, 1); assert.equal(result.stats.skipped, 1);
});
test('unknown history and deleted files are saved fail safe', async () => {
  const h = harness({ savedMediaMap: { 'A|jpg': Date.now() } }); h.snap.urls = [url('A')];
  await start(h); await h.done(); assert.equal(h.calls.length, 1);
  h.states.get(1).exists = false;
  await start(h); await h.done(); assert.equal(h.calls.length, 2);
});
test('old history migrates real timestamps; large downloads cannot confirm originals', async () => {
  const stamp = Date.now() - 1000;
  const h = harness({ savedMediaMap: { 'A|jpg': stamp, 'A|png': stamp - 1000 } }); h.snap.urls = [url('A')];
  h.states.set(99, { id: 99, url: url('A').replace('orig', 'large'), finalUrl: url('A').replace('orig', 'large'), state: 'complete', exists: true, mime: 'image/jpeg' });
  await start(h); await h.done(); assert.equal(h.calls.length, 1); assert.equal(h.store.savedMediaMap, undefined);
});
test('180 day expiration stays unchanged', async () => {
  const h = harness({ imageHistoryMigratedV2: true, 'savedImage:A': { savedAt: Date.now() - 181 * 86400000, quality: 'orig', downloadId: 99 } });
  h.states.set(99, { id: 99, url: url('A'), finalUrl: url('A'), exists: true, state: 'complete', mime: 'image/jpeg' }); h.snap.urls = [url('A')];
  await start(h); await h.done(); assert.equal(h.calls.length, 1);
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
  await start(h);
  h.snap.urls = [url('LATE')]; h.snap.issues = []; h.snap.loading = false;
  const result = await h.done();
  assert.equal(result.stats.success, 1);
  assert.ok(!result.job.issues.some(issue => issue.includes('読み込まれていない画像')));
  assert.ok(h.injections.every(call => call.world === 'MAIN' || call.args.length === 1));
});
test('actual injected DOM reader uses currentSrc and restricts collection to primary post articles', async () => {
  const h = harness();
  const article = { querySelectorAll: selector => selector === 'img' ? [{ currentSrc: url('REAL'), getAttribute: () => url('STALE') }] : [], querySelector: () => null };
  const root = { querySelector: () => null, querySelectorAll: () => [article] };
  h.context.document = { querySelector: selector => selector.includes('AccountSwitcher') ? null : root };
  h.context.location = { href: h.snap.pageUrl, pathname: '/i/history' };
  h.context.performance = { timeOrigin: 1 };
  h.context.window = { scrollY: 123, innerHeight: 900, scrollBy: () => { throw new Error('scroll is forbidden'); } };
  h.context.document.documentElement = { scrollHeight: 5000 };
  h.chrome.scripting.executeScript = async options => [{ result: await options.func(...options.args) }];
  await start(h); const result = await h.done();
  assert.equal(result.stats.success, 1); assert.equal(h.calls[0].url, url('REAL'));
  assert.equal(h.context.window.scrollY, 123);
});

test('loaded route enriches a one-image DOM with all four native photo URLs', async () => {
  const h = harness(); h.snap.posts = ['101']; h.snap.urls = [url('A')];
  h.cached.push({ postId: '101', urls: [url('A'), url('B'), url('C'), url('D')], complete: true });
  await start(h); const result = await h.done();
  assert.equal(result.stats.success, 4); assert.equal(result.job.source, 'loaded');
  assert.ok(!result.job.issues.some(issue => issue.includes('全画像')));
  assert.equal(new Set(h.calls.map(call => call.url)).size, 4);
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
