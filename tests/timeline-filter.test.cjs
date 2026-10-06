const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const flush = () => new Promise(resolve => setImmediate(resolve));
const plain = value => JSON.parse(JSON.stringify(value));
const HOME = 'https://x.com/i/api/graphql/QUERY/HomeTimeline?variables=%7B%7D';

const post = (id, extra = {}) => ({ entryId: 'tweet-' + id, content: { entryType: 'TimelineTimelineItem', itemContent: { tweet_results: { result: { rest_id: id, legacy: {}, ...extra } } } } });
const repost = (id, original) => post(id, { legacy: { retweeted_status_result: { result: { __typename: 'TweetWithVisibilityResults', tweet: { rest_id: original } } } } });
const thread = (...ids) => ({ entryId: 'home-conversation-' + ids[0], content: { entryType: 'TimelineTimelineModule', items: ids.map(id => ({ entryId: 'item-' + id, item: post(id).content })) } });
const cursor = { entryId: 'cursor-bottom-1', content: { entryType: 'TimelineTimelineCursor', value: 'next' } };
const body = entries => ({ data: { home: { home_timeline_urt: { instructions: [{ type: 'TimelineClearCache' }, { type: 'TimelineAddEntries', entries }] } } } });
const ids = data => data.data.home.home_timeline_urt.instructions[1].entries.map(entry => entry.entryId);

function page({ path = '/home', responses = {}, wasOn = false } = {}) {
  const storage = new Map(wasOn ? [['__xOriginalUnreadOn', '1']] : []);
  const sessionStorage = { getItem: key => storage.get(key) ?? null };
  const listeners = [];
  const window = { addEventListener: (type, listener) => { if (type === 'message') listeners.push(listener); } };
  class XMLHttpRequest {
    static OPENED = 1;
    open(method, url) { this.url = url; this.readyState = 1; }
    send(body) { this.sent = (this.sent ?? 0) + 1; this.body = body; }
    abort() { this.aborted = true; }
    get responseText() { return this.raw; }
    get response() { return this.responseType === 'json' ? JSON.parse(this.raw) : this.raw; }
  }
  const fetch = async url => new Response(JSON.stringify(responses[url] ?? {}), { status: 200, headers: { 'content-type': 'application/json' } });
  window.fetch = fetch; window.XMLHttpRequest = XMLHttpRequest;
  const context = vm.createContext({ window, XMLHttpRequest, location: { pathname: path, href: 'https://x.com' + path, origin: 'https://x.com' }, URL, Response, Request, JSON, Promise, setTimeout, clearTimeout, structuredClone, sessionStorage });
  context.globalThis = context;
  vm.runInContext(fs.readFileSync('dist/timeline-filter.js', 'utf8'), context);
  return {
    context, window,
    send: data => listeners.forEach(listener => listener({ origin: 'https://x.com', data: { __xOriginalUnread: true, ...data } })),
    forge: data => listeners.forEach(listener => listener({ origin: 'https://evil.example', data: { __xOriginalUnread: true, ...data } })),
    fetch: url => window.fetch(url),
    xhr(url, raw, responseType = '') { const request = new context.XMLHttpRequest(); request.responseType = responseType; request.open('GET', url); request.raw = raw; request.readyState = 4; request.status = 200; return request; },
  };
}
test('read posts, reposts of read posts and fully read threads are removed from home timeline responses', async () => {
  const p = page({ responses: { [HOME]: body([post('1'), post('2'), repost('30', '3'), thread('4', '5'), thread('6'), cursor]) } });
  p.send({ enabled: true, ids: ['1', '3', '4', '6'] });
  const response = await p.fetch(HOME);
  const data = await response.json();
  assert.deepEqual(ids(data), ['tweet-2', 'home-conversation-4', 'cursor-bottom-1']);
  assert.deepEqual(plain(data.data.home.home_timeline_urt.instructions[1].entries[1].content.items.map(item => item.entryId)), ['item-4', 'item-5'], 'a partly read thread is kept whole');
  assert.equal(response.status, 200);
});
test('responses pass through unchanged while off, outside home, for other endpoints, and for forged messages', async () => {
  const data = body([post('1'), post('2')]);
  const other = 'https://x.com/i/api/graphql/QUERY/Bookmarks?variables=%7B%7D';
  const off = page({ responses: { [HOME]: data } });
  off.send({ enabled: false });
  assert.deepEqual(ids(await (await off.fetch(HOME)).json()), ['tweet-1', 'tweet-2']);
  off.forge({ enabled: true, ids: ['1'] });
  assert.deepEqual(ids(await (await off.fetch(HOME)).json()), ['tweet-1', 'tweet-2']);
  const away = page({ path: '/user', responses: { [HOME]: data } });
  away.send({ enabled: true, ids: ['1'] });
  assert.deepEqual(ids(await (await away.fetch(HOME)).json()), ['tweet-1', 'tweet-2']);
  const bookmarks = page({ responses: { [other]: { data: { home: { home_timeline_urt: data.data.home.home_timeline_urt } } } } });
  bookmarks.send({ enabled: true, ids: ['1'] });
  assert.deepEqual(ids(await (await bookmarks.fetch(other)).json()), ['tweet-1', 'tweet-2']);
  const disabled = page({ responses: { [HOME]: data } });
  disabled.send({ enabled: true, ids: ['1'] }); disabled.send({ enabled: false });
  assert.deepEqual(ids(await (await disabled.fetch(HOME)).json()), ['tweet-1', 'tweet-2']);
});
test('the first home response waits for the read list and later reads are applied', async () => {
  const p = page({ wasOn: true, responses: { [HOME]: body([post('1'), post('2'), post('3')]) } });
  const pending = p.fetch(HOME); await flush();
  p.send({ enabled: true, ids: ['1'] });
  assert.deepEqual(ids(await (await pending).json()), ['tweet-2', 'tweet-3']);
  p.send({ ids: ['2'] });
  assert.deepEqual(ids(await (await p.fetch(HOME)).json()), ['tweet-3']);
});
test('XMLHttpRequest home responses are filtered for text and json response types', () => {
  const p = page(); p.send({ enabled: true, ids: ['1'] });
  const raw = JSON.stringify(body([post('1'), post('2')]));
  const text = p.xhr(HOME, raw);
  assert.deepEqual(ids(JSON.parse(text.responseText)), ['tweet-2']);
  assert.deepEqual(ids(JSON.parse(text.response)), ['tweet-2']);
  assert.deepEqual(ids(plain(p.xhr(HOME, raw, 'json').response)), ['tweet-2']);
  const other = p.xhr('https://x.com/i/api/graphql/QUERY/Bookmarks', raw);
  assert.deepEqual(ids(JSON.parse(other.responseText)), ['tweet-1', 'tweet-2']);
});

