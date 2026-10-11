const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { harness, flush } = require('./harness.cjs');
function folderReader() {
  const calls = [], replies = [];
  const document = { cookie: 'twid=u%3D42; ct0=csrf-test', scripts: [] };
  class XHR { open() {} setRequestHeader() {} send() {} addEventListener(_, fn) { this.load = fn; } }
  const window = { fetch: async (input, init) => {
    calls.push({ url: String(input), init });
    const reply = replies.shift() ?? {};
    if (reply.wait) await reply.wait;
    if (reply.hook) reply.hook();
    return { ok: !reply.status || reply.status < 400, status: reply.status ?? 200, clone: () => ({ json: async () => reply.body ?? {} }), json: async () => reply.body ?? {}, text: async () => reply.text ?? '' };
  } };
  const context = vm.createContext({ window, document, location: { href: 'https://x.com/home', origin: 'https://x.com' }, performance: { getEntriesByType: () => [] }, XMLHttpRequest: XHR, URL, Headers, Request, AbortController, setTimeout, clearTimeout });
  vm.runInContext(fs.readFileSync('dist/bookmark-folder-reader.js', 'utf8'), context);
  const headers = { authorization: 'Bearer private-token', 'x-csrf-token': 'csrf-test', 'x-client-transaction-id': 'must-not-replay' };
  const learn = async () => {
    await window.fetch('https://x.com/i/api/graphql/LIST_NATIVE/BookmarkFoldersSlice?variables=%7B%22count%22%3A5%7D&features=%7B%22native%22%3Atrue%7D', { headers });
    await window.fetch('https://x.com/i/api/graphql/ADD_NATIVE/bookmarkTweetToFolder', { method: 'POST', headers, body: JSON.stringify({ variables: { bookmark_collection_id: '99', tweet_id: '1' }, features: { native: true } }) });
    calls.length = 0;
  };
  return { window, document, context, calls, replies, headers, learn, run: (operation, folder, post) => window.__xOriginalBookmarkFolders(operation, 'csrf-test', folder, post) };
}
const list = (items, cursor) => ({ data: { viewer: { user_results: { result: { bookmark_collections_slice: { items, next_cursor: cursor } } } } } });

