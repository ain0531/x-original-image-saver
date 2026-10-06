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
  const articles = [];
  const root = { querySelector: () => selected ? { textContent: selected } : null, querySelectorAll: () => articles };
  const document = { querySelector: selector => selector.includes('AccountSwitcher') ? (account ? { textContent: account } : null) : root };
  const window = { fetch: async (input, init) => {
    requests.push({ url: String(input), init }); return { ok: true, status: 200, json: async () => responseBody, clone: () => ({ json: async () => responseBody }) };
  } };
  const context = vm.createContext({ window, document, location: { href: 'https://x.com/i/history', origin: 'https://x.com' }, performance: { timeOrigin: 7 }, XMLHttpRequest: XHR, URL, Headers, Request, AbortController, setTimeout, clearTimeout, console });
  vm.runInContext(fs.readFileSync('dist/bookmark-reader.js', 'utf8'), context);
  return { window, requests, context, articles, set body(value) { responseBody = value; }, set selected(value) { selected = value; }, set account(value) { account = value; } };
}
const nativeUrl = 'https://x.com/i/api/graphql/NATIVE_ID/Bookmarks?variables=' + encodeURIComponent(JSON.stringify({ count: 20, cursor: 'old', includePromotedContent: false })) + '&features=%7B%22native%22%3Atrue%7D';

test('account config exposes only loaded public assets and explicit effective boolean flags', async () => {
  const h = readerHarness(); h.context.location.href = 'https://x.com/alice';
  const good = 'https://abs.twimg.com/responsive-web/client-web/chunk.MEDIA.js';
  h.context.document.scripts = [{ src: good }, { src: 'https://evil.invalid/code.js' }];
  h.context.performance.getEntriesByType = () => [{ name: good }, { name: 'https://abs.twimg.com/responsive-web/client-web/main.PUBLIC.js' }, { name: 'https://x.com/i/api/graphql/private?token=secret' }];
  h.window.__INITIAL_STATE__ = { session: { auth_token: 'secret' }, featureSwitch: { defaultConfig: { flag: { value: false }, text: { value: 'secret' } }, config: { other: { value: true } }, user: { flag: { value: true } } } };
  const result = await h.window.__xImageBookmarkReader('account-config');
  assert.equal(result.pageUrl, 'https://x.com/alice'); assert.equal(result.features.flag, true); assert.equal(result.features.other, true);
  assert.equal(result.assets.length, 2); assert.ok(result.assets.includes(good)); assert.ok(!JSON.stringify(result).includes('secret'));
});

for (const transport of ['GET', 'POST', 'Request', 'XHR']) test(`native account first-page capture supports ${transport} without lookup or exposing headers`, async () => {
  const h = readerHarness(); h.context.location.href = 'https://x.com/alice/media'; h.account = 'user'; h.selected = 'メディア';
  h.body = { data: { user: { result: { rest_id: '42', core: { screen_name: 'alice' }, timeline_v2: { timeline: { instructions: [] } } } } } };
  const payload = { variables: { userId: '42', count: 20 }, features: { flag: true }, fieldToggles: { article: false } };
  const url = new URL('https://x.com/i/api/graphql/NATIVE/UserMedia');
  if (transport === 'GET') {
    for (const [key, value] of Object.entries(payload)) url.searchParams.set(key, JSON.stringify(value));
    await h.window.fetch(url.toString(), { headers: { authorization: 'private-token' } });
  } else if (transport === 'XHR') {
    const xhr = new h.context.XMLHttpRequest(); xhr.open('POST', url.toString()); xhr.setRequestHeader('authorization', 'private-token'); xhr.send(JSON.stringify(payload));
    xhr.status = 200; xhr.responseType = 'json'; xhr.response = { data: { user: { result: { rest_id: '42', timeline_v2: { timeline: { instructions: [] } } } } } }; xhr.load();
  } else {
    const init = { method: 'POST', headers: { authorization: 'private-token' }, body: JSON.stringify(payload) };
    await h.window.fetch(transport === 'Request' ? new Request(url, init) : url.toString(), transport === 'Request' ? undefined : init);
  }
  const result = await h.window.__xImageBookmarkReader('account-bootstrap');
  assert.equal(result.available, true); assert.equal(result.userId, '42'); assert.equal(result.request.features.flag, true);
  assert.equal(result.request.method, transport === 'GET' ? 'GET' : 'POST');
  assert.ok(!JSON.stringify(result).includes('private-token')); assert.equal(h.requests.length, transport === 'XHR' ? 0 : 1);
  h.account = 'other'; assert.equal((await h.window.__xImageBookmarkReader('account-bootstrap')).available, false);
});

test('account first-page capture rejects cursor pages and mismatched owners', async () => {
  for (const scenario of ['cursor', 'id', 'handle']) {
    const h = readerHarness(); h.context.location.href = 'https://x.com/alice/media';
    h.body = { data: { user: { result: { rest_id: scenario === 'id' ? '99' : '42', core: { screen_name: scenario === 'handle' ? 'bob' : 'alice' } } } } };
    const url = new URL('https://x.com/i/api/graphql/NATIVE/UserMedia');
    url.searchParams.set('variables', JSON.stringify({ userId: '42', ...(scenario === 'cursor' ? { cursor: 'next' } : {}) }));
    await h.window.fetch(url.toString());
    assert.equal((await h.window.__xImageBookmarkReader('account-bootstrap')).available, false);
  }
});
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

