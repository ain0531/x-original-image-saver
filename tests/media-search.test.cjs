const { test } = require('node:test');
const assert = require('node:assert/strict');
const { harness } = require('./harness.cjs');
// posts: [[postId, [mediaIds]]]; the media IDs differ from the post IDs on purpose.
function bookmarks(posts, cursor) {
  const entries = posts.map(([id, media]) => ({ entryId: 'tweet-' + id, content: { itemContent: { tweet_results: { result: { rest_id: id, legacy: { extended_entities: { media: media.map(m => ({ type: 'photo', media_url_https: 'https://pbs.twimg.com/media/' + m + '.jpg' })) } } } } } } }));
  if (cursor) entries.push({ entryId: 'cursor-bottom', content: { cursorType: 'Bottom', value: cursor } });
  return { data: { bookmark_timeline_v2: { timeline: { instructions: [{ type: 'TimelineAddEntries', entries }] } } } };
}
function withWindows(h) {
  const opened = [];
  h.chrome.windows = { create: async options => { opened.push(options); return { id: 9 }; } };
  return opened;
}
async function finished(h) {
  for (let n = 0; n < 400; n++) {
    const status = await h.request({ type: 'GET_MEDIA_SEARCH_STATUS' });
    if (!status.busy && status.job?.status !== 'running') return status;
    await new Promise(r => setTimeout(r, 10));
  }
  throw new Error('Search did not finish');
}
const search = (h, query) => h.request({ type: 'START_MEDIA_SEARCH', tabId: 1, query });

test('media IDs are read from IDs, saved file names and media URLs', () => {
  const h = harness();
  for (const raw of ['GxAbCdEf123', ' GxAbCdEf123_orig.jpg ', 'C:\\Pictures\\X\\GxAbCdEf123_orig.png', 'https://pbs.twimg.com/media/GxAbCdEf123?format=jpg&name=orig', 'https://pbs.twimg.com/media/GxAbCdEf123.jpg:orig'])
    assert.equal(h.context.mediaIdFrom(raw), 'GxAbCdEf123', raw);
  assert.equal(h.context.mediaIdFrom('https://video.twimg.com/ext_tw_video/1790000000000000000/pu/vid/1280x720/a.mp4'), '1790000000000000000');
  for (const raw of ['', 'abc', 'not an id!', 42]) assert.equal(h.context.mediaIdFrom(raw), undefined);
});

test('parsed bookmark media keep the post that carries them, including quotes', () => {
  const h = harness();
  const data = bookmarks([['100', ['IMG_A']]]);
  data.data.bookmark_timeline_v2.timeline.instructions[0].entries[0].content.itemContent.tweet_results.result.quoted_status_result = { result: { rest_id: '200', legacy: { extended_entities: { media: [{ type: 'photo', media_url_https: 'https://pbs.twimg.com/media/IMG_Q.jpg' }] } } } };
  const media = h.context.parseBookmarkPage(data).media;
  assert.equal(JSON.stringify(media.map(m => [m.mediaId, m.postId])), JSON.stringify([['IMG_A', '100'], ['IMG_Q', '200']]));
});

test('a bookmark save records the post ID with each saved file', async () => {
  const h = harness(); h.pages.push(bookmarks([['300', ['SAVED_1', 'SAVED_2']]]));
  assert.equal((await h.request({ type: 'SAVE_ALL_VISIBLE_IMAGES', tabId: 1 })).ok, true); await h.done();
  assert.equal(h.store['savedImage:SAVED_1'].postId, '300');
  assert.equal(h.store['savedImage:SAVED_2'].postId, '300');
});

test('an older record without a post gains it when the file is skipped again', async () => {
  const h = harness({ 'savedImage:OLD_1': { savedAt: Date.now() - 1000, quality: 'orig', downloadId: 0 } });
  h.pages.push(bookmarks([['400', ['OLD_1']]]));
  assert.equal((await h.request({ type: 'SAVE_ALL_VISIBLE_IMAGES', tabId: 1 })).ok, true);
  const status = await h.done();
  assert.equal(status.stats.skipped, 1);
  assert.equal(h.store['savedImage:OLD_1'].postId, '400');
  assert.equal(h.store['savedImage:OLD_1'].quality, 'orig');
});

test('a recorded post opens at once without reading bookmarks', async () => {
  const h = harness({ 'savedImage:HIST_1': { savedAt: Date.now() - 1000, quality: 'orig', postId: '500' } });
  const opened = withWindows(h);
  const result = await search(h, 'HIST_1_orig.jpg');
  assert.equal(result.ok, true); assert.equal(result.job.status, 'found'); assert.equal(result.job.via, 'history');
  assert.equal(h.directRequests.length, 0);
  assert.deepEqual(opened.map(o => [o.url, o.type]), [['https://x.com/i/status/500', 'popup']]);
});

