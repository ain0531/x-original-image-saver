const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const media = (id = 'IMAGE', size = 'small') =>
  `https://pbs.twimg.com/media/${id}?format=jpg&name=${size}`;
const flush = () => new Promise(resolve => setImmediate(resolve));

function harness(timers = {}) {
  let store = {};
  let messageListener;
  const listeners = new Set();
  const calls = [];
  const states = new Map();
  const chrome = {
    runtime: {
      id: 'test', getURL: path => `chrome-extension://test/${path}`,
      onMessage: { addListener: listener => { messageListener = listener; } },
    },
    tabs: { get: async () => ({ url: 'https://x.com/user/status/123' }) },
    storage: { local: {
      get: async () => structuredClone(store),
      set: async value => Object.assign(store, structuredClone(value)),
      remove: async keys => keys.forEach(key => delete store[key]),
    } },
    downloads: {
      onChanged: { addListener: l => listeners.add(l), removeListener: l => listeners.delete(l) },
      download: async options => {
        calls.push(options);
        const id = calls.length;
        states.set(id, { id, state: 'complete' });
        return id;
      },
      search: async ({ id }) => states.has(id) ? [states.get(id)] : [],
      cancel: async id => states.set(id, { id, state: 'interrupted', error: 'USER_CANCELED' }),
    },
  };
  const context = vm.createContext({
    chrome, URL, setTimeout, clearTimeout, setInterval, clearInterval, ...timers,
    console: { log() {}, warn() {}, error() {} },
  });
  vm.runInContext(fs.readFileSync('dist/background.js', 'utf8').replace(/export\s*\{\s*\};?/g, ''), context);
  return { context, chrome, calls, states, listeners,
    get store() { return store; }, set store(value) { store = value; },
    emit(id, state, error) {
      states.set(id, { id, state, error });
      for (const listener of [...listeners]) listener({ id, state: { current: state }, ...(error ? { error: { current: error } } : {}) });
    },
    request(message) {
      return new Promise(resolve => messageListener(message,
        { id: 'test', url: 'chrome-extension://test/popup.html' }, resolve));
    },
  };
}

test('normalizes legacy URLs and rejects foreign hosts and unsupported formats', () => {
  const { context: c } = harness();
  const parsed = c.parseMediaUrl('https://pbs.twimg.com/media/IMAGE.jpg:large');
  assert.equal(parsed.mediaId, 'IMAGE');
  assert.equal(parsed.format, 'jpg');
  assert.equal(parsed.origUrl, media('IMAGE', 'orig'));
  assert.equal(c.parseMediaUrl('https://example.com/?url=' + media()), null);
  assert.equal(c.parseMediaUrl('https://pbs.twimg.com/media/IMAGE?format=exe'), null);
});

test('deduplicates quality variants and records history when skipping is disabled', async () => {
  const h = harness();
  h.store = { savedMediaMap: { 'OLD|jpg': Date.now() } };
  const stats = await h.context.saveParsedMediaList(
    [media(), media('IMAGE', 'large')].map(h.context.parseMediaUrl), false,
    { skipPreviouslySaved: false });
  assert.equal(stats.total, 1);
  assert.equal(stats.success, 1);
  assert.equal(h.calls.length, 1);
  assert.ok(h.store.savedMediaMap['IMAGE|jpg']);
  assert.ok(h.store.savedMediaMap['OLD|jpg']);
});

test('does not count or record a pending download until complete', async () => {
  const h = harness();
  h.chrome.downloads.download = async options => {
    h.calls.push(options); h.states.set(1, { id: 1, state: 'in_progress' }); return 1;
  };
  let done = false;
  const pending = h.context.saveParsedMediaList([h.context.parseMediaUrl(media())], false)
    .then(stats => { done = true; return stats; });
  await flush();
  assert.equal(done, false);
  assert.equal(h.store.savedMediaMap, undefined);
  h.emit(1, 'complete');
  assert.equal((await pending).success, 1);
  assert.ok(h.store.savedMediaMap['IMAGE|jpg']);
  assert.equal(h.listeners.size, 0);
});

test('retries large after asynchronous orig failure', async () => {
  const h = harness();
  h.chrome.downloads.download = async options => {
    h.calls.push(options);
    const id = h.calls.length;
    h.states.set(id, { id, state: id === 1 ? 'in_progress' : 'complete' });
    return id;
  };
  const pending = h.context.saveParsedMediaList([h.context.parseMediaUrl(media())], false);
  await flush();
  h.emit(1, 'interrupted', 'NETWORK_FAILED');
  assert.equal((await pending).success, 1);
  assert.equal(h.calls.length, 2);
  assert.equal(new URL(h.calls[1].url).searchParams.get('name'), 'large');
});