test('folder reader paginates native list without exposing credentials or transaction IDs', async () => {
  const h = folderReader(); await h.learn();
  h.replies.push({ body: list([{ id: '10', name: '資料' }], 'next') }, { body: list([{ id: '11', name: '画像' }]) });
  const result = await h.run('list');
  assert.equal(result.ok, true); assert.equal(result.folders.length, 2);
  assert.equal(JSON.parse(new URL(h.calls[1].url).searchParams.get('variables')).cursor, 'next');
  assert.equal(JSON.parse(new URL(h.calls[0].url).searchParams.get('features')).native, true);
  assert.equal(h.calls[0].init.headers.get('x-client-transaction-id'), null);
  assert.ok(!JSON.stringify(result).includes('private-token'));
});
test('folder mutation sends only requested post and folder, preserving native features', async () => {
  const h = folderReader(); await h.learn(); h.replies.push({ body: { data: { bookmark_collection_tweet_put: 'Done' } } }, { body: list([{ id: '10', name: '資料', contains_requested_tweet: true }]) });
  assert.equal((await h.run('add', '10', '202')).ok, true);
  const request = h.calls[0], payload = JSON.parse(request.init.body);
  assert.equal(request.init.method, 'POST'); assert.equal(payload.queryId, 'ADD_NATIVE');
  assert.deepEqual(payload.variables, { bookmark_collection_id: '10', tweet_id: '202' });
  assert.equal(payload.features.native, true);
});
test('HTTP and GraphQL errors and unknown mutation responses never claim success', async () => {
  for (const reply of [{ status: 403 }, { status: 429 }, { body: { errors: [{ message: 'denied' }] } }, { body: { data: {} } }]) {
    const h = folderReader(); await h.learn(); h.replies.push(reply);
    assert.equal((await h.run('add', '10', '202')).ok, false);
  }
});
test('usable partial GraphQL responses follow X native handling and still require folder membership', async () => {
  const h = folderReader(); await h.learn();
  const partial = list([{ id: '10', name: '資料' }]);
  partial.errors = [{ message: 'unrelated field unavailable', extensions: { code: 131 } }];
  h.replies.push({ body: partial });
  assert.equal((await h.run('list')).folders[0].id, '10');
  assert.equal(h.calls[0].init.headers.get('content-type'), 'application/json');
  const membership = list([{ id: '10', name: '資料', contains_requested_tweet: true }]);
  membership.errors = partial.errors;
  h.replies.push({ body: { data: { bookmark_collection_tweet_put: 'Done' }, errors: partial.errors } }, { body: membership });
  assert.equal((await h.run('add', '10', '202')).verified, true);
  h.replies.push({ body: { data: { bookmark_collection_tweet_put: null }, errors: partial.errors } });
  const failed = await h.run('add', '10', '202');
  assert.equal(failed.ok, false); assert.match(failed.error, /フォルダ登録.*code 131/);
});
test('refusals identify the stage, HTTP status and X code without exposing credentials', async () => {
  const h = folderReader(); await h.learn();
  h.replies.push({ status: 403, body: { errors: [{ extensions: { code: 'ACCESS_DENIED' }, message: 'Denied Bearer private-token csrf-test' }] } });
  const failure = await h.run('list');
  assert.match(failure.error, /フォルダ一覧取得.*HTTP 403.*BookmarkFoldersSlice.*code ACCESS_DENIED/);
  assert.ok(!failure.error.includes('private-token')); assert.ok(!failure.error.includes('csrf-test'));
  h.replies.push({ body: { data: { bookmark_collection_tweet_put: 'Done' } } }, { body: { errors: [{ code: 88, message: 'Rate limit exceeded' }] } });
  const verification = await h.run('add', '10', '202');
  assert.equal(verification.ok, false); assert.match(verification.error, /フォルダ登録確認.*code 88: Rate limit exceeded/);
  assert.ok(!verification.error.includes('契約状態'));
});
test('X bookmark entitlement rejection is distinct from missing folders and blocks even partial data', async () => {
  for (const withData of [false, true]) {
    const h = folderReader(); await h.learn();
    const body = withData ? list([]) : {};
    body.errors = [{ message: 'Authorization: User is not authorized to use bookmark collections.', extensions: { code: 37 } }];
    h.replies.push({ body });
    const result = await h.run('list');
    assert.equal(result.ok, false); assert.match(result.error, /フォルダ通信.*フォルダ一覧取得.*code 37/);
    assert.match(result.error, /拡張の認証・通信条件の調査/); assert.match(result.error, /通常のブックマークは維持/);
    assert.ok(!result.error.includes('一致していません'));
    assert.equal(h.calls.length, 1);
  }
});
test('folder operations verify background account, delegated identity and response viewer', async () => {
  const h = folderReader(); await h.learn();
  const mismatch = await h.window.__xOriginalBookmarkFolders('list', 'csrf-test', '', '', {}, '43');
  assert.equal(mismatch.ok, false); assert.equal(h.calls.length, 0);
  const body = list([{ id: '10', name: '資料' }]);
  body.data.viewer.user_results.result.rest_id = '43';
  h.replies.push({ body });
  const foreign = await h.run('list'); assert.equal(foreign.ok, false); assert.match(foreign.error, /別アカウント/);
  await h.window.fetch('https://x.com/i/api/graphql/USER/UserByScreenName', { headers: { ...h.headers, 'x-act-as-user-id': '43' } });
  h.calls.length = 0;
  const delegated = await h.run('add', '10', '202'); assert.equal(delegated.ok, false); assert.match(delegated.error, /操作対象アカウント/);
  assert.equal(h.calls.length, 0);
  const valid = folderReader(); await valid.learn();
  const own = list([{ id: '10', name: '資料' }]); own.data.viewer.user_results.result.rest_id = '42';
  valid.replies.push({ body: own });
  assert.equal((await valid.window.__xOriginalBookmarkFolders('list', 'csrf-test', '', '', {}, '42')).ok, true);
});
test('empty folders and unreadable folders are distinct and repeated cursor fails closed', async () => {
  const h = folderReader(); await h.learn(); h.replies.push({ body: list([]) });
  assert.equal((await h.run('list')).folders.length, 0);
  h.replies.push({ body: {} }); assert.equal((await h.run('list')).ok, false);
  h.replies.push({ body: list([], 'same') }, { body: list([], 'same') });
  assert.equal((await h.run('list')).ok, false);
});
test('session changes discard cached configuration and stop a response from another account', async () => {
  const h = folderReader(); await h.learn();
  h.replies.push({ body: list([{ id: '10', name: '資料' }]), hook: () => { h.document.cookie = 'twid=u%3D43; ct0=csrf-test'; } });
  assert.equal((await h.run('list')).ok, false);
  h.calls.length = 0; assert.equal((await h.run('add', '10', '202')).ok, false); assert.equal(h.calls.length, 0);
});
test('invalid IDs and mismatched CSRF do not issue mutations', async () => {
  const h = folderReader(); await h.learn();
  assert.equal((await h.run('add', 'bad', '202')).ok, false);
  assert.equal((await h.window.__xOriginalBookmarkFolders('add', 'wrong', '10', '202')).ok, false);
  assert.equal(h.calls.length, 0);
});
test('loaded public chunks discover current operation IDs without evaluating code', async () => {
  const h = folderReader();
  await h.window.fetch('https://x.com/i/api/graphql/USER/UserByScreenName', { headers: h.headers }); h.calls.length = 0;
  h.document.scripts = [{ src: 'https://abs.twimg.com/responsive-web/client-web/bundle.BookmarkFolders.123.js' }, { src: 'https://evil.invalid/bundle.BookmarkFolders.js' }];
  h.replies.push({ text: 'queryId:"DYNAMIC_LIST",operationName:"BookmarkFoldersSlice",metadata:{featureSwitches:[]} queryId:"DYNAMIC_ADD",operationName:"bookmarkTweetToFolder",metadata:{featureSwitches:[]}' }, { body: list([{ id: '10', name: '資料' }]) });
  assert.equal((await h.run('list')).ok, true);
  assert.match(h.calls[1].url, /DYNAMIC_LIST/); assert.equal(h.calls.length, 2);
});
test('XHR templates are captured with the same session boundary', async () => {
  const h = folderReader(), xhr = new h.context.XMLHttpRequest();
  xhr.open('GET', 'https://x.com/i/api/graphql/XHR_LIST/BookmarkFoldersSlice?variables=%7B%7D');
  for (const [key, value] of Object.entries(h.headers)) xhr.setRequestHeader(key, value);
  xhr.status = 200; xhr.send(); xhr.load();
  h.replies.push({ body: list([]) }); assert.equal((await h.run('list')).ok, true); assert.match(h.calls[0].url, /XHR_LIST/);
});
const optionsSender = { id: 'test', url: 'chrome-extension://test/options.html' };
const postSender = { id: 'test', frameId: 0, url: 'https://x.com/home', tab: { id: 1, url: 'https://x.com/home' } };
function folderWorker(capture = true) {
  const h = harness(), calls = [];
  h.chrome.cookies.getAllCookieStores = async () => [{ id: '0', tabIds: Array.from({ length: 100 }, (_, i) => i + 1) }];
  const observe = tabId => h.observe({ method: 'POST', tabId, url: 'https://x.com/i/api/graphql/NATIVE/UserClaims', requestHeaders: [
    { name: 'authorization', value: 'Bearer observed-web-client' }, { name: 'x-csrf-token', value: 'csrf-test' },
    { name: 'x-twitter-auth-type', value: 'OAuth2Session' }, { name: 'x-twitter-client-language', value: 'ja' },
    { name: 'x-client-transaction-id', value: 'per-request-do-not-copy' },
  ] });
  if (capture) observe(1);
  const create = h.chrome.tabs.create;
  h.chrome.tabs.create = async options => { const tab = await create(options); observe(tab.id); return tab; };
  h.chrome.scripting.executeScript = async options => {
    if (options.files) return [];
    // Match Chrome's argument validation rather than silently accepting undefined.
    JSON.stringify(options.args, (_, value) => { assert.notEqual(value, undefined, 'executeScript args must be JSON-serializable'); return value; });
    calls.push(options);
    return [{ result: options.args[0] === 'list' ? { ok: true, folders: [{ id: '10', name: '資料' }] } : { ok: true, verified: true } }];
  };
  return { h, calls };
}
test('worker settings and registration use verified login and sender tab, keeping existing bookmarks', async () => {
  const { h, calls } = folderWorker();
  const listed = await h.request({ type: 'LIST_BOOKMARK_FOLDERS', tabId: 1 }, optionsSender);
  assert.equal(listed.ok, true);
  const selected = await h.request({ type: 'SET_BOOKMARK_FOLDER', tabId: 1, account: listed.account, folderId: '10' }, optionsSender);
  assert.equal(selected.selected.name, '資料');
  const saved = await h.request({ type: 'SPECIAL_SAVE_FOLDER', postId: '202', tabId: 999, folderId: '999' }, postSender);
  assert.equal(saved.ok, true); assert.equal(saved.configured, true);
  const mutation = calls.at(-1); assert.equal(mutation.target.tabId, 1); assert.equal(mutation.args[2], '10'); assert.equal(mutation.args[3], '202');
  assert.equal(h.calls.length, 0);
});
test('worker rejects forged senders, stale accounts and nonexistent folders', async () => {
  const { h, calls } = folderWorker();
  assert.equal((await h.request({ type: 'SPECIAL_SAVE_FOLDER', postId: '202' }, optionsSender)).ok, false);
  assert.equal((await h.request({ type: 'LIST_BOOKMARK_FOLDERS', tabId: 1 }, postSender)).ok, false);
  assert.equal(calls.length, 0);
  assert.equal((await h.request({ type: 'SET_BOOKMARK_FOLDER', tabId: 1, account: 'stale', folderId: '10' }, optionsSender)).ok, false);
  const listed = await h.request({ type: 'LIST_BOOKMARK_FOLDERS', tabId: 1 }, optionsSender);
  assert.equal((await h.request({ type: 'SET_BOOKMARK_FOLDER', tabId: 1, account: listed.account, folderId: '999' }, optionsSender)).ok, false);
});

