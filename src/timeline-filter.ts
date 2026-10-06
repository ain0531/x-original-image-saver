// Runs in the page's MAIN world. Removes read posts from X's home timeline responses before
// X renders them, so hiding never happens inside the visible area. The read list arrives from
// the isolated unread-filter script through window.postMessage. Posts read on this page that are
// released on returning to the top are removed from X's own list with TimelineRemoveEntries on the
// next timeline response, so X stops redrawing them (hiding them one by one stalled scrolling).
(() => {
  const host = window as any;
  if (host.__xOriginalTimelineFilter) return;
  host.__xOriginalTimelineFilter = true;
  const BRIDGE = '__xOriginalUnread';
  const STATE_WAIT = 1500;
  // Set by unread-filter while the filter is on. Only then does the first response of a page
  // wait for the read list; while off, nothing is delayed or parsed.
  const ON_FLAG = '__xOriginalUnreadOn';
  let wasOn = false;
  try { wasOn = sessionStorage.getItem(ON_FLAG) === '1'; } catch { /* Storage may be blocked. */ }
  let enabled = false;
  let received = false;
  const read = new Set<string>();
  const released = new Set<string>();
  // Entries X has received: entry ID -> post IDs of each post in it (a repost also by its original).
  const delivered = new Map<string, string[][]>();
  const MAX_DELIVERED = 5000;
  let markReady: () => void = () => {};
  const ready = new Promise<void>(resolve => { markReady = resolve; });
  window.addEventListener('message', event => {
    const data = event.data;
    if (event.origin !== location.origin || !data || data[BRIDGE] !== true) return;
    received = true;
    if (typeof data.enabled === 'boolean') {
      enabled = data.enabled;
      if (!enabled) { read.clear(); released.clear(); delivered.clear(); }
    }
    if (Array.isArray(data.release)) for (const id of data.release) if (typeof id === 'string' && /^\d+$/.test(id)) released.add(id);
    if (Array.isArray(data.ids)) for (const id of data.ids) if (typeof id === 'string' && /^\d+$/.test(id)) read.add(id);
    markReady();
  });
  const isHomeTimeline = (raw: string) => {
    try { const url = new URL(raw, location.href); return url.origin === location.origin && /^\/i\/api\/graphql\/[^/]+\/(HomeTimeline|HomeLatestTimeline)$/.test(url.pathname); }
    catch { return false; }
  };
  const tweet = (result: any) => result?.__typename === 'TweetWithVisibilityResults' ? result.tweet : result;
  // The DOM records a repost under the original post's ID, so check both.
  const postIds = (content: any): string[] => {
    const result = tweet(content?.itemContent?.tweet_results?.result);
    const original = tweet(result?.legacy?.retweeted_status_result?.result);
    return [result?.rest_id, original?.rest_id].filter((id): id is string => typeof id === 'string');
  };
  const isRead = (content: any) => postIds(content).some(id => read.has(id));
  // Returns the number of removed entries. Entries are removed whole: X keeps the post IDs of
  // a conversation module in its metadata, so a module is dropped only when every post is read.
  // A page is never emptied of posts, or X stops loading; its last read entry is kept instead.
  const filter = (body: any): number => {
    const instructions = body?.data?.home?.home_timeline_urt?.instructions;
    if (!Array.isArray(instructions)) return 0;
    let removed = 0, kept = 0;
    let lastRemoved: { list: any[]; at: number; entry: any } | undefined;
    // Released entries X already holds are dropped from its list before new ones are recorded.
    const gone: string[] = [];
    if (released.size) for (const [entryId, posts] of delivered) {
      if (posts.every(ids => ids.some(id => released.has(id)))) { gone.push(entryId); delivered.delete(entryId); }
    }
    for (const instruction of instructions) {
      if (instruction?.type !== 'TimelineAddEntries' || !Array.isArray(instruction.entries)) continue;
      const next: any[] = [];
      for (const entry of instruction.entries) {
        const content = entry?.content;
        const posts = (Array.isArray(content?.items) ? content.items.map((item: any) => item?.item) : [content])
          .filter((post: any) => post?.itemContent?.tweet_results?.result);
        if (!posts.length) { next.push(entry); continue; }
        if (posts.every(isRead)) { removed++; lastRemoved = { list: next, at: next.length, entry }; continue; }
        kept++; next.push(entry);
      }
      instruction.entries = next;
    }
    if (removed && !kept && lastRemoved) { lastRemoved.list.splice(lastRemoved.at, 0, lastRemoved.entry); removed--; }
    for (const instruction of instructions) {
      if (instruction?.type !== 'TimelineAddEntries' || !Array.isArray(instruction.entries)) continue;
      for (const entry of instruction.entries) {
        const content = entry?.content;
        const posts = (Array.isArray(content?.items) ? content.items.map((item: any) => item?.item) : [content]).map(postIds).filter((ids: string[]) => ids.length);
        if (typeof entry?.entryId === 'string' && posts.length) { delivered.delete(entry.entryId); delivered.set(entry.entryId, posts); }
      }
    }
    while (delivered.size > MAX_DELIVERED) delivered.delete(delivered.keys().next().value!);
    if (gone.length) instructions.push({ type: 'TimelineRemoveEntries', entryIds: gone });
    return removed + gone.length;
  };
  const active = () => enabled && read.size > 0 && location.pathname === '/home';
  const nativeFetch = window.fetch;
  window.fetch = async function(this: unknown, input: RequestInfo | URL, init?: RequestInit) {
    const response = await nativeFetch.call(this, input, init);
    if (!response.ok || (!enabled && (received || !wasOn))) return response;
    const url = input instanceof Request ? input.url : String(input);
    if (!isHomeTimeline(url)) return response;
    try {
      // The read list loads asynchronously at page start; wait briefly for it.
      if (!received) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([ready, new Promise<void>(resolve => { timer = setTimeout(resolve, STATE_WAIT); })]);
        clearTimeout(timer);
      }
      if (!active()) return response;
      const body = await response.clone().json();
      if (!filter(body)) return response;
      const filtered = new Response(JSON.stringify(body), { status: response.status, statusText: response.statusText, headers: response.headers });
      Object.defineProperty(filtered, 'url', { value: response.url });
      return filtered;
    } catch { return response; }
  };
  // X loads the home timeline with XMLHttpRequest. Its response is read synchronously, so at page
  // start (filter on, list not yet arrived) the request itself is held until the list arrives.
  const open = XMLHttpRequest.prototype.open;
  const send = XMLHttpRequest.prototype.send;
  const abort = XMLHttpRequest.prototype.abort;
  const generation = new WeakMap<XMLHttpRequest, number>();
  const held = new WeakSet<XMLHttpRequest>();
  const nextGeneration = (xhr: XMLHttpRequest) => { generation.set(xhr, (generation.get(xhr) ?? 0) + 1); held.delete(xhr); };
  const textGetter = Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, 'responseText')!.get!;
  const responseGetter = Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, 'response')!.get!;
  XMLHttpRequest.prototype.open = function(this: XMLHttpRequest, method: string, url: string | URL, ...args: any[]) {
    delete (this as any).responseText; delete (this as any).response;
    nextGeneration(this);
    const waiting = !received && wasOn;
    if ((enabled || waiting) && isHomeTimeline(String(url))) {
      if (waiting) held.add(this);
      let cached: { text: string; json: unknown } | undefined;
      let done = false;
      // The body is parsed at most once, and only while the filter is active.
      const result = (): typeof cached => {
        if (done || this.readyState !== 4 || this.status < 200 || this.status >= 300 || !active()) return cached;
        done = true;
        try {
          const raw = this.responseType === 'json' ? responseGetter.call(this) : textGetter.call(this);
          const body = typeof raw === 'string' ? JSON.parse(raw) : structuredClone(raw);
          if (active() && filter(body)) cached = { text: JSON.stringify(body), json: body };
        } catch { /* An unreadable response is passed through unchanged. */ }
        return cached;
      };
      Object.defineProperty(this, 'responseText', { configurable: true, get: () => result()?.text ?? textGetter.call(this) });
      Object.defineProperty(this, 'response', { configurable: true, get: () => {
        const value = result();
        if (!value) return responseGetter.call(this);
        return this.responseType === 'json' ? value.json : this.responseType === '' || this.responseType === 'text' ? value.text : responseGetter.call(this);
      } });
    }
    return (open as any).call(this, method, url, ...args);
  };
  XMLHttpRequest.prototype.send = function(this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
    if (!held.has(this) || received) { held.delete(this); return send.call(this, body); }
    held.delete(this);
    const current = generation.get(this);
    let timer: ReturnType<typeof setTimeout> | undefined;
    void Promise.race([ready, new Promise<void>(resolve => { timer = setTimeout(resolve, STATE_WAIT); })]).then(() => {
      clearTimeout(timer);
      // Skip if X aborted or reopened the request while it was held.
      if (generation.get(this) !== current || this.readyState !== XMLHttpRequest.OPENED) return;
      try { send.call(this, body); } catch { /* The request is no longer sendable. */ }
    });
  };
  XMLHttpRequest.prototype.abort = function(this: XMLHttpRequest) {
    nextGeneration(this);
    return abort.call(this);
  };
})();
