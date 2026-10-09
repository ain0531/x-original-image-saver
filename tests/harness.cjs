const fs = require('node:fs');
const vm = require('node:vm');
const flush = () => new Promise(resolve => setImmediate(resolve));
function harness(initial = {}) {
  let store = structuredClone(initial);
  let listener;
  let nextId = 1;
  const calls = [];
  const states = new Map();
  const injections = [];
  const scope = JSON.stringify(['https://x.com/i/history', 'ブックマーク', 'account']);
  const snap = { pageUrl: 'https://x.com/i/history', scope, documentId: 1, urls: [], posts: [], issues: [], loading: false, bottom: false, y: 0 };
  const backgroundSnap = structuredClone(snap);
  const createdTabs = []; const removedTabs = []; const liveTabs = new Set([1]);
  let backgroundAvailable = true;
  let networkAvailable = false;
  const pages = []; const cached = [];
  const downloadListeners = [];
  const session = {}; const directRequests = []; let auth = 'logged-in-account'; let csrf = 'csrf-test'; const requestObservers = [];
  const chrome = {
    extension: { inIncognitoContext: false },
    cookies: { getAllCookieStores: async () => [{ id: '0', tabIds: [1] }], getAll: async () => auth ? [{ name: 'auth_token', value: auth }, { name: 'ct0', value: csrf }] : [] },
    webRequest: { onBeforeSendHeaders: { addListener: callback => { requestObservers.push(callback); } } },
    runtime: { id: 'test', getURL: p => 'chrome-extension://test/' + p, onMessage: { addListener: l => listener = l } },
    sidePanel: { setPanelBehavior: async () => {} },
    alarms: { create: async () => {}, onAlarm: { addListener() {} } },
    tabs: {
      get: async id => { if (!liveTabs.has(id)) throw new Error('Tab closed'); return { id, windowId: 1, status: 'complete', url: (id === 1 ? snap : backgroundSnap).pageUrl }; },
      create: async options => { createdTabs.push(options); const id = createdTabs.length + 1; liveTabs.add(id); return { id, windowId: 1, url: options.url }; },
      remove: async id => { removedTabs.push(id); liveTabs.delete(id); },
    },
    scripting: { executeScript: async options => {
      injections.push(options);
      const targetSnap = options.target.tabId === 1 ? snap : backgroundSnap;
      if (!options.args) return [];
      if (options.world === 'MAIN' && Array.isArray(options.args[0])) return [{ result: { posts: cached } }];
      if (options.world === 'MAIN') return [{ result: { available: options.target.tabId === 1 ? networkAvailable : backgroundAvailable, scope: targetSnap.scope, documentId: targetSnap.documentId, ...(options.args[0] === 'page' ? { data: pages.shift() } : {}) } }];
      return [{ result: structuredClone(targetSnap) }];
    } },
    storage: { session: { get: async key => ({ [key]: structuredClone(session[key]) }), set: async rows => Object.assign(session, structuredClone(rows)), remove: async key => { delete session[key]; } }, local: {
      get: async keys => keys == null ? structuredClone(store) : Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter(k => k in store).map(k => [k, structuredClone(store[k])])),
      set: async values => Object.assign(store, structuredClone(values)),
      remove: async keys => { for (const k of Array.isArray(keys) ? keys : [keys]) delete store[k]; },
    } },
    downloads: {
      download: async options => { calls.push(options); const id = nextId++; states.set(id, { id, state: 'complete', exists: true, mime: options.url.startsWith('https://video.twimg.com/') ? 'video/mp4' : 'image/jpeg', url: options.url, finalUrl: options.url, startTime: new Date().toISOString() }); return id; },
      search: async query => [...states.values()].filter(item => query.id != null ? item.id === query.id : (!query.url || query.url === item.url) && (!query.urlRegex || new RegExp(query.urlRegex).test(item.url)) && (!query.startedAfter || item.startTime >= query.startedAfter)),
      cancel: async id => { states.get(id).state = 'interrupted'; states.get(id).error = 'USER_CANCELED'; },
      onChanged: { addListener: callback => downloadListeners.push(callback) },
    },
  };
  const fetch = async (raw, init) => {
    const u = new URL(raw); directRequests.push({ url: String(raw), init });
    if (u.pathname === '/i/bookmarks') return { ok: true, url: raw, text: async () => '<script src="https://abs.twimg.com/responsive-web/client-web/main.TEST.js"></script>' };
    if (u.hostname === 'abs.twimg.com') return { ok: true, text: async () => 'queryId:"TEST_QUERY",operationName:"Bookmarks",operationType:"query",metadata:{featureSwitches:[]} token="AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAATEST"' };
    const ids = snap.urls.map(raw => new URL(raw).pathname.match(/\/media\/([^?.]+)/)[1]);
    return { ok: true, json: async () => pages.length ? pages.shift() : page(ids) };
  };
  const context = vm.createContext({ chrome, fetch, crypto: require('node:crypto').webcrypto, TextEncoder, AbortController, URL, console, setTimeout, clearTimeout, setInterval, clearInterval });
  for (const name of ['media', 'preferences', 'history', 'bookmarks', 'sources', 'direct-bookmarks', 'direct-account-media', 'jobs', 'read-posts', 'bookmark-folders', 'background']) {
    const source = fs.readFileSync('dist/' + name + '.js', 'utf8').replace(/^import .*;\s*$/mg, '').replace(/\bexport (?=(?:async|class|function|const))/g, '').replace(/export\s*\{\s*\};?/g, '');
    vm.runInContext(source, context, { filename: name });
  }
  const request = (message, sender = { id: 'test', url: 'chrome-extension://test/sidepanel.html' }) => new Promise(resolve => listener(message, sender, resolve));
  return { context, chrome, calls, states, injections, snap, backgroundSnap, createdTabs, removedTabs, pages, cached, scope, directRequests, session, observe: details => requestObservers.forEach(observer => observer(details)), downloadChanged: id => downloadListeners.forEach(listener => listener({ id })), set auth(value) { auth = value; }, set csrf(value) { csrf = value; }, request, get store() { return store; }, set available(value) { networkAvailable = value; }, set backgroundAvailable(value) { backgroundAvailable = value; }, async done() {
    for (let n = 0; n < 200; n++) { await flush(); const status = await request({ type: 'GET_SAVE_STATUS' }); if (status.job?.status !== 'running' && !status.busy) return status; await new Promise(r => setTimeout(r, 5)); }
    throw new Error('Job did not finish');
  } };
}
function page(ids = [], cursor) {
  const entries = ids.map(id => ({ entryId: 'tweet-' + id, content: { itemContent: { tweet_results: { result: { rest_id: id, legacy: { extended_entities: { media: [{ type: 'photo', media_url_https: 'https://pbs.twimg.com/media/' + id + '.jpg' }] } } } } } } }));
  if (cursor) entries.push({ entryId: 'cursor-bottom', content: { cursorType: 'Bottom', value: cursor } });
  return { data: { bookmark_timeline_v2: { timeline: { instructions: [{ type: 'TimelineAddEntries', entries }] } } } };
}
function nativeBootstrap(h, data = page(['BOOTSTRAP'])) {
  h.chrome.cookies.getAllCookieStores = async () => [{ id: '0', tabIds: [1, 2, 3, 4] }];
  h.backgroundSnap.pageUrl = 'https://x.com/i/bookmarks';
  h.backgroundSnap.scope = JSON.stringify([h.backgroundSnap.pageUrl, '', 'account']);
  const create = h.chrome.tabs.create;
  h.chrome.tabs.create = async options => {
    const tab = await create(options);
    h.observe({ method: 'GET', tabId: tab.id, url: 'https://x.com/i/api/graphql/NATIVE_BOOTSTRAP/Bookmarks?variables=%7B%22count%22%3A20%7D&features=%7B%7D', requestHeaders: [{ name: 'authorization', value: 'Bearer native-bootstrap' }, { name: 'x-csrf-token', value: 'csrf-test' }] });
    return tab;
  };
  const inject = h.chrome.scripting.executeScript;
  h.chrome.scripting.executeScript = async options => {
    if (options.world === 'MAIN' && options.args?.[0] === 'bootstrap') {
      h.injections.push(options);
      return [{ result: { available: true, scope: h.backgroundSnap.scope, documentId: 2, data } }];
    }
    return inject(options);
  };
}
module.exports = { harness, page, flush, nativeBootstrap };

