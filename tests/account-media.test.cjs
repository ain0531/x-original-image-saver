const { test } = require('node:test');
const assert = require('node:assert/strict');
const { harness, page } = require('./harness.cjs');
const startAccount = h => h.request({ type: 'SAVE_ACCOUNT_MEDIA', tabId: 1 });
function accountPage(ids = [], cursor, userId = '42') {
  return { data: { user: { result: { rest_id: userId, timeline_v2: { timeline: page(ids, cursor).data.bookmark_timeline_v2.timeline } } } } };
}
function fixture({ photoOnly = false, observe = true } = {}) {
  const h = harness(); h.snap.pageUrl = 'https://x.com/alice/media' + (photoOnly ? '?filter=photo' : '');
  h.snap.urls = ['https://pbs.twimg.com/media/WRONG_DOM.jpg'];
  const requests = [], accountPages = [];
  const fetch = h.context.fetch;
  h.context.fetch = async (raw, init) => {
    const url = new URL(raw); const operation = url.pathname.split('/').pop();
    if (!['UserMedia', 'UserByScreenName'].includes(operation)) return fetch(raw, init);
    requests.push({ url: raw, init, operation, variables: JSON.parse(url.searchParams.get('variables')) });
    if (operation === 'UserByScreenName') return { ok: true, json: async () => ({ data: { user: { result: { rest_id: '42', core: { screen_name: 'alice' } } } } }) };
    return { ok: true, json: async () => accountPages.length ? accountPages.shift() : accountPage(['A']) };
  };
  function observeTemplates(tabId = 1, prefix = 'KNOWN') {
    for (const operation of ['UserByScreenName', 'UserMedia']) {
      const url = new URL(`https://x.com/i/api/graphql/${prefix}_${operation}/${operation}`);
      url.searchParams.set('variables', JSON.stringify(operation === 'UserMedia' ? { userId: '999', count: 37, cursor: 'old-cursor', withVoice: true } : { screen_name: 'alice', withSafetyModeUserFields: true }));
      url.searchParams.set('features', JSON.stringify({ native_feature: true }));
      url.searchParams.set('fieldToggles', JSON.stringify({ withArticlePlainText: false }));
      h.observe({ method: 'GET', tabId, url: url.toString(), requestHeaders: [{ name: 'authorization', value: 'Bearer native-account-token' }, { name: 'x-csrf-token', value: 'csrf-test' }] });
    }
  }
  if (observe) observeTemplates();
  function bootstrap() {
    h.chrome.cookies.getAllCookieStores = async () => [{ id: '0', tabIds: [1, 2] }];
    const create = h.chrome.tabs.create;
    h.chrome.tabs.create = async options => { h.backgroundSnap.pageUrl = options.url; const tab = await create(options); observeTemplates(tab.id, 'NATIVE'); return tab; };
  }
  return { h, requests, accountPages, observeTemplates, bootstrap };
}

test('account target accepts account pages and rejects X global routes', async () => {
  const h = harness();
  const target = h.context.accountMediaTarget;
  assert.equal(target('https://x.com/ALICE/media').url, 'https://x.com/alice/media');
  assert.equal(target('https://twitter.com/alice/media?filter=photo').photoOnly, true);
  for (const raw of ['https://x.com/alice', 'https://x.com/alice/status/123', 'https://x.com/alice/with_replies', 'https://x.com/alice/followers', 'https://x.com/alice/status/123/photo/2']) assert.equal(target(raw).url, 'https://x.com/alice/media');
  for (const raw of ['https://x.com/home', 'https://x.com/i/media', 'https://x.com/notifications', 'https://x.com/messages', 'https://x.com/compose/post', 'https://x.com/grok', 'https://example.com/alice/media', 'http://x.com/alice/media', 'https://x.com/alice/media?filter=video']) {
    assert.throws(() => target(raw)); h.snap.pageUrl = raw;
    assert.equal((await startAccount(h)).ok, false);
  }
  assert.equal(h.createdTabs.length, 0); assert.equal(h.calls.length, 0);
});