test('failed candidates never become saved history', async () => {
  const h = harness();
  h.chrome.downloads.download = async options => {
    h.calls.push(options); const id = h.calls.length;
    h.states.set(id, { id, state: 'interrupted', error: 'SERVER_FAILED' }); return id;
  };
  const stats = await h.context.saveParsedMediaList([h.context.parseMediaUrl(media())], false);
  assert.equal(stats.failed, 1);
  assert.equal(stats.success, 0);
  assert.equal(h.store.savedMediaMap, undefined);
  assert.equal(h.listeners.size, 0);
});

test('cancellation does not retry or reopen Save As', async () => {
  const h = harness();
  h.chrome.downloads.download = async options => {
    h.calls.push(options); h.states.set(1, { id: 1, state: 'interrupted', error: 'USER_CANCELED' }); return 1;
  };
  const stats = await h.context.saveParsedMediaList([h.context.parseMediaUrl(media())], true);
  assert.equal(stats.failed, 1);
  assert.equal(h.calls.length, 1);
  h.calls.length = 0;
  h.chrome.downloads.download = async options => { h.calls.push(options); throw new Error('chooser closed'); };
  await h.context.saveParsedMediaList([h.context.parseMediaUrl(media())], true);
  assert.equal(h.calls.length, 1);
});

test('skips existing history and prunes expired records', async () => {
  const h = harness();
  h.store = { savedMediaMap: { 'IMAGE|jpg': Date.now(), 'OLD|jpg': 1 } };
  const stats = await h.context.saveParsedMediaList([h.context.parseMediaUrl(media())], false, { skipPreviouslySaved: true });
  assert.equal(stats.skipped, 1);
  assert.equal(h.calls.length, 0);
  assert.equal(h.store.savedMediaMap['OLD|jpg'], undefined);
});

function article(id, imageCount, top = 0) {
  return {
    getBoundingClientRect: () => ({ top, bottom: top + 200 }),
    querySelectorAll: selector => selector === 'img'
      ? Array.from({ length: imageCount }, (_, i) => ({ getAttribute: () => media(`${id}_${i}`) }))
      : [{ href: `https://x.com/user/status/${id}`, querySelector: () => ({}) }],
  };
}
function page(h, articles, pathname = '/user/status/123') {
  Object.assign(h.context, {
    document: { querySelectorAll: () => articles },
    location: { href: `https://x.com${pathname}`, pathname },
    window: { innerHeight: 800 },
  });
  h.chrome.scripting = { executeScript: async ({ func }) => [
    { result: vm.runInContext(`(${func.toString()})()`, h.context) },
  ] };
}

test('selects the URL post even when a reply has more images', async () => {
  const h = harness(); page(h, [article('999', 4), article('123', 1)]);
  const result = await h.context.getCurrentTweetMediaUrlsFromPage(1);
  assert.equal(result.selectedArticleIndex, 1);
  assert.equal(result.matchedMediaUrls.length, 1);
});

test('a target with no images does not download reply images', async () => {
  const h = harness(); page(h, [article('123', 0), article('999', 4)]);
  assert.equal((await h.context.getCurrentTweetMediaUrlsFromPage(1)).matchedMediaUrls.length, 0);
});

test('missing detail post reports an error instead of selecting another post', async () => {
  const h = harness(); page(h, [article('999', 4)]);
  await assert.rejects(h.context.getCurrentTweetMediaUrlsFromPage(1), /Could not identify/);
});

test('timeline selects first intersecting post, including one without images', async () => {
  const h = harness(); page(h, [article('1', 4, -400), article('2', 0, 50), article('3', 4, 300)], '/home');
  const result = await h.context.getCurrentTweetMediaUrlsFromPage(1);
  assert.equal(result.selectedArticleIndex, 1);
  assert.equal(result.matchedMediaUrls.length, 0);
});

