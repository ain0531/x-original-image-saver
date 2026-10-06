const { test } = require('node:test');
const assert = require('node:assert/strict');
const { harness, page } = require('./harness.cjs');
const url = id => `https://pbs.twimg.com/media/${id}?format=jpg&name=orig`;
const current = h => h.request({ type: 'SAVE_CURRENT_TWEET_IMAGES', tabId: 1, saveAs: true });
const batch = h => h.request({ type: 'SAVE_ALL_VISIBLE_IMAGES', tabId: 1 });

test('save dialog cancellation finishes only that file and permits later bookmark saving', async () => {
  for (const message of ['USER_CANCELED', 'User canceled', 'User cancelled']) {
    const h = harness(); h.snap.urls = [url('A'), url('B')];
    const download = h.chrome.downloads.download;
    h.chrome.downloads.download = async options => {
      if (options.url === url('A')) { h.calls.push(options); throw new Error(message); }
      return download(options);
    };
    await current(h); const result = await h.done();
    assert.equal(result.stats.canceled, 1); assert.equal(result.stats.success, 1);
    assert.equal(result.stats.failed, 0); assert.equal(result.stats.pending, 0);
    assert.equal(result.job.status, 'done'); assert.equal(result.failures.length, 0);
    assert.equal(h.store['savedImage:A'], undefined);
    h.chrome.downloads.download = download; h.pages.push(page(['A', 'B']));
    assert.equal((await batch(h)).ok, true);
    const next = await h.done(); assert.equal(next.stats.success, 1); assert.equal(next.stats.skipped, 1);
  }
});

test('cancellation after a download ID is returned is terminal and never resumed', async () => {
  const h = harness(); h.snap.urls = [url('A')];
  const download = h.chrome.downloads.download;
  h.chrome.downloads.download = async options => {
    const id = await download(options);
    Object.assign(h.states.get(id), { state: 'interrupted', error: 'USER_CANCELED' });
    return id;
  };
  await current(h); const result = await h.done();
  assert.equal(result.stats.canceled, 1); assert.equal(result.stats.failed, 0);
  assert.equal(h.store['savedImage:A'], undefined);
  await h.request({ type: 'RESUME_SAVE' }); await h.done(); assert.equal(h.calls.length, 1);
  h.chrome.downloads.download = download;
  await current(h); const retried = await h.done();
  assert.equal(retried.stats.success, 1); assert.equal(h.calls.length, 2);
});

test('video save dialog cancellation does not leave unfinished video work', async () => {
  const h = harness(); h.snap.posts = ['101'];
  h.cached.push({ postId: '101', urls: [], complete: true, videos: [{ type: 'video', id_str: '123', video_info: { variants: [{ content_type: 'video/mp4', bitrate: 1000, url: 'https://video.twimg.com/ext_tw_video/123/pu/vid/640x360/test.mp4' }] } }] });
  h.chrome.downloads.download = async () => { throw new Error('USER_CANCELED'); };
  await current(h); const result = await h.done();
  assert.equal(result.stats.canceled, 1); assert.equal(result.stats.pending, 0);
  assert.equal(result.stats.failed, 0); assert.equal(h.store['savedVideo:123'], undefined);
  h.pages.push(page()); assert.equal((await batch(h)).ok, true); await h.done();
});

test('old individual cancellations are released on extension restart', async () => {
  for (const error of ['USER_CANCELED', 'User canceled', 'Error: USER_CANCELED']) {
    const h = harness({
      imageSaveJob: { id: 'old', tabId: 1, url: 'https://x.com/i/history', scope: 'old', documentId: 1, source: 'current', status: 'review', sourceDone: true, endedBy: 'current-post', issues: [], rounds: 0 },
      'imageSaveTask:old:A': { media: { mediaId: 'A', format: 'jpg', origUrl: url('A') }, state: 'failed', error },
    });
    const result = await h.done();
    assert.equal(result.stats.canceled, 1); assert.equal(result.job.status, 'done');
    assert.equal(h.store['imageSaveTask:old:A'].state, 'canceled');
    h.pages.push(page(['B'])); assert.equal((await batch(h)).ok, true); await h.done();
  }
});

test('individual network failures and shutdown remain retryable rather than canceled', async () => {
  for (const message of ['NETWORK_FAILED', 'USER_SHUTDOWN', 'Invalid filename', 'User canceled network request unexpectedly']) {
    const h = harness(); h.snap.urls = [url('A')];
    const download = h.chrome.downloads.download;
    h.chrome.downloads.download = async () => { throw new Error(message); };
    await current(h); const result = await h.done();
    assert.equal(result.stats.failed, 1); assert.equal(result.stats.canceled, 0);
    assert.equal((await batch(h)).ok, false);
    h.chrome.downloads.download = download;
    assert.equal((await h.request({ type: 'RESUME_SAVE' })).ok, true);
    assert.equal((await h.done()).stats.success, 1);
  }
});

test('batch cancellation retains its failed work for retry', async () => {
  const h = harness(); h.snap.urls = [url('A')];
  h.chrome.downloads.download = async () => { throw new Error('USER_CANCELED'); };
  await batch(h); const result = await h.done();
  assert.equal(result.stats.failed, 1); assert.equal(result.stats.canceled, 0);
});