test('profile, posts and other account pages automatically use the media index without navigating them', async () => {
  for (const source of ['https://x.com/alice', 'https://x.com/alice/status/123/photo/1', 'https://x.com/alice/with_replies', 'https://x.com/alice/following']) {
    const { h, requests } = fixture(); h.snap.pageUrl = source;
    assert.equal((await startAccount(h)).ok, true); const result = await h.done();
    assert.equal(result.job.url, 'https://x.com/alice/media'); assert.equal(result.stats.success, 1);
    assert.equal(h.snap.pageUrl, source); assert.equal(h.createdTabs.length, 0);
    assert.equal(requests.filter(row => row.operation === 'UserMedia').length, 1);
  }
});

test('configuration error containing the login hint still initializes automatically from a profile', async () => {
  const { h, bootstrap } = fixture({ observe: false }); h.snap.pageUrl = 'https://x.com/alice'; bootstrap();
  const fetch = h.context.fetch;
  h.context.fetch = async (raw, init) => {
    if (raw === 'https://x.com/alice/media') return { ok: true, url: raw, text: async () => '<script src="https://abs.twimg.com/responsive-web/client-web/main.TEST.js"></script>' };
    if (raw.includes('abs.twimg.com')) return { ok: true, text: async () => 'queryId:"MEDIA",operationName:"UserMedia",metadata:{featureSwitches:["unknown_feature"]}' };
    return fetch(raw, init);
  };
  const result = await startAccount(h); assert.equal(result.ok, true, result.error);
  assert.equal((await h.done()).stats.success, 1);
  assert.equal(h.createdTabs[0].url, 'https://x.com/alice/media'); assert.deepEqual(h.removedTabs, [2]);
  assert.equal(h.snap.pageUrl, 'https://x.com/alice');
});

test('native feature values complete partial settings without a bootstrap tab', async () => {
  const { h } = fixture({ observe: false }); h.snap.pageUrl = 'https://x.com/alice';
  const route = new URL('https://x.com/i/api/graphql/NATIVE/UserMedia');
  route.searchParams.set('variables', JSON.stringify({ userId: '42', withVoice: true })); route.searchParams.set('features', '{"native_feature":true}');
  h.observe({ method: 'GET', tabId: 1, url: route.toString(), requestHeaders: [{ name: 'authorization', value: 'Bearer native-account-token' }, { name: 'x-csrf-token', value: 'csrf-test' }] });
  const fetch = h.context.fetch;
  h.context.fetch = async (raw, init) => {
    if (raw === 'https://x.com/alice/media') return { ok: true, url: raw, text: async () => '<script src="https://abs.twimg.com/responsive-web/client-web/main.TEST.js"></script>' };
    if (raw.includes('abs.twimg.com')) return { ok: true, text: async () => '{"operationName":"UserByScreenName","queryId":"LOOKUP","metadata":{"featureSwitches":["native_feature"]}}' };
    return fetch(raw, init);
  };
  const result = await startAccount(h); assert.equal(result.ok, true, result.error); await h.done();
  assert.equal(h.createdTabs.length, 0); assert.equal(h.calls.length, 1);
});

test('client discovery accepts quoted keys, reordered names and inline boolean feature values', async () => {
  const h = harness(); const values = h.context.featureValues('{"flag":true,"other":{"value":false}}');
  for (const js of ['{"queryId":"MEDIA","operationName":"UserMedia","metadata":{"featureSwitches":["flag","other"]}}', '{"operationName":"UserMedia","queryId":"MEDIA","metadata":{"featureSwitches":["flag","other"]}}']) {
    const config = h.context.clientBookmarkConfig(js, values, 'UserMedia');
    assert.equal(config.route, 'https://x.com/i/api/graphql/MEDIA/UserMedia'); assert.equal(config.features.flag, true); assert.equal(config.features.other, false);
  }
  assert.throws(() => h.context.clientBookmarkConfig('queryId:"MEDIA",operationName:"UserMedia",metadata:{featureSwitches:["unknown"]}', values, 'UserMedia'));
});