test('scans after the final scroll and continues through text-only posts', async () => {
  const h = harness(); let position = 0;
  h.chrome.scripting = { executeScript: async ({ args }) => {
    if (args) {
      const beforeY = position; position++;
      return [{ result: { beforeY, afterY: position, nearBottom: false } }];
    }
    return [{ result: { pageUrl: 'https://x.com/home', matchedMediaUrls: position >= 4 ? [media()] : [] } }];
  } };
  const result = await h.context.autoScrollAndCollectVisibleMediaUrls(1, {
    maxRounds: 4, stableRoundsNeeded: 1, waitMsPerRound: 1,
  });
  assert.equal(result.rounds, 4);
  assert.equal(result.totalUniqueMediaUrls.length, 1);
});

test('bottom stability honors configured rounds', async () => {
  const h = harness(); let scrolls = 0;
  h.chrome.scripting = { executeScript: async ({ args }) => {
    if (args) { scrolls++; return [{ result: { beforeY: 0, afterY: 0, nearBottom: true } }]; }
    return [{ result: { pageUrl: 'https://x.com/home', matchedMediaUrls: [] } }];
  } };
  const result = await h.context.autoScrollAndCollectVisibleMediaUrls(1, {
    maxRounds: 10, stableRoundsNeeded: 4, waitMsPerRound: 1,
  });
  assert.equal(scrolls, 4);
  assert.equal(result.endedBy, 'near-bottom-and-stable');
});

test('rejects overlapping save and clear requests and unlocks after completion', async () => {
  const h = harness(); page(h, [article('123', 1)]);
  h.chrome.downloads.download = async options => {
    h.calls.push(options); h.states.set(1, { id: 1, state: 'in_progress' }); return 1;
  };
  const save = h.request({ type: 'SAVE_CURRENT_TWEET_IMAGES', tabId: 1 });
  await flush();
  const clear = await h.request({ type: 'CLEAR_SAVED_HISTORY' });
  assert.equal(clear.ok, false);
  assert.match(clear.error, /Another operation/);
  h.emit(1, 'complete');
  assert.equal((await save).ok, true);
  const cleared = await h.request({ type: 'CLEAR_SAVED_HISTORY' });
  assert.equal(cleared.ok, true);
  assert.equal(cleared.removed, 1);
  assert.equal(h.store.savedMediaMap, undefined);
});

test('unlock on error and verify actual tab URL', async () => {
  const h = harness();
  h.chrome.tabs.get = async () => ({ url: 'https://example.com/' });
  const response = await h.request({ type: 'SAVE_CURRENT_TWEET_IMAGES', tabId: 1, tabUrl: 'https://x.com/home' });
  assert.equal(response.ok, false);
  assert.match(response.error, /Open an X/);
  assert.equal((await h.request({ type: 'CLEAR_SAVED_HISTORY' })).ok, true);
});

test('timeout cancels the old transfer before a fallback starts', async () => {
  let timeout;
  const h = harness({
    setTimeout: callback => { timeout = callback; return 1; }, clearTimeout() {},
  });
  let canceled = false;
  h.chrome.downloads.download = async options => {
    h.calls.push(options); const id = h.calls.length;
    if (id === 2) assert.equal(canceled, true);
    h.states.set(id, { id, state: id === 1 ? 'in_progress' : 'complete' }); return id;
  };
  h.chrome.downloads.cancel = async id => {
    canceled = true; h.states.set(id, { id, state: 'interrupted' });
  };
  const pending = h.context.saveParsedMediaList([h.context.parseMediaUrl(media())], false);
  await flush(); timeout();
  assert.equal((await pending).success, 1);
  assert.equal(h.calls.length, 2);
  assert.equal(h.listeners.size, 0);
});

test('monitoring errors do not start overlapping transfers', async () => {
  const h = harness();
  h.chrome.downloads.search = async () => { throw new Error('API unavailable'); };
  const stats = await h.context.saveParsedMediaList([h.context.parseMediaUrl(media())], false);
  assert.equal(stats.failed, 1);
  assert.equal(h.calls.length, 1);
  assert.equal(h.listeners.size, 0);
});

test('page navigation aborts batch collection', async () => {
  const h = harness(); let scans = 0;
  h.chrome.scripting = { executeScript: async ({ args }) => {
    if (args) return [{ result: { beforeY: 0, afterY: 100, nearBottom: false } }];
    scans++;
    return [{ result: { pageUrl: `https://x.com/${scans === 1 ? 'home' : 'other'}`, matchedMediaUrls: [] } }];
  } };
  await assert.rejects(h.context.autoScrollAndCollectVisibleMediaUrls(1, { waitMsPerRound: 1 }), /page changed/);
});
