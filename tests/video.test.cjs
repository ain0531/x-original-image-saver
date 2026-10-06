const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { harness, page } = require('./harness.cjs');
const mp4 = (id, size = '1280x720', name = 'clip') => `https://video.twimg.com/ext_tw_video/${id}/pu/vid/avc1/${size}/${name}.mp4?tag=12`;
const variant = (id, bitrate = 2176000, size = '1280x720') => ({ content_type: 'video/mp4', bitrate, url: mp4(id, size) });
const video = (id, variants = [variant(id)], type = 'video') => ({ type, id_str: id, media_key: '13_' + id, media_url_https: 'https://pbs.twimg.com/ext_tw_video_thumb/' + id + '/poster.jpg', video_info: { variants } });
function data(items) { const response = page(['101']); response.data.bookmark_timeline_v2.timeline.instructions[0].entries[0].content.itemContent.tweet_results.result.legacy.extended_entities.media = items; return response; }
const start = h => h.request({ type: 'SAVE_ALL_VISIBLE_IMAGES', tabId: 1 });
test('video selects highest MP4 bitrate, preserving the URL and ignoring HLS and thumbnails', () => {
  const h = harness();
  const response = data([video('123', [variant('123', 832000, '640x360'), { content_type: 'application/x-mpegURL', url: 'https://video.twimg.com/clip.m3u8', bitrate: 99999999 }, variant('123')])]);
  const result = h.context.parseBookmarkPage(response);
  assert.equal(result.media.length, 1); assert.equal(result.media[0].kind, 'video'); assert.equal(result.media[0].mediaId, '123');
  assert.equal(result.media[0].origUrl, mp4('123')); assert.equal(result.media[0].bitrate, 2176000); assert.equal(result.media[0].format, 'mp4'); assert.equal(result.issues.length, 0);
});
test('multiple videos and animated GIF MP4s download with normal options and skip on repeat', async () => {
  const h = harness({ imageSaverOptions: { maxPages: 20, maxSeconds: 30, folder: 'X動画', fileName: '{mediaId}_saved.{format}' } });
  const gif = video('222', [{ content_type: 'video/mp4', url: 'https://video.twimg.com/tweet_video/gif.mp4' }], 'animated_gif');
  h.pages.push(data([video('111'), gif, video('333')]));
  assert.equal((await start(h)).ok, true); const result = await h.done();
  assert.equal(result.stats.success, 3); assert.equal(h.createdTabs.length, 0);
  assert.deepEqual(h.calls.map(call => call.filename).sort(), ['X動画/111_saved.mp4', 'X動画/222_saved.mp4', 'X動画/333_saved.mp4']);
  assert.ok(h.calls.every(call => call.saveAs === false));
  assert.equal(h.store['savedVideo:111'].quality, 'best-mp4'); assert.equal(h.store['savedVideo:111'].bitrate, 2176000);
  h.states.clear(); h.pages.push(data([video('111'), gif, video('333')])); await start(h); const repeated = await h.done();
  assert.equal(repeated.stats.skipped, 3); assert.equal(h.calls.length, 3);
});
test('photo and video IDs have separate queue and history identities', async () => {
  const h = harness(); h.pages.push(data([{ type: 'photo', media_url_https: 'https://pbs.twimg.com/media/123.jpg' }, video('123')]));
  await start(h); const result = await h.done(); assert.equal(result.stats.success, 2);
  assert.equal(h.store['savedImage:123'].quality, 'orig'); assert.equal(h.store['savedVideo:123'].quality, 'best-mp4');
});
test('HLS-only, missing IDs and unknown multi-variant bitrates remain unresolved', async () => {
  const h = harness();
  const hls = video('123', [{ content_type: 'application/x-mpegURL', url: 'https://video.twimg.com/stream.m3u8' }]);
  const missing = video('456'); delete missing.id_str; delete missing.media_key;
  const unknown = video('789', [variant('789'), { content_type: 'video/mp4', url: mp4('789', '640x360') }]);
  h.pages.push(data([hls, missing, unknown])); await start(h); const result = await h.done();
  assert.equal(h.calls.length, 0); assert.equal(result.job.status, 'paused');
  assert.ok(result.job.issues.some(issue => issue.includes('HLS'))); assert.ok(result.job.issues.some(issue => issue.includes('メディアID'))); assert.ok(result.job.issues.some(issue => issue.includes('ビットレート')));
});
test('foreign URLs, non-MP4 and insecure video URLs cannot be selected', () => {
  const h = harness();
  for (const raw of ['https://evil.example/clip.mp4', 'http://video.twimg.com/tweet_video/clip.mp4', 'https://video.twimg.com/tweet_video/clip.m3u8', 'https://video.twimg.com.evil.example/tweet_video/clip.mp4']) {
    const result = h.context.tweetMedia(video('123', [{ content_type: 'video/mp4', bitrate: 1, url: raw }]));
    assert.equal(result.media, undefined); assert.ok(result.issue);
  }
});
test('media_key supplies a stable ID and equal bitrates prefer the larger frame', () => {
  const h = harness(); const item = video('123', [variant('123', 1000, '640x360'), variant('123', 1000, '1280x720')]); delete item.id_str;
  const result = h.context.tweetMedia(item); assert.equal(result.media.mediaId, '123'); assert.equal(result.media.origUrl, mp4('123'));
});
test('HTML, thumbnail redirects and lower-quality video redirects never mark completion', async () => {
  for (const mode of ['mime', 'thumbnail', 'lower']) {
    const h = harness(); h.pages.push(data([video('123')])); const download = h.chrome.downloads.download;
    h.chrome.downloads.download = async options => { const id = await download(options); const item = h.states.get(id); if (mode === 'mime') item.mime = 'text/html'; else item.finalUrl = mode === 'thumbnail' ? 'https://pbs.twimg.com/media/POSTER?format=jpg&name=orig' : mp4('123', '640x360'); return id; };
    await start(h); const result = await h.done(); assert.equal(result.stats.failed, 1); assert.equal(h.store['savedVideo:123'], undefined);
  }
});
test('failed highest-quality MP4 does not retry a smaller rendition, and resume retries the same URL', async () => {
  const h = harness(); h.pages.push(data([video('123', [variant('123', 1, '640x360'), variant('123')])]));
  const download = h.chrome.downloads.download;
  h.chrome.downloads.download = async options => { h.calls.push(options); throw new Error('NETWORK_FAILED'); };
  await start(h); const failed = await h.done(); assert.equal(failed.stats.failed, 1); assert.equal(h.calls[0].url, mp4('123'));
  h.chrome.downloads.download = download; await h.request({ type: 'RESUME_SAVE' }); const resumed = await h.done();
  assert.equal(resumed.stats.success, 1); assert.ok(h.calls.every(call => call.url === mp4('123')));
});
test('current-post save receives video metadata and uses the same highest-quality selection', async () => {
  const h = harness(); h.snap.posts = ['101']; h.cached.push({ postId: '101', urls: [], videos: [video('123')], complete: true });
  assert.equal((await h.request({ type: 'SAVE_CURRENT_TWEET_IMAGES', tabId: 1 })).ok, true); const result = await h.done();
  assert.equal(result.stats.success, 1); assert.equal(h.calls[0].url, mp4('123')); assert.equal(h.calls[0].saveAs, false);
});
test('unknown-quality video history saves fail safe while completed video records never expire', async () => {
  const h = harness({ imageHistoryDownloadIndexV1: true, 'savedVideo:123': { savedAt: Date.now(), quality: 'unknown' }, 'savedVideo:456': { savedAt: Date.now() - 500 * 86400000, quality: 'best-mp4', bitrate: 2176000 } });
  h.pages.push(data([video('123'), video('456')])); await start(h); const result = await h.done();
  assert.equal(result.stats.skipped, 1); assert.equal(result.stats.success, 1); assert.equal(h.calls[0].url, mp4('123'));
});
test('history clear removes both photos and videos without deleting files', async () => {
  const h = harness({ imageHistoryDownloadIndexV1: true, 'savedImage:123': { quality: 'orig', savedAt: Date.now() }, 'savedVideo:123': { quality: 'best-mp4', savedAt: Date.now() } });
  const result = await h.request({ type: 'CLEAR_SAVED_HISTORY' }); assert.equal(result.removed, 2); assert.equal(h.store['savedVideo:123'], undefined); assert.equal(h.store['savedImage:123'], undefined);
});
test('release version agrees across manifest and npm metadata and permits the video CDN', () => {
  const manifest = JSON.parse(fs.readFileSync('manifest.json', 'utf8')); const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8')); const lock = JSON.parse(fs.readFileSync('package-lock.json', 'utf8'));
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/); assert.equal(pkg.version, manifest.version); assert.equal(lock.version, manifest.version); assert.equal(lock.packages[''].version, manifest.version);
  assert.ok(manifest.host_permissions.includes('https://video.twimg.com/*'));
});