test('downvote compatibility value is narrow and observed values take precedence', () => {
  const h = harness(); const flag = 'rweb_conversational_replies_downvote_enabled';
  const source = `queryId:"MEDIA",operationName:"UserMedia",metadata:{featureSwitches:['${flag}']}`;
  assert.equal(h.context.clientBookmarkConfig(source, {}, 'UserMedia').features[flag], false);
  assert.equal(h.context.clientBookmarkConfig(source, { [flag]: true }, 'UserMedia').features[flag], true);
  assert.throws(() => h.context.clientBookmarkConfig(source.replace(flag, 'unknown_media_feature'), {}, 'UserMedia'), /unknown_media_feature/);
  const values = h.context.featureValues(`{${flag}:{value:!1}, other:{value:!0}, 'plain':false, expression:!0||secret}`);
  assert.equal(values[flag], false); assert.equal(values.other, true); assert.equal(values.plain, false); assert.equal(values.expression, undefined);
});

test('reported missing downvote feature proceeds to account pages without opening a tab', async () => {
  const { h, requests, accountPages } = fixture({ observe: false }); h.snap.pageUrl = 'https://x.com/alice';
  const fetch = h.context.fetch;
  h.context.fetch = async (raw, init) => {
    if (raw === 'https://x.com/alice/media') return { ok: true, url: raw, text: async () => '<script src="https://abs.twimg.com/responsive-web/client-web/main.TEST.js"></script>' };
    if (raw.includes('abs.twimg.com')) return { ok: true, text: async () => 'queryId:"MEDIA",operationName:"UserMedia",metadata:{featureSwitches:["rweb_conversational_replies_downvote_enabled"]};queryId:"LOOKUP",operationName:"UserByScreenName",metadata:{featureSwitches:[]} token="AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAATEST"' };
    return fetch(raw, init);
  };
  accountPages.push(accountPage(['A', 'B'], 'next'), accountPage(['C']));
  const result = await startAccount(h); assert.equal(result.ok, true, result.error);
  assert.equal((await h.done()).stats.success, 3); assert.equal(h.createdTabs.length, 0);
  assert.ok(requests.filter(row => row.operation === 'UserMedia').every(row => JSON.parse(new URL(row.url).searchParams.get('features')).rweb_conversational_replies_downvote_enabled === false));
});

test('feature defaults in a later client chunk resolve earlier operation metadata', async () => {
  const { h, requests } = fixture({ observe: false }); h.snap.pageUrl = 'https://x.com/alice';
  const fetch = h.context.fetch;
  h.context.fetch = async (raw, init) => {
    if (raw === 'https://x.com/alice/media') return { ok: true, url: raw, text: async () => Array.from({ length: 5 }, (_, i) => `<script src="https://abs.twimg.com/responsive-web/client-web/chunk.${i}.js"></script>`).join('') };
    if (raw.includes('abs.twimg.com')) return { ok: true, text: async () => raw.includes('chunk.0.') ? 'queryId:"MEDIA",operationName:"UserMedia",metadata:{featureSwitches:["client_only_flag"]};queryId:"LOOKUP",operationName:"UserByScreenName",metadata:{featureSwitches:[]} token="AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAATEST"' : raw.includes('chunk.4.') ? 'config={client_only_flag:{value:!1}}' : '' };
    return fetch(raw, init);
  };
  const result = await startAccount(h); assert.equal(result.ok, true, result.error); await h.done();
  assert.equal(h.createdTabs.length, 0); assert.equal(JSON.parse(new URL(requests.find(row => row.operation === 'UserMedia').url).searchParams.get('features')).client_only_flag, false);
});