test('bookmarks are read page by page until the image is found, then the post opens', async () => {
  const h = harness(); const opened = withWindows(h);
  h.pages.push(bookmarks([['601', ['X1']], ['602', ['X2']]], 'c1'), bookmarks([['603', ['X3']], ['604', ['TARGET', 'X4']]], 'c2'), bookmarks([['605', ['X5']]]));
  const started = await search(h, 'TARGET');
  assert.equal(started.ok, true); assert.equal(started.job.status, 'running');
  const status = await finished(h);
  assert.equal(status.job.status, 'found'); assert.equal(status.job.postId, '604'); assert.equal(status.job.via, 'bookmarks');
  assert.equal(status.job.pages, 2); assert.equal(status.job.posts, 4);
  assert.equal(h.pages.length, 1, 'stops reading after the hit');
  assert.deepEqual(opened.map(o => o.url), ['https://x.com/i/status/604']);
  const reopened = await h.request({ type: 'OPEN_MEDIA_SEARCH_RESULT' });
  assert.equal(reopened.ok, true); assert.equal(opened.length, 2);
});

test('the search reports not found at the end of bookmarks', async () => {
  const h = harness(); const opened = withWindows(h);
  h.pages.push(bookmarks([['701', ['Y1']]], 'c1'), bookmarks([['702', ['Y2']]]));
  await search(h, 'MISSING');
  const status = await finished(h);
  assert.equal(status.job.status, 'not-found'); assert.equal(status.job.posts, 2); assert.equal(opened.length, 0);
});

test('a rate limit pauses the search and the next search continues from the cursor', async () => {
  const h = harness(); const opened = withWindows(h);
  h.pages.push(bookmarks([['801', ['Z1']]], 'c1'));
  const fetchPage = h.context.fetch;
  let limited = true;
  h.context.fetch = async (raw, init) => {
    const cursor = raw.includes('/graphql/') ? JSON.parse(new URL(raw).searchParams.get('variables')).cursor : undefined;
    if (cursor === 'c1' && limited) { limited = false; return { ok: false, status: 429 }; }
    return fetchPage(raw, init);
  };
  await search(h, 'LATER');
  let status = await finished(h);
  assert.equal(status.job.status, 'paused'); assert.match(status.job.error, /取得制限/); assert.equal(status.job.cursor, 'c1');
  h.pages.push(bookmarks([['000', ['UNUSED']]]), bookmarks([['802', ['LATER']]]));
  assert.equal((await search(h, 'LATER')).ok, true);
  status = await finished(h);
  assert.equal(status.job.status, 'found'); assert.equal(status.job.postId, '802'); assert.equal(status.job.posts, 2);
  assert.deepEqual(opened.map(o => o.url), ['https://x.com/i/status/802']);
});

test('search and bulk save do not read bookmarks at the same time', async () => {
  const h = harness(); withWindows(h);
  h.pages.push(bookmarks([['901', ['W1']]], 'c1'), bookmarks([['902', ['W2']]]));
  assert.equal((await search(h, 'NOPE_ID')).ok, true);
  const save = await h.request({ type: 'SAVE_ALL_VISIBLE_IMAGES', tabId: 1 });
  assert.equal(save.ok, false); assert.match(save.error, /検索中/);
  await finished(h);
});

test('only the side panel may start a search', async () => {
  const h = harness();
  const result = await h.request({ type: 'START_MEDIA_SEARCH', tabId: 1, query: 'ABCDEF' }, { id: 'test', url: 'https://x.com/home', frameId: 0, tab: { id: 1, url: 'https://x.com/home' } });
  assert.equal(result.ok, false);
});

test('every file seen while searching is indexed, so a later search needs no request', async () => {
  const h = harness(); const opened = withWindows(h);
  h.pages.push(bookmarks([['1101', ['SEEN_1', 'SEEN_2']]], 'c1'), bookmarks([['1102', ['FIRST']]], 'c2'));
  await search(h, 'FIRST'); await finished(h);
  assert.equal(h.store['mediaPost:SEEN_1'], '1101'); assert.equal(h.store['mediaPost:SEEN_2'], '1101'); assert.equal(h.store['mediaPost:FIRST'], '1102');
  assert.equal(h.store['savedImage:SEEN_1'], undefined, 'the index never marks a file as saved');
  const requests = h.directRequests.length;
  const second = await search(h, 'SEEN_2');
  assert.equal(second.job.status, 'found'); assert.equal(second.job.postId, '1101'); assert.equal(second.job.via, 'history');
  assert.equal(h.directRequests.length, requests);
  assert.deepEqual(opened.map(o => o.url), ['https://x.com/i/status/1102', 'https://x.com/i/status/1101']);
});

test('a bulk save indexes its files, and an indexed file is still downloaded', async () => {
  const h = harness({ 'mediaPost:IDX_1': '1200' }); withWindows(h);
  h.pages.push(bookmarks([['1200', ['IDX_1']], ['1201', ['IDX_2']]]));
  assert.equal((await h.request({ type: 'SAVE_ALL_VISIBLE_IMAGES', tabId: 1 })).ok, true);
  const status = await h.done();
  assert.equal(status.stats.success, 2); assert.equal(status.stats.skipped, 0);
  assert.equal(h.store['mediaPost:IDX_2'], '1201');
  const found = await search(h, 'IDX_2');
  assert.equal(found.job.via, 'history'); assert.equal(found.job.postId, '1201');
});