test('unknown required flags never borrow empty flags from an adjacent operation', async () => {
  const h = folderReader(); await h.window.fetch('https://x.com/i/api/graphql/USER/UserByScreenName', { headers: h.headers }); h.calls.length = 0;
  h.document.scripts = [{ src: 'https://abs.twimg.com/responsive-web/client-web/bundle.BookmarkFolders.js' }];
  h.replies.push({ text: 'queryId:"NEEDS_FLAG",operationName:"BookmarkFoldersSlice",metadata:{featureSwitches:["unknown_required"]} queryId:"OTHER",operationName:"bookmarkTweetToFolder",metadata:{featureSwitches:[]}' });
  assert.equal((await h.run('list')).ok, false); assert.equal(h.calls.length, 1);
});
test('settings can be cleared without any X request or removing bookmarks', async () => {
  const { h, calls } = folderWorker(); h.store.specialSaveBookmarkFolders = { old: { id: '10', name: '資料' } };
  assert.equal((await h.request({ type: 'CLEAR_BOOKMARK_FOLDERS' }, optionsSender)).ok, true);
  assert.equal(h.store.specialSaveBookmarkFolders, undefined); assert.equal(calls.length, 0);
});

test('public operation templates work on a different X tab without transferring authentication', async () => {
  const first = folderReader(); await first.learn(); first.replies.push({ body: list([{ id: '10', name: '資料' }]) });
  const snapshot = await first.run('list');
  assert.ok(!JSON.stringify(snapshot.templates).includes('private-token'));
  const other = folderReader(); await other.window.fetch('https://x.com/i/api/graphql/USER/UserByScreenName', { headers: other.headers }); other.calls.length = 0;
  other.replies.push({ body: { data: { bookmark_collection_tweet_put: 'Done' } } }, { body: list([{ id: '10', name: '資料', contains_requested_tweet: true }]) });
  const result = await other.window.__xOriginalBookmarkFolders('add', 'csrf-test', '10', '202', snapshot.templates);
  assert.equal(result.ok, true); assert.match(other.calls[0].url, /ADD_NATIVE/);
  const foreign = folderReader(); await foreign.window.fetch('https://x.com/i/api/graphql/USER/UserByScreenName', { headers: foreign.headers }); foreign.calls.length = 0;
  const forged = { bookmarkTweetToFolder: { url: 'https://evil.invalid/i/api/graphql/ADD/bookmarkTweetToFolder', variables: {} } };
  assert.equal((await foreign.window.__xOriginalBookmarkFolders('add', 'csrf-test', '10', '202', forged)).ok, false);
  assert.equal(foreign.calls.length, 0);
});
test('deleted folders and an account change in the worker never trigger registration', async () => {
  const { h, calls } = folderWorker();
  const listed = await h.request({ type: 'LIST_BOOKMARK_FOLDERS', tabId: 1 }, optionsSender);
  await h.request({ type: 'SET_BOOKMARK_FOLDER', tabId: 1, account: listed.account, folderId: '10' }, optionsSender);
  h.chrome.scripting.executeScript = async options => { if (options.files) return []; calls.push(options); return [{ result: { ok: true, folders: [] } }]; };
  calls.length = 0;
  assert.equal((await h.request({ type: 'SPECIAL_SAVE_FOLDER', postId: '202' }, postSender)).ok, false);
  assert.equal(calls.filter(call => call.args[0] === 'add').length, 0);
  h.chrome.scripting.executeScript = async options => { if (options.files) return []; h.auth = 'different-account'; return [{ result: { ok: true, folders: [{ id: '10', name: '資料' }] } }]; };
  assert.equal((await h.request({ type: 'LIST_BOOKMARK_FOLDERS', tabId: 1 }, optionsSender)).ok, false);
});