test('account mode resolves its owner, paginates without scroll and preserves native settings', async () => {
  const { h, requests, accountPages } = fixture(); accountPages.push(accountPage(['A', 'B'], 'next'), accountPage(['C']));
  assert.equal((await startAccount(h)).ok, true); const result = await h.done();
  assert.equal(result.stats.success, 3); assert.equal(result.job.source, 'account'); assert.equal(result.job.rounds, 2);
  assert.equal(result.job.status, 'done'); assert.equal(result.job.url, 'https://x.com/alice/media');
  assert.equal(h.createdTabs.length, 0); assert.ok(h.injections.every(row => row.world === 'MAIN' && ['account-bootstrap', 'account-config'].includes(row.args[0])));
  assert.ok(h.calls.every(call => !call.url.includes('WRONG_DOM') && call.saveAs === false));
  const media = requests.filter(request => request.operation === 'UserMedia');
  assert.equal(media.length, 2); assert.equal(media[0].variables.userId, '42'); assert.equal(media[0].variables.count, 20);
  assert.equal(media[0].variables.cursor, undefined); assert.equal(media[1].variables.cursor, 'next');
  assert.equal(media[0].variables.withVoice, true);
  assert.equal(new URL(media[0].url).searchParams.get('features'), '{"native_feature":true}');
  assert.equal(new URL(media[0].url).searchParams.get('fieldToggles'), '{"withArticlePlainText":false}');
  assert.ok(!JSON.stringify(h.store).includes('native-account-token')); assert.ok(!JSON.stringify(result).includes('native-account-token'));
});

test('photo-only mode saves all photos but excludes videos, GIFs and quoted media', async () => {
  const { h, accountPages } = fixture({ photoOnly: true }); const body = accountPage(['A']);
  const tweet = body.data.user.result.timeline_v2.timeline.instructions[0].entries[0].content.itemContent.tweet_results.result;
  tweet.legacy.extended_entities.media.push({ type: 'photo', media_url_https: 'https://pbs.twimg.com/media/B.jpg' }, { type: 'video', id_str: '123', video_info: { variants: [{ content_type: 'application/x-mpegURL', url: 'https://video.twimg.com/a.m3u8' }] } });
  tweet.quoted_status_result = page(['QUOTE']).data.bookmark_timeline_v2.timeline.instructions[0].entries[0].content.itemContent.tweet_results;
  accountPages.push(body); await startAccount(h); const result = await h.done();
  assert.equal(result.stats.success, 2); assert.equal(result.job.status, 'done'); assert.equal(result.job.issues.length, 0);
  assert.ok(h.calls.every(call => !call.url.includes('QUOTE') && call.url.startsWith('https://pbs.twimg.com/')));
});

test('normal media mode saves multiple photos and the highest MP4, sharing ID deduplication', async () => {
  const { h, accountPages } = fixture(); const body = accountPage(['A']);
  body.data.user.result.timeline_v2.timeline.instructions[0].entries[0].content.itemContent.tweet_results.result.legacy.extended_entities.media.push({ type: 'video', id_str: '123', video_info: { variants: [{ bitrate: 10, content_type: 'video/mp4', url: 'https://video.twimg.com/ext_tw_video/123/pu/vid/low.mp4' }, { bitrate: 20, content_type: 'video/mp4', url: 'https://video.twimg.com/ext_tw_video/123/pu/vid/high.mp4' }] } });
  accountPages.push(body); await startAccount(h); assert.equal((await h.done()).stats.success, 2);
  assert.ok(h.calls.some(call => call.url.endsWith('high.mp4')));
  accountPages.push(body); await startAccount(h); assert.equal((await h.done()).stats.skipped, 2); assert.equal(h.calls.length, 2);
  h.pages.push(page(['A'])); await h.request({ type: 'SAVE_ALL_VISIBLE_IMAGES', tabId: 1 });
  assert.equal((await h.done()).stats.skipped, 1); assert.equal(h.calls.length, 2);
});

