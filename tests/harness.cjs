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
  let networkAvailable = false;
  const pages = []; const cached = [];
  const chrome = {
    runtime: { id: 'test', getURL: p => 'chrome-extension://test/' + p, onMessage: { addListener: l => listener = l } },
    sidePanel: { setPanelBehavior: async () => {} },
    alarms: { create: async () => {}, onAlarm: { addListener() {} } },
    tabs: { get: async () => ({ url: snap.pageUrl }) },
    scripting: { executeScript: async options => {
      injections.push(options);
      if (options.world === 'MAIN' && Array.isArray(options.args[0])) return [{ result: { posts: cached } }];
      if (options.world === 'MAIN') return [{ result: { available: networkAvailable, scope, documentId: 1, ...(options.args[0] === 'page' ? { data: pages.shift() } : {}) } }];
      return [{ result: structuredClone(snap) }];
    } },
    storage: { local: {
      get: async keys => keys == null ? structuredClone(store) : Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter(k => k in store).map(k => [k, structuredClone(store[k])])),
      set: async values => Object.assign(store, structuredClone(values)),
      remove: async keys => { for (const k of Array.isArray(keys) ? keys : [keys]) delete store[k]; },
    } },
    downloads: {
      download: async options => { calls.push(options); const id = nextId++; states.set(id, { id, state: 'complete', exists: true, mime: 'image/jpeg', url: options.url, finalUrl: options.url, startTime: new Date().toISOString() }); return id; },
      search: async query => [...states.values()].filter(item => query.id != null ? item.id === query.id : (!query.url || query.url === item.url) && (!query.urlRegex || new RegExp(query.urlRegex).test(item.url)) && (!query.startedAfter || item.startTime >= query.startedAfter)),
      cancel: async id => { states.get(id).state = 'interrupted'; states.get(id).error = 'USER_CANCELED'; },
    },
  };
  const context = vm.createContext({ chrome, URL, console, setTimeout, clearTimeout, setInterval, clearInterval });
  for (const name of ['media', 'history', 'bookmarks', 'sources', 'jobs', 'background']) {
    const source = fs.readFileSync('dist/' + name + '.js', 'utf8').replace(/^import .*;\s*$/mg, '').replace(/\bexport (?=(?:async|class|function|const))/g, '').replace(/export\s*\{\s*\};?/g, '');
    vm.runInContext(source, context, { filename: name });
  }
  const request = message => new Promise(resolve => listener(message, { id: 'test', url: 'chrome-extension://test/sidepanel.html' }, resolve));
  return { context, chrome, calls, states, injections, snap, pages, cached, scope, request, get store() { return store; }, set available(value) { networkAvailable = value; }, async done() {
    for (let n = 0; n < 200; n++) { await flush(); const status = await request({ type: 'GET_SAVE_STATUS' }); if (status.job?.status !== 'running' && !status.busy) return status; await new Promise(r => setTimeout(r, 5)); }
    throw new Error('Job did not finish');
  } };
}
function page(ids = [], cursor) {
  const entries = ids.map(id => ({ entryId: 'tweet-' + id, content: { itemContent: { tweet_results: { result: { rest_id: id, legacy: { extended_entities: { media: [{ type: 'photo', media_url_https: 'https://pbs.twimg.com/media/' + id + '.jpg' }] } } } } } } }));
  if (cursor) entries.push({ entryId: 'cursor-bottom', content: { cursorType: 'Bottom', value: cursor } });
  return { data: { bookmark_timeline_v2: { timeline: { instructions: [{ type: 'TimelineAddEntries', entries }] } } } };
}
module.exports = { harness, page, flush };