test('executeScript list arguments remain serializable without IDs and with optional cached feature properties', async () => {
  const { h, calls } = folderWorker();
  const listed = await h.request({ type: 'LIST_BOOKMARK_FOLDERS', tabId: 1 }, optionsSender);
  assert.equal(listed.ok, true);
  assert.equal(calls[0].args[2], ''); assert.equal(calls[0].args[3], '');
  assert.equal(JSON.stringify(calls[0].args[4]), '{}');
  h.session['bookmarkFolderTemplates:' + listed.account] = {
    at: Date.now(), templates: { BookmarkFoldersSlice: { url: 'https://x.com/i/api/graphql/LIST/BookmarkFoldersSlice', variables: {}, features: undefined } },
  };
  const cached = await h.request({ type: 'LIST_BOOKMARK_FOLDERS', tabId: 1 }, optionsSender);
  assert.equal(cached.ok, true);
  assert.equal(Object.hasOwn(calls.at(-1).args[4].BookmarkFoldersSlice, 'features'), false);
});

test('unopened Bookmark chunks use runtime mappings and observed authentication instead of a guessed public token', async () => {
  const h = folderReader();
  const mainUrl = 'https://abs.twimg.com/responsive-web/client-web/main.ABC.js';
  h.document.scripts = [
    { src: mainUrl },
    { src: '', textContent: 't.u=e=>(({34778:"shared~bundle.BookmarkFolders~bundle.Bookmarks",85606:"bundle.BookmarkFolders"})[e]||e)+"."+({34778:"a6f86e8e9fe7d436",85606:"aad5433a4328f008"})[e]+"a.js",t.hmd=e=>e' },
  ];
  h.replies.push(
    { text: 'queryId:"AUTO_LIST",operationName:"BookmarkFoldersSlice",operationType:"query",metadata:{featureSwitches:[],fieldToggles:[]}} queryId:"AUTO_ADD",operationName:"bookmarkTweetToFolder",operationType:"mutation",metadata:{featureSwitches:[],fieldToggles:[]}}' },
    { body: list([{ id: '10', name: '資料' }]) },
  );
  const result = await h.window.__xOriginalBookmarkFolders('list', 'csrf-test', '', '', {}, '42', h.headers);
  assert.equal(result.ok, true);
  assert.equal(h.calls[0].url, 'https://abs.twimg.com/responsive-web/client-web/shared~bundle.BookmarkFolders~bundle.Bookmarks.a6f86e8e9fe7d436a.js');
  assert.match(h.calls[1].url, /AUTO_LIST/);
  assert.equal(h.calls[1].init.headers.get('x-csrf-token'), 'csrf-test');
  assert.equal(h.calls[1].init.headers.get('authorization'), h.headers.authorization);
  assert.ok(!JSON.stringify(result).includes('AAAAAAAA'));
});
test('worker supplies only the observed login headers and automatically closes its authentication tab', async () => {
  for (const capture of [true, false]) {
    const { h, calls } = folderWorker(capture);
    const result = await h.request({ type: 'LIST_BOOKMARK_FOLDERS', tabId: 1 }, optionsSender);
    assert.equal(result.ok, true);
    const headers = calls[0].args[6];
    assert.equal(headers.authorization, 'Bearer observed-web-client');
    assert.equal(headers['x-twitter-client-language'], 'ja');
    assert.equal(headers['x-client-transaction-id'], undefined);
    assert.equal(h.createdTabs.length, capture ? 0 : 1);
    if (!capture) { assert.equal(h.createdTabs[0].active, false); assert.deepEqual(h.removedTabs, [2]); }
    assert.ok(!JSON.stringify(result).includes('observed-web-client'));
    assert.ok(!JSON.stringify(h.store).includes('observed-web-client'));
  }
});
test('observed headers replace earlier authentication and public asset tokens are never used for folder requests', async () => {
  const h = folderReader(); await h.learn(); h.replies.push({ body: list([]) });
  const native = { authorization: 'Bearer current-native', 'x-csrf-token': 'csrf-test', 'x-twitter-auth-type': 'NativeObserved', 'x-client-transaction-id': 'discard' };
  assert.equal((await h.window.__xOriginalBookmarkFolders('list', 'csrf-test', '', '', {}, '42', native)).ok, true);
  assert.equal(h.calls[0].init.headers.get('authorization'), 'Bearer current-native');
  assert.equal(h.calls[0].init.headers.get('x-twitter-auth-type'), 'NativeObserved');
  assert.equal(h.calls[0].init.headers.get('x-client-transaction-id'), null);
  const unknown = folderReader();
  unknown.document.scripts = [{ src: 'https://abs.twimg.com/responsive-web/client-web/bundle.BookmarkFolders.test.js' }];
  unknown.replies.push({ text: 'token="AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"; queryId:"LIST",operationName:"BookmarkFoldersSlice",metadata:{featureSwitches:[]}' });
  const result = await unknown.run('list'); assert.equal(result.ok, false);
  assert.equal(unknown.calls.filter(call => call.url.startsWith('https://x.com/i/api')).length, 0);
});
test('account switch during native authentication closes the temporary tab and never calls the folder reader', async () => {
  const { h, calls } = folderWorker(false);
  const create = h.chrome.tabs.create;
  h.chrome.tabs.create = async options => { const tab = await create(options); h.auth = 'other-login'; return tab; };
  const result = await h.request({ type: 'LIST_BOOKMARK_FOLDERS', tabId: 1 }, optionsSender);
  assert.equal(result.ok, false); assert.match(result.error, /アカウントが変わりました/);
  assert.deepEqual(h.removedTabs, [2]); assert.equal(calls.length, 0);
});
test('folder membership is read back for the exact post and positive mutation acknowledgment alone is insufficient', async () => {
  const h = folderReader(); await h.learn();
  h.replies.push({ body: { data: { bookmark_collection_tweet_put: 'Done' } } }, { body: list([{ id: '10', name: '資料', contains_requested_tweet: false }]) }, { body: list([{ id: '10', name: '資料', contains_requested_tweet: true }]) });
  const result = await h.run('add', '10', '202'); assert.equal(result.verified, true);
  assert.deepEqual(JSON.parse(new URL(h.calls[1].url).searchParams.get('variables')), { tweet_id: '202' });
  const missing = folderReader(); await missing.learn();
  missing.replies.push({ body: { data: { bookmark_collection_tweet_put: 'Done' } } }, ...Array.from({ length: 3 }, () => ({ body: list([{ id: '10', name: '資料', contains_requested_tweet: false }]) })));
  const failure = await missing.run('add', '10', '202'); assert.equal(failure.ok, false); assert.match(failure.error, /投稿を確認できません/);
});
test('folder registration waits for X native CreateBookmark commit and stops on a rejected optimistic bookmark', async () => {
  for (const accepted of [true, false]) {
    const h = folderReader(); await h.learn();
    let release;
    const wait = new Promise(resolve => { release = resolve; });
    h.replies.push({ wait, body: accepted ? { data: { tweet_bookmark_put: 'Done' } } : { errors: [{ message: 'denied' }] } });
    const native = h.window.fetch('https://x.com/i/api/graphql/CREATE/CreateBookmark', { method: 'POST', headers: h.headers, body: JSON.stringify({ variables: { tweet_id: '202' } }) });
    const registration = h.run('add', '10', '202'); await flush();
    assert.equal(h.calls.filter(call => /bookmarkTweetToFolder/.test(call.url)).length, 0);
    h.replies.push({ body: { data: { bookmark_collection_tweet_put: 'Done' } } }, { body: list([{ id: '10', name: '資料', contains_requested_tweet: true }]) });
    release(); await native;
    const result = await registration; assert.equal(result.ok, accepted);
    if (!accepted) assert.equal(h.calls.filter(call => /bookmarkTweetToFolder/.test(call.url)).length, 0);
  }
});
test('native slice_info pagination and general list never retain a picker tweet_id', async () => {
  const h = folderReader(); await h.learn();
  await h.window.fetch('https://x.com/i/api/graphql/LIST_NATIVE/BookmarkFoldersSlice?variables=' + encodeURIComponent(JSON.stringify({ tweet_id: '999' })), { headers: h.headers }); h.calls.length = 0;
  const first = list([{ id: '10', name: '資料' }]); first.data.viewer.user_results.result.bookmark_collections_slice.slice_info = { next_cursor: 'more' };
  h.replies.push({ body: first }, { body: list([{ id: '11', name: '画像' }]) });
  assert.equal((await h.run('list')).folders.length, 2);
  assert.equal(JSON.parse(new URL(h.calls[0].url).searchParams.get('variables')).tweet_id, undefined);
  assert.equal(JSON.parse(new URL(h.calls[1].url).searchParams.get('variables')).cursor, 'more');
});
test('account ID keeps the selection across relogin and migrates only the verified legacy session', async () => {
  const { h } = folderWorker();
  const oldGetCookies = h.chrome.cookies.getAll;
  h.chrome.cookies.getAll = async details => [...await oldGetCookies(details), { name: 'twid', value: 'u%3D42' }];
  const listed = await h.request({ type: 'LIST_BOOKMARK_FOLDERS', tabId: 1 }, optionsSender);
  assert.equal(listed.account, 'x-bookmark-account:0:42');
  await h.request({ type: 'SET_BOOKMARK_FOLDER', tabId: 1, account: listed.account, folderId: '10' }, optionsSender);
  h.auth = 'new-login-same-account';
  const saved = await h.request({ type: 'SPECIAL_SAVE_FOLDER', postId: '202' }, postSender);
  assert.equal(saved.ok, true); assert.equal(saved.configured, true);
  h.chrome.cookies.getAll = async details => [...await oldGetCookies(details), { name: 'twid', value: 'u%3D43' }];
  const other = await h.request({ type: 'SPECIAL_SAVE_FOLDER', postId: '202' }, postSender);
  assert.equal(other.configured, false);
});