test('account page limit retains its cursor and resumes after the original tab closes', async () => {
  const { h, requests, accountPages } = fixture(); accountPages.push(accountPage(['A'], 'next'), accountPage(['B']));
  await h.request({ type: 'SAVE_ACCOUNT_MEDIA', tabId: 1, scrollSettings: { maxRounds: 1 } });
  const first = await h.done(); assert.equal(first.job.cursor, 'next'); assert.equal(first.job.endedBy, 'max-rounds');
  h.chrome.tabs.get = async () => { throw new Error('Closed'); };
  assert.equal((await h.request({ type: 'RESUME_SAVE' })).ok, true);
  assert.equal((await h.done()).stats.success, 2);
  assert.equal(requests.filter(row => row.operation === 'UserMedia')[1].variables.cursor, 'next');
  h.auth = 'different-account'; assert.equal((await h.request({ type: 'RESUME_SAVE' })).ok, false);
});

test('rate limits and login changes stop account preparation without downloading or opening tabs', async () => {
  for (const mode of ['rate', 'session']) {
    const { h } = fixture(); const fetch = h.context.fetch;
    h.context.fetch = async (raw, init) => {
      if (raw.includes('/UserMedia')) { if (mode === 'rate') return { ok: false, status: 429 }; h.auth = 'changed'; }
      return fetch(raw, init);
    };
    assert.equal((await startAccount(h)).ok, false); assert.equal(h.calls.length, 0); assert.equal(h.createdTabs.length, 0);
  }
});

test('unknown client learns from one inactive account tab and closes it after communication', async () => {
  const { h, requests, bootstrap } = fixture({ observe: false }); bootstrap();
  const fetch = h.context.fetch;
  h.context.fetch = async (raw, init) => {
    const response = await fetch(raw, init);
    if (raw.includes('/UserMedia')) {
      const json = response.json; response.json = async () => { assert.equal(h.removedTabs.length, 0); return json(); };
    }
    return response;
  };
  assert.equal((await startAccount(h)).ok, true); assert.equal((await h.done()).stats.success, 1);
  assert.equal(h.createdTabs[0].url, 'https://x.com/alice/media'); assert.equal(h.createdTabs[0].active, false);
  assert.deepEqual(h.removedTabs, [2]); assert.equal(h.session.accountMediaBootstrapTab, undefined);
  assert.ok(requests.some(row => row.url.includes('NATIVE_UserMedia')));
});

test('unknown account response never falls back to DOM media and closes its initialization tab', async () => {
  const { h, accountPages, bootstrap } = fixture({ observe: false }); bootstrap();
  accountPages.push({ data: { home: {} } });
  const result = await startAccount(h); assert.equal(result.ok, false); assert.match(result.error, /ユーザー応答/); assert.doesNotMatch(result.error, /30秒/);
  assert.equal(h.calls.length, 0); assert.deepEqual(h.removedTabs, [2]);
});

test('account bootstrap timeout closes only its owned tab', async () => {
  const { h } = fixture({ observe: false }); h.backgroundSnap.pageUrl = h.snap.pageUrl;
  let now = Date.now(); h.context.Date = class extends Date { static now() { return now; } };
  h.context.setTimeout = (callback, ms) => { now += ms; return setImmediate(callback); }; h.context.clearTimeout = clearImmediate;
  const result = await startAccount(h); assert.equal(result.ok, false); assert.match(result.error, /30秒/);
  assert.match(result.error, /直接取得のエラー/);
  assert.deepEqual(h.removedTabs, [2]); assert.equal(h.calls.length, 0);
});

test('a learned initialization is reused and later access failures do not repeatedly create tabs', async () => {
  const { h, bootstrap } = fixture({ observe: false }); bootstrap();
  await startAccount(h); await h.done(); assert.equal(h.createdTabs.length, 1);
  const fetch = h.context.fetch;
  h.context.fetch = async (raw, init) => raw.includes('/UserMedia') ? { ok: false, status: 403 } : fetch(raw, init);
  assert.equal((await startAccount(h)).ok, false); assert.equal(h.createdTabs.length, 1); assert.equal(h.calls.length, 1);
});