test('a page whose posts are all read keeps its last read entry so X keeps loading', async () => {
  const p = page({ responses: { [HOME]: body([post('1'), thread('2', '3'), cursor]) } });
  p.send({ enabled: true, ids: ['1', '2', '3'] });
  const data = await (await p.fetch(HOME)).json();
  assert.deepEqual(ids(data), ['home-conversation-2', 'cursor-bottom-1']);
  const single = page({ responses: { [HOME]: body([post('1'), cursor]) } });
  single.send({ enabled: true, ids: ['1'] });
  assert.deepEqual(ids(await (await single.fetch(HOME)).json()), ['tweet-1', 'cursor-bottom-1']);
});

test('while the filter was off, the first home response is returned at once without waiting', async () => {
  const p = page({ responses: { [HOME]: body([post('1'), post('2')]) } });
  const started = Date.now();
  const data = await (await p.fetch(HOME)).json();
  assert.ok(Date.now() - started < 500);
  assert.deepEqual(ids(data), ['tweet-1', 'tweet-2']);
  const raw = JSON.stringify(body([post('1')]));
  const request = p.xhr(HOME, raw);
  assert.equal(Object.getOwnPropertyDescriptor(request, 'responseText'), undefined, 'XHR is untouched while off');
});

test('at page start the home timeline XHR is held until the read list arrives, then filtered', async () => {
  const p = page({ wasOn: true });
  const raw = JSON.stringify(body([post('1'), post('2')]));
  const request = new p.context.XMLHttpRequest(); request.open('POST', HOME); request.send('payload');
  await flush();
  assert.equal(request.sent, undefined, 'not sent before the read list arrives');
  p.send({ enabled: true, ids: ['1'] }); await flush();
  assert.equal(request.sent, 1); assert.equal(request.body, 'payload');
  request.raw = raw; request.readyState = 4; request.status = 200;
  assert.deepEqual(ids(JSON.parse(request.responseText)), ['tweet-2']);
  const later = new p.context.XMLHttpRequest(); later.open('POST', HOME); later.send(null);
  assert.equal(later.sent, 1, 'once the list has arrived, requests are sent at once');
  const aborted = page({ wasOn: true });
  const cancelled = new aborted.context.XMLHttpRequest(); cancelled.open('POST', HOME); cancelled.send(null); cancelled.abort();
  aborted.send({ enabled: true, ids: [] }); await flush();
  assert.equal(cancelled.sent, undefined, 'a request aborted while held is never sent');
  const other = new aborted.context.XMLHttpRequest(); other.open('GET', 'https://x.com/i/api/graphql/Q/Bookmarks'); other.send(null);
  assert.equal(other.sent, 1);
});

test('posts released at the top are removed from the entries X already holds on its next timeline response', async () => {
  const FIRST = HOME + '&page=1', SECOND = HOME + '&page=2', THIRD = HOME + '&page=3';
  const p = page({ responses: {
    [FIRST]: body([post('1'), post('2'), thread('3', '4'), repost('50', '5'), cursor]),
    [SECOND]: body([post('6'), cursor]),
    [THIRD]: body([post('7'), cursor]),
  } });
  p.send({ enabled: true, ids: ['9'] });
  assert.deepEqual(ids(await (await p.fetch(FIRST)).json()), ['tweet-1', 'tweet-2', 'home-conversation-3', 'tweet-50', 'cursor-bottom-1']);
  p.send({ ids: ['1', '3', '5'], release: ['1', '3', '5'] });
  const second = await (await p.fetch(SECOND)).json();
  const instructions = second.data.home.home_timeline_urt.instructions;
  assert.deepEqual(plain(instructions.at(-1)), { type: 'TimelineRemoveEntries', entryIds: ['tweet-1', 'tweet-50'] }, 'a partly released thread stays');
  const third = await (await p.fetch(THIRD)).json();
  assert.equal(third.data.home.home_timeline_urt.instructions.some(i => i.type === 'TimelineRemoveEntries'), false, 'each entry is removed once');
  p.send({ ids: ['4'], release: ['4'] });
  const fourth = await (await p.fetch(FIRST)).json();
  assert.deepEqual(plain(fourth.data.home.home_timeline_urt.instructions.at(-1)), { type: 'TimelineRemoveEntries', entryIds: ['home-conversation-3'] });
});