test('membership verification finds the selected folder on a later slice page', async () => {
  const h = folderReader(); await h.learn();
  const first = list([{ id: '11', name: '他のフォルダ', contains_requested_tweet: false }]);
  first.data.viewer.user_results.result.bookmark_collections_slice.slice_info = { next_cursor: 'membership-next' };
  h.replies.push({ body: { data: { bookmark_collection_tweet_put: 'Done' } } }, { body: first }, { body: list([{ id: '10', name: '資料', contains_requested_tweet: true }]) });
  assert.equal((await h.run('add', '10', '202')).verified, true);
  assert.deepEqual(JSON.parse(new URL(h.calls.at(-1).url).searchParams.get('variables')), { tweet_id: '202', cursor: 'membership-next' });
});
test('legacy settings migrate automatically only from the currently verified login', async () => {
  const { h } = folderWorker();
  const legacy = await h.request({ type: 'LIST_BOOKMARK_FOLDERS', tabId: 1 }, optionsSender);
  h.store.specialSaveBookmarkFolders = { [legacy.account]: { id: '10', name: '資料' }, unrelated: { id: '999', name: '別ログイン' } };
  const oldGetCookies = h.chrome.cookies.getAll;
  h.chrome.cookies.getAll = async details => [...await oldGetCookies(details), { name: 'twid', value: 'u%3D42' }];
  const listed = await h.request({ type: 'LIST_BOOKMARK_FOLDERS', tabId: 1 }, optionsSender);
  assert.equal(listed.selected.id, '10'); assert.equal(h.store.specialSaveBookmarkFolders[legacy.account], undefined);
  assert.equal(h.store.specialSaveBookmarkFolders['x-bookmark-account:0:42'].id, '10');
  assert.equal(h.store.specialSaveBookmarkFolders.unrelated.id, '999');
});
