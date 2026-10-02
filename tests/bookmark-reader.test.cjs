const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
function readerHarness() {
  let selected = '';
  let account = '';
  const requests = []; let responseBody = { data: { test: true } };
  class XHR {
    open() {} setRequestHeader() {} send() {} addEventListener(type, callback) { if (type === 'load') this.load = callback; }
  }
  const root = { querySelector: () => selected ? { textContent: selected } : null };
  const document = { querySelector: selector => selector.includes('AccountSwitcher') ? (account ? { textContent: account } : null) : root };
  const window = { fetch: async (input, init) => {
    requests.push({ url: String(input), init }); return { ok: true, status: 200, json: async () => responseBody, clone: () => ({ json: async () => responseBody }) };
  } };
  const context = vm.createContext({ window, document, location: { href: 'https://x.com/i/history', origin: 'https://x.com' }, performance: { timeOrigin: 7 }, XMLHttpRequest: XHR, URL, Headers, Request, AbortController, setTimeout, clearTimeout, console });
  vm.runInContext(fs.readFileSync('dist/bookmark-reader.js', 'utf8'), context);
  return { window, requests, context, set body(value) { responseBody = value; }, set selected(value) { selected = value; }, set account(value) { account = value; } };
}
const nativeUrl = 'https://x.com/i/api/graphql/NATIVE_ID/Bookmarks?variables=' + encodeURIComponent(JSON.stringify({ count: 20, cursor: 'old', includePromotedContent: false })) + '&features=%7B%22native%22%3Atrue%7D';
test('bootstrap returns only native first-page bookmarks without another fetch or credentials', async () => {
  const h = readerHarness(); h.selected = 'ブックマーク'; h.account = 'user';
  await h.window.fetch(nativeUrl);
  assert.equal((await h.window.__xImageBookmarkReader('bootstrap')).available, false);
  const first = new URL(nativeUrl); first.searchParams.set('variables', '{"count":20}');
  h.body = { data: { bookmark_timeline_v2: { timeline: { instructions: [] } } } };
  await h.window.fetch(first.toString(), { headers: { authorization: 'private-token' } });
  const result = await h.window.__xImageBookmarkReader('bootstrap');
  assert.equal(result.available, true); assert.ok(result.data.data.bookmark_timeline_v2);
  assert.equal(h.requests.length, 2); assert.ok(!JSON.stringify(result).includes('private-token'));
  h.account = 'other'; assert.equal((await h.window.__xImageBookmarkReader('bootstrap')).available, false);
});
test('native XHR first-page response can initialize bookmarks without another request', async () => {
  const h = readerHarness(); h.selected = 'ブックマーク'; h.account = 'user';
  const first = new URL(nativeUrl); first.searchParams.set('variables', '{"count":20}');
  const xhr = new h.context.XMLHttpRequest(); xhr.status = 200; xhr.responseType = 'json';
  xhr.response = { data: { bookmark_timeline_v2: { timeline: { instructions: [] } } } };
  xhr.open('GET', first.toString()); xhr.setRequestHeader('authorization', 'private-xhr'); xhr.send(); xhr.load();
  const result = await h.window.__xImageBookmarkReader('bootstrap');
  assert.equal(result.available, true); assert.ok(result.data.data.bookmark_timeline_v2);
  assert.equal(h.requests.length, 0); assert.ok(!JSON.stringify(result).includes('private-xhr'));
});
test('MAIN capture reuses native request credentials and cursor without exposing them', async () => {
  const h = readerHarness();
  assert.equal((await h.window.__xImageBookmarkReader('probe')).available, false);
  await h.window.fetch(nativeUrl, { headers: { authorization: 'private-token', 'x-csrf-token': 'private-csrf' } });
  h.selected = 'ブックマーク'; h.account = 'user';
  const probe = await h.window.__xImageBookmarkReader('probe');
  assert.equal(probe.available, true);
  assert.ok(!JSON.stringify(probe).includes('private-'));
  const result = await h.window.__xImageBookmarkReader('page', 'next', probe.scope);
  assert.equal(result.available, true);
  const request = h.requests.at(-1);
  const url = new URL(request.url);
  assert.equal(JSON.parse(url.searchParams.get('variables')).cursor, 'next');
  assert.equal(JSON.parse(url.searchParams.get('variables')).count, 20);
  assert.equal(url.searchParams.get('features'), '{"native":true}');
  assert.equal(request.init.credentials, 'include');
  assert.equal(request.init.headers.get('authorization'), 'private-token');
  assert.ok(!JSON.stringify(result).includes('private-'));
});
test('page account or selected-tab changes invalidate bookmark request', async () => {
  const h = readerHarness(); h.selected = 'ブックマーク'; h.account = 'user';
  await h.window.fetch(nativeUrl); assert.equal((await h.window.__xImageBookmarkReader('probe')).available, true);
  h.selected = 'いいね'; assert.equal((await h.window.__xImageBookmarkReader('probe')).available, false);
  h.selected = 'ブックマーク'; h.account = 'other'; assert.equal((await h.window.__xImageBookmarkReader('probe')).available, false);
});
test('non-bookmark and foreign-origin requests cannot establish a bookmark reader', async () => {
  const h = readerHarness();
  await h.window.fetch(nativeUrl.replace('/Bookmarks?', '/Likes?'));
  await h.window.fetch(nativeUrl.replace('x.com', 'foreign.example'));
  assert.equal((await h.window.__xImageBookmarkReader('probe')).available, false);
});