test('a page change during account preparation cannot save the previously selected target', async () => {
  const { h } = fixture(); const fetch = h.context.fetch;
  h.context.fetch = async (raw, init) => { const response = await fetch(raw, init); if (raw.includes('/UserMedia')) h.snap.pageUrl = 'https://x.com/bob/media'; return response; };
  const result = await startAccount(h); assert.equal(result.ok, false); assert.match(result.error, /ページが変わりました/);
  assert.equal(h.calls.length, 0); assert.equal(h.store.imageSaveJob, undefined);
});

test('media parsing rejects a different owner, recommendations and unknown timelines', async () => {
  const h = harness(); const parse = h.context.parseAccountMediaPage;
  assert.throws(() => parse(accountPage(['WRONG'], undefined, '99'), '42', false), /アカウントID/);
  assert.throws(() => parse(page(['BOOKMARK']), '42', false));
  assert.throws(() => parse({ data: { user: { result: { rest_id: '42', home: { instructions: [] } } } } }, '42', false), /応答形式/);
  assert.throws(() => parse({ errors: [{ message: 'denied' }] }, '42', false));
});

test('an ID-less media response requires the verified direct request ID', () => {
  const h = harness(); const parse = h.context.parseAccountMediaPage;
  const body = accountPage(['A']); delete body.data.user.result.rest_id;
  assert.equal(parse(body, '42', false, '42').media.length, 1);
  assert.throws(() => parse(body, '42', false), /アカウントIDがなく/);
  assert.throws(() => parse(body, '42', false, '99'), /アカウントIDがなく/);
  assert.throws(() => parse(body, 'invalid', false, 'invalid'), /保存対象/);
  for (const value of ['99', null, '', 42]) {
    body.data.user.result.rest_id = value;
    assert.throws(() => parse(body, '42', false, '42'), /アカウントIDが一致しません/);
  }
  assert.throws(() => parse({ data: { user: { result: { __typename: 'UserUnavailable' } } } }, '42', false, '42'), /取得不能/);
  assert.throws(() => parse({ data: { user: { result: {} } } }, '42', false, '42'), /応答形式/);
});

test('direct account pagination saves ID-less first and continuation pages without a bootstrap tab', async () => {
  const { h, accountPages, requests } = fixture();
  const first = accountPage(['A', 'B'], 'next'), second = accountPage(['C']);
  delete first.data.user.result.rest_id; delete second.data.user.result.rest_id;
  first.data.user.result.__typename = 'User'; second.data.user.result.__typename = 'User';
  accountPages.push(first, second);
  const start = await startAccount(h); assert.equal(start.ok, true, start.error);
  const done = await h.done(); assert.equal(done.stats.success, 3); assert.equal(done.job.rounds, 2);
  assert.equal(h.createdTabs.length, 0);
  assert.ok(requests.filter(row => row.operation === 'UserMedia').every(row => row.variables.userId === '42'));
});

test('a genuine account mismatch stops immediately and reports both IDs', async () => {
  const { h, accountPages } = fixture(); accountPages.push(accountPage(['WRONG'], undefined, '99'));
  const start = await startAccount(h); assert.equal(start.ok, false);
  assert.match(start.error, /対象: 42、応答: 99/); assert.doesNotMatch(start.error, /30秒/);
  assert.equal(h.createdTabs.length, 0); assert.equal(h.calls.length, 0);
});

test('an ID-less response with a different account name is rejected', async () => {
  const { h, accountPages } = fixture(); const body = accountPage(['WRONG']);
  delete body.data.user.result.rest_id; body.data.user.result.core = { screen_name: 'bob' }; accountPages.push(body);
  const start = await startAccount(h); assert.equal(start.ok, false); assert.match(start.error, /アカウント名/);
  assert.equal(h.createdTabs.length, 0); assert.equal(h.calls.length, 0);
});

