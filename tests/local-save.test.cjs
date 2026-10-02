const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { harness, flush } = require('./harness.cjs');
const sender = h => ({ id: 'test', frameId: 0, url: h.snap.pageUrl, tab: { id: 1, url: h.snap.pageUrl } });
const local = async (h, postId = '202') => {
  const result = await h.request({ type: 'LOCAL_SAVE_POST', postId, tabId: 99, saveAs: true }, sender(h));
  if (result.ok) h.ticket = { id: result.job.id, postId };
  return result;
};
async function done(h, ticket = h.ticket) {
  for (let n = 0; n < 500; n++) {
    const result = await h.request({ type: 'GET_LOCAL_SAVE_STATUS', postId: ticket.postId, jobId: ticket.id }, sender(h));
    if (!result.busy && result.job?.status !== 'running') return result;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('Local queue did not finish');
}

test('local save binds to sender tab and explicit post, uses normal folder and exposes only its job', async () => {
  const h = harness({ imageSaverOptions: { maxPages: 20, maxSeconds: 30, folder: 'ローカル', fileName: '{mediaId}.{format}' } });
  h.snap.posts = ['202']; h.snap.urls = ['https://pbs.twimg.com/media/PHOTO.jpg'];
  h.cached.push({ postId: '202', complete: true, urls: ['https://pbs.twimg.com/media/PHOTO.jpg'], videos: [{ type: 'video', id_str: '123', video_info: { variants: [{ content_type: 'video/mp4', bitrate: 1000, url: 'https://video.twimg.com/ext_tw_video/123/pu/vid/640x360/test.mp4' }] } }] });
  assert.equal((await local(h)).ok, true); const result = await done(h);
  assert.equal(result.stats.success, 2); assert.equal(result.job.postId, '202'); assert.equal(result.job.tabId, 1);
  assert.equal(result.job.saveAs, false); assert.ok(h.calls.every(call => call.saveAs === false && call.filename.startsWith('ローカル/')));
  assert.equal(h.injections[0].target.tabId, 1); assert.deepEqual(Array.from(h.injections[0].args), [true, '202']);
  const status = await h.request({ type: 'GET_LOCAL_SAVE_STATUS', postId: '202', jobId: result.job.id }, sender(h));
  assert.equal(status.stats.success, 2);
  const other = await h.request({ type: 'GET_LOCAL_SAVE_STATUS', postId: '101', jobId: result.job.id }, sender(h));
  assert.equal(other.unavailable, true); assert.equal(other.job, undefined);
  const replaced = await h.request({ type: 'GET_LOCAL_SAVE_STATUS', postId: '202', jobId: 'different' }, sender(h));
  assert.equal(replaced.unavailable, true);
  await local(h); assert.equal((await done(h)).stats.skipped, 2); assert.equal(h.calls.length, 2);
});

test('untrusted frames, non-X pages and malformed IDs cannot request local downloads', async () => {
  const h = harness(); h.snap.posts = ['202'];
  const base = sender(h);
  for (const untrusted of [{ ...base, id: 'foreign' }, { ...base, frameId: 1 }, { ...base, url: 'https://example.com/' }, { ...base, tab: undefined }]) {
    assert.equal((await h.request({ type: 'LOCAL_SAVE_POST', postId: '202' }, untrusted)).ok, false);
  }
  for (const postId of ['../202', '', 202]) assert.equal((await h.request({ type: 'LOCAL_SAVE_POST', postId }, base)).ok, false);
  assert.equal(h.injections.length, 0); assert.equal(h.calls.length, 0);
});

test('missing clicked post never falls back to another timeline post', async () => {
  const h = harness(); h.snap.posts = ['101']; h.snap.urls = ['https://pbs.twimg.com/media/OTHER.jpg'];
  const result = await local(h); assert.equal(result.ok, false); assert.match(result.error, /指定した投稿/);
  assert.equal(h.calls.length, 0);
});

test('failed local work stays recorded but does not block another post or a retry', async () => {
  const h = harness(); h.snap.posts = ['202']; h.snap.urls = ['https://pbs.twimg.com/media/A.jpg'];
  const download = h.chrome.downloads.download;
  h.chrome.downloads.download = async () => { throw new Error('NETWORK_FAILED'); };
  await local(h); const first = h.ticket; assert.equal((await done(h)).stats.failed, 1);
  h.snap.posts = ['303']; h.snap.urls = ['https://pbs.twimg.com/media/B.jpg'];
  h.chrome.downloads.download = download;
  const other = await local(h, '303'); assert.equal(other.ok, true);
  assert.equal((await done(h)).stats.success, 1);
  assert.equal((await done(h, first)).stats.failed, 1);
  h.snap.posts = ['202']; h.snap.urls = ['https://pbs.twimg.com/media/A.jpg']; h.chrome.downloads.download = download;
  assert.equal((await local(h)).ok, true);
  assert.equal((await done(h)).stats.success, 1);
  assert.ok(h.injections.filter(call => call.world !== 'MAIN').every(call => call.args[1] === '202' || call.args[1] === '303'));
  assert.equal(h.calls.length, 2);
});

test('actual DOM selection uses clicked ID even when a different post is first visible', async () => {
  const h = harness();
  const article = (id, media) => {
    const item = { querySelector: () => null, getBoundingClientRect: () => ({ top: 0, bottom: 300 }) };
    const link = { href: `https://x.com/user/status/${id}`, querySelector: () => ({}), closest: () => item };
    item.querySelectorAll = selector => selector === 'a[href]' ? [link] : selector === 'img' ? [{ currentSrc: `https://pbs.twimg.com/media/${media}.jpg` }] : [];
    return item;
  };
  const first = article('101', 'WRONG'), clicked = article('202', 'RIGHT');
  const root = { querySelector: () => null, querySelectorAll: () => [first, clicked] };
  h.context.document = { querySelector: selector => selector.includes('AccountSwitcher') ? null : root, documentElement: { scrollHeight: 1000 } };
  h.context.location = { href: 'https://x.com/home', pathname: '/home' }; h.context.performance = { timeOrigin: 1 };
  h.context.window = { scrollY: 0, innerHeight: 900, scrollBy: () => { throw new Error('No scrolling'); } };
  h.chrome.scripting.executeScript = async options => options.world === 'MAIN' ? [{ result: { posts: [{ postId: '202', complete: true, urls: ['https://pbs.twimg.com/media/RIGHT.jpg'] }] } }] : [{ result: await options.func(...options.args) }];
  const snap = await h.context.snapshot(1, true, '202');
  assert.deepEqual(Array.from(snap.posts), ['202']); assert.ok(snap.urls.every(url => url.includes('RIGHT')));
});

test('verified attachment lists ignore unrelated timeline loading and clear old list warnings', async () => {
  const h = harness(); h.snap.posts = ['202']; h.snap.loading = true;
  h.snap.issues = ['投稿 202: 動画の全データを確認できません。'];
  h.cached.push({ postId: '202', complete: true, urls: ['https://pbs.twimg.com/media/A.jpg', 'https://pbs.twimg.com/media/B.jpg'] });
  await local(h); const result = await done(h);
  assert.equal(result.job.status, 'done'); assert.equal(result.stats.success, 2); assert.equal(result.job.issues.length, 0);
});

test('missing full metadata reports the real cause rather than a lazy-image timeout', async () => {
  const h = harness(); h.snap.posts = ['202']; h.snap.urls = ['https://pbs.twimg.com/media/A.jpg'];
  await local(h); const result = await done(h);
  assert.equal(result.job.status, 'review');
  assert.ok(!result.job.endedBy.includes('読み込み途中')); assert.equal(result.stats.success, 1);
  assert.ok(result.job.issues.some(issue => issue.includes('通信情報と投稿の表示データ')));
});

test('already open page recovers missing MAIN reader and saves all four attachments from rendered props', async () => {
  const h = harness(); h.snap.pageUrl = 'https://x.com/home';
  const article = { parentElement: null, querySelector: () => null, getBoundingClientRect: () => ({ top: 0, bottom: 300 }) };
  const link = { href: 'https://x.com/user/status/202', querySelector: () => ({}), closest: () => article };
  article.querySelectorAll = selector => selector === 'a[href]' ? [link] : selector === 'img' ? [{ currentSrc: 'https://pbs.twimg.com/media/A.jpg' }] : [];
  article.__reactFiber$test = { memoizedProps: { tweet: { rest_id: '202', legacy: { full_text: 'post', extended_entities: { media: ['A', 'B', 'C', 'D'].map(id => ({ type: 'photo', media_url_https: `https://pbs.twimg.com/media/${id}.jpg` })) } } } }, return: null };
  const root = { querySelector: () => null, querySelectorAll: () => [article] };
  h.context.document = { querySelector: selector => selector.includes('AccountSwitcher') ? { textContent: 'user' } : root, documentElement: { scrollHeight: 1000 } };
  h.context.location = { href: h.snap.pageUrl, origin: 'https://x.com', pathname: '/home' };
  h.context.performance = { timeOrigin: 1 }; h.context.Headers = Headers; h.context.Request = Request;
  class XHR { open() {} setRequestHeader() {} send() {} }
  h.context.XMLHttpRequest = XHR;
  h.context.window = { scrollY: 0, innerHeight: 900, fetch: async () => { throw new Error('Network is unnecessary'); } };
  let installs = 0;
  h.chrome.scripting.executeScript = async options => {
    if (options.files) { installs++; vm.runInContext(fs.readFileSync(options.files[0], 'utf8'), h.context); return []; }
    return [{ result: await options.func(...options.args) }];
  };
  assert.equal((await local(h)).ok, true); const result = await done(h);
  assert.equal(installs, 1); assert.equal(result.stats.success, 4); assert.equal(result.job.status, 'done');
  assert.equal(result.job.issues.length, 0); assert.equal(h.directRequests.length, 0);
});

test('instructions are accepted during a transfer, then execute serially from captured media', async () => {
  const h = harness(); h.snap.posts = ['202']; h.snap.urls = ['https://pbs.twimg.com/media/A.jpg'];
  h.cached.push({ postId: '202', complete: true, urls: h.snap.urls });
  let release; const gate = new Promise(resolve => { release = resolve; });
  const download = h.chrome.downloads.download; const starts = [];
  h.chrome.downloads.download = async options => { starts.push(options.url); if (starts.length === 1) await gate; return download(options); };
  await local(h); const first = h.ticket;
  for (let n = 0; n < 30 && !starts.length; n++) await flush();
  assert.equal(starts.length, 1);
  h.snap.posts = ['303']; h.snap.urls = ['https://pbs.twimg.com/media/B.jpg'];
  h.cached.push({ postId: '303', complete: true, urls: h.snap.urls });
  const second = await local(h, '303'); const ticket = h.ticket;
  assert.equal(second.ok, true); assert.equal(second.queued, true);
  assert.equal(starts.length, 1);
  assert.equal(Object.values(h.store).filter(row => row?.state === 'queued' && row?.postId === '303').length, 1);
  h.snap.posts = ['404']; h.snap.urls = ['https://pbs.twimg.com/media/WRONG.jpg'];
  h.chrome.tabs.get = async () => { throw new Error('Tab closed'); };
  release();
  assert.equal((await done(h, first)).stats.success, 1);
  assert.equal((await done(h, ticket)).stats.success, 1);
  assert.deepEqual(starts.map(url => new URL(url).pathname), ['/media/A', '/media/B']);
});

test('restart recovers the current download ID and queued posts without the original tab', async () => {
  const h = harness({ specifySaveLocation: true }); h.snap.posts = ['202']; h.snap.urls = ['https://pbs.twimg.com/media/A.jpg'];
  h.cached.push({ postId: '202', complete: true, urls: h.snap.urls });
  const download = h.chrome.downloads.download;
  h.chrome.downloads.download = async options => { const id = await download(options); h.states.get(id).state = 'in_progress'; return id; };
  await local(h); const first = h.ticket;
  for (let n = 0; n < 40 && !Object.keys(h.store).some(key => key.startsWith('localSaveTask:') && h.store[key].downloadId); n++) await flush();
  h.snap.posts = ['303']; h.snap.urls = ['https://pbs.twimg.com/media/B.jpg'];
  h.cached.push({ postId: '303', complete: true, urls: h.snap.urls });
  await local(h, '303'); const second = h.ticket;
  const restored = harness(Object.fromEntries(Object.entries(h.store).reverse()));
  const item = structuredClone(h.states.get(1)); item.state = 'complete';
  restored.chrome.downloads.search = async query => query.id === 1 ? [item] : [...restored.states.values()].filter(row => query.id === row.id);
  restored.chrome.downloads.download = async options => {
    restored.calls.push(options); restored.states.set(2, { id: 2, state: 'complete', exists: true, mime: 'image/jpeg', url: options.url, finalUrl: options.url }); return 2;
  };
  restored.chrome.tabs.get = async () => { throw new Error('Tab closed'); };
  const firstResult = await done(restored, first);
  assert.equal(firstResult.stats.success, 1); assert.equal(firstResult.job.saveAs, true);
  assert.equal((await done(restored, second)).stats.success, 1);
  assert.equal(restored.calls.length, 1); assert.match(restored.calls[0].url, /\/B\?/);
  assert.equal(restored.calls[0].saveAs, true);
  assert.equal(restored.injections.length, 0);
  // Let the simulated old worker exit too.
  h.states.get(1).state = 'complete'; h.chrome.downloads.download = download;
  await done(h, second);
});

test('local queue uses the shared save-location setting captured at reservation, ignoring later changes', async () => {
  const h = harness({ specifySaveLocation: true });
  h.snap.posts = ['202']; h.snap.urls = ['https://pbs.twimg.com/media/A.jpg'];
  h.cached.push({ postId: '202', complete: true, urls: h.snap.urls });
  let release; const gate = new Promise(resolve => { release = resolve; });
  const download = h.chrome.downloads.download; let started = false;
  h.chrome.downloads.download = async options => { if (!started) { started = true; await gate; } return download(options); };
  await local(h); const first = h.ticket;
  for (let n = 0; n < 30 && !started; n++) await flush();
  await h.chrome.storage.local.set({ specifySaveLocation: false });
  h.snap.posts = ['303']; h.snap.urls = ['https://pbs.twimg.com/media/B.jpg'];
  h.cached.push({ postId: '303', complete: true, urls: h.snap.urls });
  assert.equal((await local(h, '303')).ok, true); const second = h.ticket;
  assert.equal(h.store['localSaveRequest:' + first.id].saveAs, true);
  assert.equal(h.store['localSaveRequest:' + second.id].saveAs, false);
  await h.chrome.storage.local.set({ specifySaveLocation: true });
  release();
  assert.equal((await done(h, first)).stats.success, 1);
  assert.equal((await done(h, second)).stats.success, 1);
  assert.deepEqual(h.calls.map(call => call.saveAs), [true, false]);
});

test('canceling local Save As does not block the next reservation or record the canceled file', async () => {
  const h = harness({ specifySaveLocation: true });
  h.snap.posts = ['202']; h.snap.urls = ['https://pbs.twimg.com/media/A.jpg'];
  h.cached.push({ postId: '202', complete: true, urls: h.snap.urls });
  const download = h.chrome.downloads.download;
  h.chrome.downloads.download = async options => { if (options.saveAs) throw new Error('USER_CANCELED'); return download(options); };
  await local(h); const first = await done(h);
  assert.equal(first.stats.canceled, 1); assert.equal(first.stats.pending, 0); assert.equal(h.store['savedImage:A'], undefined);
  await h.chrome.storage.local.set({ specifySaveLocation: false });
  await local(h); assert.equal((await done(h)).stats.success, 1);
});

test('batch and queued local save sharing a media ID wait for the first transfer then skip', async () => {
  const h = harness(); h.snap.posts = ['202']; h.snap.urls = ['https://pbs.twimg.com/media/A.jpg'];
  h.cached.push({ postId: '202', complete: true, urls: h.snap.urls });
  let release; const gate = new Promise(resolve => { release = resolve; });
  const download = h.chrome.downloads.download; let count = 0;
  h.chrome.downloads.download = async options => { count++; await gate; return download(options); };
  await h.request({ type: 'SAVE_ALL_VISIBLE_IMAGES', tabId: 1 });
  for (let n = 0; n < 100 && !count; n++) await new Promise(resolve => setTimeout(resolve, 5));
  if (!count) release();
  assert.equal(count, 1);
  assert.equal((await local(h)).ok, true);
  await flush(); release();
  assert.equal((await done(h)).stats.skipped, 1);
  await h.done(); assert.equal(count, 1);
});

function nativeLike(h, { fail = false } = {}) {
  let clicks = 0; let liked = false;
  const article = { isConnected: true };
  const link = { href: 'https://x.com/user/status/202', closest: () => article, querySelector: () => ({}) };
  const button = { disabled: false, closest: () => article, getAttribute: () => null, click: () => { clicks++; if (!fail) liked = true; } };
  article.querySelectorAll = selector => selector === 'a[href]' ? [link] : selector.includes('"unlike"') ? (liked ? [button] : []) : selector.includes('"like"') ? (liked ? [] : [button]) : [];
  h.context.document = { querySelector: () => ({ querySelectorAll: () => [article] }) };
  h.context.location = { href: h.snap.pageUrl };
  const inject = h.chrome.scripting.executeScript;
  h.chrome.scripting.executeScript = async options => options.func?.toString().includes('const matches') ? [{ result: await options.func(...options.args) }] : inject(options);
  return { get clicks() { return clicks; }, get liked() { return liked; } };
}

test('like on save defaults off for local and sidebar saves', async () => {
  const h = harness(); h.snap.posts = ['202']; h.snap.urls = ['https://pbs.twimg.com/media/A.jpg'];
  h.cached.push({ postId: '202', complete: true, urls: h.snap.urls });
  const likes = nativeLike(h);
  await local(h); await done(h);
  await h.request({ type: 'SAVE_CURRENT_TWEET_IMAGES', tabId: 1 }); await h.done();
  assert.equal(likes.clicks, 0);
});

test('shared enabled setting likes from both save paths and repeated saves never unlike', async () => {
  const h = harness({ likeOnSave: true }); h.snap.posts = ['202']; h.snap.urls = ['https://pbs.twimg.com/media/A.jpg'];
  h.cached.push({ postId: '202', complete: true, urls: h.snap.urls });
  const likes = nativeLike(h);
  await local(h); await done(h);
  await local(h); await done(h);
  await h.request({ type: 'SAVE_CURRENT_TWEET_IMAGES', tabId: 1 }); await h.done();
  assert.equal(likes.clicks, 1); assert.equal(likes.liked, true); assert.equal(h.calls.length, 1);
});

test('a failed like is reported without dropping the accepted media save', async () => {
  const h = harness({ likeOnSave: true }); h.snap.posts = ['202']; h.snap.urls = ['https://pbs.twimg.com/media/A.jpg'];
  h.cached.push({ postId: '202', complete: true, urls: h.snap.urls });
  h.chrome.scripting.executeScript = ((inject) => async options => options.func?.toString().includes('const matches') ? [{ result: { error: 'いいねの反映を確認できません。' } }] : inject(options))(h.chrome.scripting.executeScript);
  await local(h); const result = await done(h);
  assert.equal(result.stats.success, 1); assert.equal(result.job.status, 'review');
  assert.ok(result.job.issues.some(issue => issue.startsWith('いいね:')));
});