test('native responses keep every photo even when only one is rendered', async () => {
  const h = readerHarness(); h.selected = 'ブックマーク'; h.account = 'user';
  const media = ['A', 'B', 'C', 'D'].map(id => ({ type: 'photo', media_url_https: `https://pbs.twimg.com/media/${id}.jpg` }));
  h.body = { data: { tweetResult: { result: { rest_id: '101', legacy: { full_text: 'post', entities: { media: media.slice(0, 1) }, extended_entities: { media } } } } } };
  await h.window.fetch(nativeUrl.replace('/Bookmarks?', '/TweetDetail?'));
  const scope = JSON.stringify(['https://x.com/i/history', 'ブックマーク', 'user']);
  const result = await h.window.__xImageBookmarkReader('posts', undefined, scope, ['101', '999']);
  assert.equal(result.posts.length, 1); assert.equal(result.posts[0].complete, true); assert.equal(result.posts[0].urls.length, 4);
  assert.ok(!JSON.stringify(result).includes('full_text'));
  h.body = { data: { result: { rest_id: '101', legacy: { full_text: 'post', entities: { media: media.slice(0, 1) } } } } };
  await h.window.fetch(nativeUrl.replace('/Bookmarks?', '/TweetDetail?'));
  assert.equal((await h.window.__xImageBookmarkReader('posts', undefined, scope, ['101'])).posts[0].urls.length, 4);
  h.account = 'other';
  const changed = JSON.stringify(['https://x.com/i/history', 'ブックマーク', 'other']);
  assert.equal((await h.window.__xImageBookmarkReader('posts', undefined, changed, ['101'])).posts.length, 0);
});
test('native responses retain complete video variant metadata without treating the poster as a photo', async () => {
  const h = readerHarness(); h.selected = 'ブックマーク'; h.account = 'user';
  const video = { type: 'video', id_str: '123', media_key: '13_123', media_url_https: 'https://pbs.twimg.com/media/POSTER.jpg', video_info: { variants: [{ bitrate: 2176000, content_type: 'video/mp4', url: 'https://video.twimg.com/ext_tw_video/123/pu/vid/1280x720/test.mp4' }] } };
  h.body = { data: { result: { rest_id: '101', legacy: { full_text: 'post', extended_entities: { media: [video] } } } } };
  await h.window.fetch(nativeUrl.replace('/Bookmarks?', '/TweetDetail?'));
  const scope = JSON.stringify(['https://x.com/i/history', 'ブックマーク', 'user']);
  const result = await h.window.__xImageBookmarkReader('posts', undefined, scope, ['101']);
  assert.equal(result.posts[0].urls.length, 0); assert.equal(result.posts[0].videos.length, 1); assert.equal(result.posts[0].videos[0].video_info.variants[0].bitrate, 2176000);
});