test('next account page is collected while up to four file transfers are running', async () => {
  const { h, requests, accountPages } = fixture(); accountPages.push(accountPage(['A', 'B', 'C', 'D'], 'next'), accountPage(['E']));
  let release; const gate = new Promise(resolve => { release = resolve; }); let starts = 0;
  const download = h.chrome.downloads.download;
  h.chrome.downloads.download = async options => { starts++; await gate; return download(options); };
  await startAccount(h);
  for (let n = 0; n < 100 && starts < 4; n++) await new Promise(resolve => setTimeout(resolve, 5));
  const collected = requests.filter(row => row.operation === 'UserMedia').length;
  release();
  assert.equal(starts, 4); assert.equal(collected, 2);
  assert.equal((await h.done()).stats.success, 5);
});

for (const method of ['GET', 'POST']) test(`native ${method} media response starts without an owner lookup and replays only the next page`, async () => {
  const { h } = fixture({ observe: false }); h.snap.pageUrl = 'https://x.com/alice';
  h.chrome.cookies.getAllCookieStores = async () => [{ id: '0', tabIds: [1, 2] }];
  const variables = { userId: '42', count: 20, withVoice: true };
  const route = new URL('https://x.com/i/api/graphql/NATIVE_ONLY/UserMedia');
  if (method === 'GET') { route.searchParams.set('variables', JSON.stringify(variables)); route.searchParams.set('features', '{"native_feature":true}'); }
  const create = h.chrome.tabs.create;
  h.chrome.tabs.create = async options => {
    h.backgroundSnap.pageUrl = options.url;
    const tab = await create(options);
    h.observe({ method, tabId: tab.id, url: route.toString(), requestHeaders: [{ name: 'authorization', value: 'Bearer native-only-token' }] });
    return tab;
  };
  const inject = h.chrome.scripting.executeScript;
  h.chrome.scripting.executeScript = async options => options.world === 'MAIN' && options.args?.[0] === 'account-bootstrap' && options.target.tabId === 2 ? [{ result: { available: true, userId: '42', request: { url: route.toString(), method, variables, features: { native_feature: true }, fieldToggles: { withArticlePlainText: false } }, data: accountPage(['A'], 'next') } }] : inject(options);
  const fetch = h.context.fetch; const subsequent = [];
  h.context.fetch = async (raw, init) => {
    if (raw.includes('/UserByScreenName')) throw new Error('Owner lookup must not be required');
    if (!raw.includes('/UserMedia')) return fetch(raw, init);
    const payload = method === 'POST' ? JSON.parse(init.body) : { variables: JSON.parse(new URL(raw).searchParams.get('variables')) };
    subsequent.push({ init, payload }); return { ok: true, json: async () => accountPage(['B']) };
  };
  const start = await startAccount(h); assert.equal(start.ok, true, start.error);
  const done = await h.done(); assert.equal(done.stats.success, 2); assert.equal(subsequent.length, 1);
  assert.equal(subsequent[0].payload.variables.cursor, 'next'); assert.equal(subsequent[0].payload.variables.userId, '42');
  assert.equal(subsequent[0].init.method, method);
  if (method === 'POST') assert.equal(subsequent[0].payload.features.native_feature, true);
  assert.deepEqual(h.removedTabs, [2]); assert.equal(h.snap.pageUrl, 'https://x.com/alice');
  assert.ok(!JSON.stringify(h.store).includes('native-only-token'));
  assert.equal((await startAccount(h)).ok, true); await h.done();
  assert.equal(h.createdTabs.length, 1); assert.equal(subsequent.length, 2);
  assert.equal(subsequent[1].payload.variables.cursor, undefined);
});