function mediaPost(id = '101') {
  return { rest_id: id, legacy: { full_text: 'post', extended_entities: { media: ['A', 'B', 'C', 'D'].map(id => ({ type: 'photo', media_url_https: `https://pbs.twimg.com/media/${id}.jpg` })) } } };
}
function renderedArticle(id, props) {
  const article = { parentElement: null };
  const link = { href: `https://x.com/user/status/${id}`, querySelector: () => ({}), closest: () => article };
  article.querySelectorAll = selector => selector === 'a[href]' ? [link] : [];
  article.__reactFiber$test = { memoizedProps: { children: { props } }, return: null };
  return article;
}
test('same-account post metadata survives client-side route and selected-tab changes', async () => {
  const h = readerHarness(); h.selected = 'ブックマーク'; h.account = 'user'; h.body = { data: { result: mediaPost() } };
  await h.window.fetch(nativeUrl);
  h.context.location.href = 'https://x.com/home'; h.selected = 'おすすめ';
  const scope = JSON.stringify(['https://x.com/home', 'おすすめ', 'user']);
  const result = await h.window.__xImageBookmarkReader('posts', undefined, scope, ['101']);
  assert.equal(result.posts[0].urls.length, 4); assert.equal(result.posts[0].complete, true);
  assert.equal((await h.window.__xImageBookmarkReader('probe')).available, false);
});
test('initial account label mounting after 30 seconds does not expire the post list', async () => {
  const h = readerHarness(); h.body = { data: { result: mediaPost() } };
  await h.window.fetch(nativeUrl);
  h.context.Date = class extends Date { static now() { return Date.now() + 60000; } };
  h.selected = 'ブックマーク'; h.account = 'user';
  const scope = JSON.stringify(['https://x.com/i/history', 'ブックマーク', 'user']);
  const result = await h.window.__xImageBookmarkReader('posts', undefined, scope, ['101']);
  assert.equal(result.posts[0].urls.length, 4);
  h.account = 'other';
  assert.equal((await h.window.__xImageBookmarkReader('posts', undefined, scope.replace('user', 'other'), ['101'])).posts.length, 0);
});
test('committed article props supply all photos and videos when native requests were missed', async () => {
  const h = readerHarness(); h.account = 'user';
  const target = mediaPost('202');
  target.legacy.extended_entities.media.push({ type: 'video', id_str: '123', video_info: { variants: [{ content_type: 'video/mp4', bitrate: 1000, url: 'https://video.twimg.com/ext_tw_video/123/pu/vid/640x360/test.mp4' }] } });
  const props = { tweet: target, quotedTweet: mediaPost('303') }; props.cycle = props;
  h.articles.push(renderedArticle('101', { tweet: mediaPost('101') }), renderedArticle('202', props));
  const result = await h.window.__xImageBookmarkReader('posts', undefined, JSON.stringify(['https://x.com/i/history', '', 'user']), ['202']);
  assert.equal(result.posts.length, 1); assert.equal(result.posts[0].postId, '202');
  assert.equal(result.posts[0].urls.length, 4); assert.equal(result.posts[0].videos.length, 1); assert.equal(result.posts[0].complete, true);
  assert.equal(h.requests.length, 0); assert.ok(!JSON.stringify(result).includes('full_text'));
});
test('direct React props work but a neighboring or truncated post cannot prove a full list', async () => {
  const h = readerHarness(); const target = mediaPost('202');
  const article = renderedArticle('202', { tweet: mediaPost('101') }); h.articles.push(article);
  const scope = JSON.stringify(['https://x.com/i/history', '', '']);
  assert.equal((await h.window.__xImageBookmarkReader('posts', undefined, scope, ['202'])).posts.length, 0);
  delete article.__reactFiber$test;
  article.__reactProps$test = { tweet: { rest_id: '202', legacy: { full_text: 'partial', entities: { media: target.legacy.extended_entities.media.slice(0, 1) } } } };
  assert.equal((await h.window.__xImageBookmarkReader('posts', undefined, scope, ['202'])).posts.length, 0);
  article.__reactProps$test = { tweet: target };
  assert.equal((await h.window.__xImageBookmarkReader('posts', undefined, scope, ['202'])).posts[0].urls.length, 4);
});
test('POST GraphQL responses populate post metadata without authorizing bookmark replay', async () => {
  const h = readerHarness(); h.body = { data: { result: mediaPost() } };
  await h.window.fetch(nativeUrl, { method: 'POST', body: '{}' });
  const scope = JSON.stringify(['https://x.com/i/history', '', '']);
  assert.equal((await h.window.__xImageBookmarkReader('posts', undefined, scope, ['101'])).posts[0].urls.length, 4);
  assert.equal((await h.window.__xImageBookmarkReader('probe')).available, false);
  assert.equal((await h.window.__xImageBookmarkReader('bootstrap')).available, false);
});