test('account discovery reuses the bookmark login and feature values without a native media request', async () => {
  const { h, requests, accountPages } = fixture({ observe: false }); h.snap.pageUrl = 'https://x.com/alice';
  h.observe({ method: 'GET', tabId: 1, url: 'https://x.com/i/api/graphql/BOOKMARK_ONLY/Bookmarks?features={"shared_flag":true}', requestHeaders: [{ name: 'authorization', value: 'Bearer bookmark-only-token' }, { name: 'x-csrf-token', value: 'csrf-test' }] });
  const fetch = h.context.fetch;
  h.context.fetch = async (raw, init) => {
    if (raw === 'https://x.com/alice/media') return { ok: true, url: raw, text: async () => '<script src="https://abs.twimg.com/responsive-web/client-web/main.ACCOUNT.js"></script>' };
    if (raw.includes('abs.twimg.com')) return { ok: true, text: async () => 'queryId:"MEDIA",operationName:"UserMedia",metadata:{featureSwitches:["shared_flag"]};queryId:"LOOKUP",operationName:"UserByScreenName",metadata:{featureSwitches:["shared_flag"]}' };
    return fetch(raw, init);
  };
  accountPages.push(accountPage(['A'], 'next'), accountPage(['B']));
  const started = await startAccount(h); assert.equal(started.ok, true, started.error); assert.equal((await h.done()).stats.success, 2);
  assert.equal(h.createdTabs.length, 0); assert.equal(requests.length, 3);
  assert.ok(requests.every(row => row.init.headers.authorization === 'Bearer bookmark-only-token'));
  assert.ok(requests.every(row => JSON.parse(new URL(row.url).searchParams.get('features')).shared_flag));
  assert.ok(!JSON.stringify(h.store).includes('bookmark-only-token'));
});

for (const temporary of [false, true]) test(`loaded client chunks provide missing media routes with ${temporary ? 'one temporary' : 'no'} tab and no native media response`, async () => {
  const { h, requests } = fixture({ observe: false }); h.snap.pageUrl = 'https://x.com/alice';
  h.chrome.cookies.getAllCookieStores = async () => [{ id: '0', tabIds: [1, 2] }];
  h.observe({ method: 'GET', tabId: 1, url: 'https://x.com/i/api/graphql/BOOKMARK_ONLY/Bookmarks?features={"live_flag":false}', requestHeaders: [{ name: 'authorization', value: 'Bearer bookmark-only-token' }, { name: 'x-csrf-token', value: 'csrf-test' }] });
  const assets = [...Array.from({ length: 8 }, (_, i) => `https://abs.twimg.com/responsive-web/client-web/chunk.${i}.js`), 'https://abs.twimg.com/responsive-web/client-web/chunk.MEDIA.js', 'https://evil.invalid/code.js'];
  const inject = h.chrome.scripting.executeScript;
  h.chrome.scripting.executeScript = async options => options.args?.[0] === 'account-config' && options.target.tabId === (temporary ? 2 : 1) ? [{ result: { pageUrl: options.target.tabId === 1 ? h.snap.pageUrl : h.backgroundSnap.pageUrl, features: { live_flag: true }, assets } }] : inject(options);
  const create = h.chrome.tabs.create;
  h.chrome.tabs.create = async options => { h.backgroundSnap.pageUrl = options.url; return create(options); };
  const fetch = h.context.fetch; const assetRequests = [];
  h.context.fetch = async (raw, init) => {
    if (raw === 'https://x.com/alice/media') return { ok: true, url: raw, text: async () => '<script src="https://abs.twimg.com/responsive-web/client-web/main.EMPTY.js"></script>' };
    if (raw.includes('abs.twimg.com')) { assetRequests.push(raw); return { ok: true, text: async () => raw.includes('chunk.MEDIA') ? 'queryId:"MEDIA",operationName:"UserMedia",metadata:{featureSwitches:["live_flag"]};queryId:"LOOKUP",operationName:"UserByScreenName",metadata:{featureSwitches:["live_flag"]}' : 'no route' }; }
    assert.ok(!raw.includes('evil.invalid')); return fetch(raw, init);
  };
  const started = await startAccount(h); assert.equal(started.ok, true, started.error);
  assert.equal((await h.done()).stats.success, 1); assert.equal(h.createdTabs.length, temporary ? 1 : 0);
  assert.deepEqual(h.removedTabs, temporary ? [2] : []); assert.equal(h.snap.pageUrl, 'https://x.com/alice');
  assert.ok(assetRequests.some(raw => raw.includes('chunk.MEDIA')));
  assert.ok(requests.every(row => JSON.parse(new URL(row.url).searchParams.get('features')).live_flag === true));
});
