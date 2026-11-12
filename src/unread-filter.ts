// Unread-only filter for the home timeline and the search "Top" tab. A post becomes read when
// shown for 0.5s, or when it was on screen and then scrolled past the top (quick skimming). The read list is
// passed to timeline-filter (MAIN world), which drops read posts from X's timeline responses
// before they are rendered. Posts read on this page stay in X's own list and are not hidden while
// scrolling back; on home, returning to the very top releases them so they are hidden from then on.
// Search results are not released while staying on the page: X ignores the removal there, and
// hiding them one by one in the DOM stalls scrolling. They are left out from the next search.
// Once a target page is left (and X redraws it from its cache, as Back does without refetching),
// the posts read there are released on both home and search, and everything read is hidden as X
// draws it, even on screen, during a short window after arriving. A page opened over the
// timeline (photo viewer, composer) is not a leave: X keeps the timeline, so nothing is released.
// Posts already painted are only hidden below the visible area, so what is on screen never moves.
(() => {
  const instance = globalThis as any;
  if (instance.__xOriginalUnreadFilter) return;
  instance.__xOriginalUnreadFilter = true;
  const hiddenMarker = 'data-x-original-unread-hidden';
  const READ_DELAY = 500;
  // After arriving at a target page, X draws it in one go (from its cache on Back, restoring the
  // scroll position); read posts drawn in this window are hidden even on screen, before paint.
  const ARRIVAL_WINDOW = 1000;
  // X's in-timeline "N件のポストを表示" bar. The floating "posted" pill is not matched.
  const NEW_POSTS_LABEL = /^(?:[\d,.]+\s*件の(?:ポスト|ツイート)を表示|Show\s+[\d,.]+[KM]?\s+(?:posts?|Tweets?))$/i;
  let lastExpand = 0;
  let awayFromTop = false;
  let stopped = false;
  let enabled = false;
  let scheduled: ReturnType<typeof setTimeout> | undefined;
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  let evaluated = new WeakMap<Element, string>();
  const read = new Set<string>();
  const readHere = new Set<string>();
  let lastPage = pageKey();
  let lastOnTarget = onTarget();
  // A timeline article seen on the target page, and the page left while it was there: coming back
  // to that page with the article still attached means an overlay was closed, not a redraw.
  let anchor: Element | undefined;
  let leftPage: string | undefined;
  let arrivedAt = 0;
  const pending = new Set<string>();
  const watched = new Set<Element>();
  const appeared = new WeakSet<Element>();
  const readTimers = new Map<Element, ReturnType<typeof setTimeout>>();
  const visibility = new IntersectionObserver(onVisibility, { threshold: [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1] });
  const observer = new MutationObserver(onMutations);
  const timer = setInterval(() => { if (!alive()) cleanup(); }, 1000);
  function alive(): boolean {
    try { return !!chrome.runtime.id && !!chrome.runtime.getManifest(); }
    catch { return false; }
  }
  function onHome(): boolean { return location.pathname === '/home'; }
  function onSearchTop(): boolean {
    const tab = new URL(location.href).searchParams.get('f');
    return location.pathname === '/search' && (tab === null || tab === 'top');
  }
  function onTarget(): boolean { return onHome() || onSearchTop(); }
  function pageKey(): string { const url = new URL(location.href); return url.pathname + url.search; }
  // Arriving at a target page after leaving one releases the posts read there and opens the arrival
  // window. Returning from a non-target page with the timeline still attached is an overlay closing.
  function checkPage(): void {
    const page = pageKey();
    if (page === lastPage) return;
    const previous = lastPage, wasTarget = lastOnTarget;
    lastPage = page; lastOnTarget = onTarget();
    if (!lastOnTarget) { if (wasTarget) leftPage = previous; return; }
    const overlay = leftPage === page && !!anchor?.isConnected;
    leftPage = undefined;
    if (overlay) return;
    releaseOnLeave();
    arrivedAt = Date.now();
  }
  function releaseOnLeave(): void {
    if (readHere.size) bridge({ release: Array.from(readHere) });
    readHere.clear();
  }
  function postId(article: Element): string | undefined {
    const link = Array.from(article.querySelectorAll('a[href]')).find(link => link.querySelector('time') && link.closest('article') === article);
    if (!link) return;
    return new URL((link as HTMLAnchorElement).href, location.href).pathname.match(/\/status\/(\d+)/)?.[1];
  }
  function cellOf(article: Element): HTMLElement {
    return (article.closest('[data-testid="cellInnerDiv"]') ?? article) as HTMLElement;
  }
  function bridge(data: { enabled?: boolean; ids?: string[]; release?: string[] }): void {
    try {
      // localStorage is shared by all tabs, so a newly opened tab also waits for the read list.
      if (data.enabled === true) localStorage.setItem('__xOriginalUnreadOn', '1');
      else if (data.enabled === false) localStorage.removeItem('__xOriginalUnreadOn');
      sessionStorage.removeItem('__xOriginalUnreadOn'); // The flag older versions kept per tab.
    } catch { /* Without the flag, the first response of a page is simply not waited for. */ }
    try { window.postMessage({ __xOriginalUnread: true, ...data }, location.origin); } catch { /* The page filter keeps its last state. */ }
  }
  // A cell below the viewport can collapse without moving anything on screen; a cell above it
  // would pull the visible posts up, so those are never hidden.
  function belowViewport(cell: Element): boolean {
    return cell.getBoundingClientRect().top >= innerHeight;
  }
  function hideable(id: string): boolean { return read.has(id) && !readHere.has(id); }
  // The marker holds the post ID, so a cell X reuses for another post is recognised.
  function hide(article: Element, id: string): void {
    const cell = cellOf(article);
    cell.setAttribute(hiddenMarker, id); cell.style.setProperty('display', 'none', 'important');
  }
  function unhideAll(): void {
    document.querySelectorAll<HTMLElement>(`[${hiddenMarker}]`).forEach(cell => { cell.removeAttribute(hiddenMarker); cell.style.removeProperty('display'); });
  }
  function unwatch(article: Element): void {
    visibility.unobserve(article); watched.delete(article);
    const pendingRead = readTimers.get(article);
    if (pendingRead !== undefined) { clearTimeout(pendingRead); readTimers.delete(article); }
  }
  function reset(): void {
    for (const article of Array.from(watched)) unwatch(article);
    evaluated = new WeakMap(); unhideAll();
  }
  // On a page opened over the timeline X keeps the cells, so hidden posts stay hidden unless X has
  // reused the cell for another post. Evaluation starts over when the timeline is back.
  function suspend(): void {
    for (const article of Array.from(watched)) unwatch(article);
    evaluated = new WeakMap();
    document.querySelectorAll<HTMLElement>(`[${hiddenMarker}]`).forEach(cell => {
      const article = cell.tagName === 'ARTICLE' ? cell : cell.querySelector('article');
      const id = article ? postId(article) : undefined;
      if (!id || id !== cell.getAttribute(hiddenMarker)) { cell.removeAttribute(hiddenMarker); cell.style.removeProperty('display'); }
    });
  }
  function onVisibility(entries: IntersectionObserverEntry[]): void {
    for (const entry of entries) {
      const article = entry.target;
      const visible = entry.isIntersecting && (entry.intersectionRatio >= 0.5 || entry.intersectionRect.height >= innerHeight * 0.5);
      const pendingRead = readTimers.get(article);
      if (entry.isIntersecting) appeared.add(article);
      else if (appeared.has(article) && entry.boundingClientRect.bottom <= (entry.rootBounds?.top ?? 0) + 1) { markRead(article); continue; }
      if (!visible) { if (pendingRead !== undefined) { clearTimeout(pendingRead); readTimers.delete(article); } continue; }
      if (pendingRead === undefined) readTimers.set(article, setTimeout(() => { readTimers.delete(article); markRead(article); }, READ_DELAY));
    }
  }
  function markRead(article: Element): void {
    const id = evaluated.get(article);
    if (!enabled || stopped || !onTarget() || !article.isConnected || !id || postId(article) !== id) return;
    unwatch(article);
    if (read.has(id)) return;
    read.add(id); readHere.add(id); pending.add(id);
    bridge({ ids: [id] });
    if (flushTimer === undefined) flushTimer = setTimeout(flush, 1000);
  }
  function flush(): void {
    flushTimer = undefined;
    if (!pending.size || !enabled || !alive()) { pending.clear(); return; }
    const postIds = Array.from(pending).slice(0, 1000);
    postIds.forEach(id => pending.delete(id));
    if (pending.size) flushTimer = setTimeout(flush, 1000);
    void chrome.runtime.sendMessage({ type: 'MARK_POSTS_READ', postIds }).catch(() => {});
  }
  // Sends the pending reads at once when the tab is hidden (reload, close, switch), not after 1s.
  function onVisibilityChange(): void {
    if (document.visibilityState === 'hidden' && flushTimer !== undefined) { clearTimeout(flushTimer); flush(); }
    schedule();
  }
  function schedule(): void {
    if (stopped || !enabled || scheduled !== undefined) return;
    scheduled = setTimeout(() => { scheduled = undefined; scan(); }, 80);
  }
  function scan(): void {
    if (!alive()) { cleanup(); return; }
    if (!enabled) return;
    checkPage();
    if (!onTarget()) {
      if (watched.size || document.querySelector(`[${hiddenMarker}]`)) { if (location.pathname === '/search') reset(); else suspend(); }
      return;
    }
    for (const article of Array.from(watched)) if (!article.isConnected) unwatch(article);
    const root = timelineRoot();
    if (!root) return;
    anchor = root.querySelector('article') ?? anchor;
    checkTop(root);
    for (const article of Array.from(root.querySelectorAll('article'))) evaluate(article);
    if (onHome()) expandNewPosts(root);
  }
  // Arriving back at the top after scrolling at least one screen releases posts read on this page:
  // those X still keeps rendered below the viewport are hidden now, the rest when X draws them.
  function checkTop(root: Element | null): void {
    if (!onHome()) return;
    if (scrollY > innerHeight) { awayFromTop = true; return; }
    if (scrollY > 1 || !awayFromTop || !root) return;
    awayFromTop = false;
    if (readHere.size) releaseReadHere(root);
  }
  function releaseReadHere(root: Element): void {
    // Posts on screen stay in X's list (removing them would move what is shown); the rest are
    // dropped from it on the next timeline response so X no longer redraws them.
    const shown = new Set<string>();
    for (const article of Array.from(root.querySelectorAll('article'))) {
      const id = evaluated.get(article);
      const box = cellOf(article).getBoundingClientRect();
      if (id && box.bottom > 0 && box.top < innerHeight) shown.add(id);
    }
    const release = Array.from(readHere).filter(id => !shown.has(id));
    if (release.length) bridge({ release });
    readHere.clear();
    for (const article of Array.from(root.querySelectorAll('article'))) {
      const id = evaluated.get(article);
      const cell = cellOf(article);
      if (id && hideable(id) && !cell.hasAttribute(hiddenMarker) && belowViewport(cell)) { unwatch(article); hide(article, id); }
    }
  }
  // Opens the bar only while it is on screen, so reading further down is never interrupted.
  function expandNewPosts(root: Element): void {
    if (document.visibilityState !== 'visible' || Date.now() - lastExpand < 1000) return;
    const button = Array.from(root.querySelectorAll<HTMLElement>('[role="button"], button'))
      .find(node => NEW_POSTS_LABEL.test((node.textContent ?? '').trim()) && !node.closest('article'));
    if (!button) return;
    const box = button.getBoundingClientRect();
    if (box.height === 0 || box.bottom <= 0 || box.top >= innerHeight) return;
    lastExpand = Date.now();
    button.click();
  }
  function arriving(): boolean { return Date.now() - arrivedAt < ARRIVAL_WINDOW; }
  function timelineRoot(): Element | null {
    return document.querySelector('[data-testid="primaryColumn"]') ?? document.querySelector('main');
  }
  function evaluate(article: Element): void {
    if (article.parentElement?.closest('article')) return;
    const id = postId(article);
    if (!id || evaluated.get(article) === id) return;
    evaluated.set(article, id);
    unwatch(article);
    const cell = cellOf(article);
    if (cell.hasAttribute(hiddenMarker)) {
      if (cell.getAttribute(hiddenMarker) === id && hideable(id)) return;
      cell.removeAttribute(hiddenMarker); cell.style.removeProperty('display');
    }
    // Fallback for posts X shows from its own list: hide only posts read before this page, in
    // another tab, or before returning to the top. A newly drawn cell is hidden before it is
    // painted when it is below the visible area, or anywhere while at the top (X redraws the top
    // after a jump there and on load, and nothing above can shift), or right after arriving at a
    // target page.
    if (read.has(id)) { if (hideable(id) && (belowViewport(cell) || scrollY <= 1 || arriving())) hide(article, id); }
    else { watched.add(article); visibility.observe(article); }
  }
  // Mutation callbacks run before the next paint, so read posts X adds (including the ones it
  // pre-renders below the viewport) are hidden before they are ever drawn at full height.
  function onMutations(records: MutationRecord[] = []): void {
    if (stopped || !enabled) return;
    checkPage();
    if (onTarget()) {
      const root = timelineRoot();
      checkTop(root);
      for (const record of records) {
        for (const node of Array.from(record.addedNodes)) {
          if (!(node instanceof Element) || !root?.contains(node)) continue;
          if (node.tagName === 'ARTICLE') evaluate(node);
          for (const article of Array.from(node.getElementsByTagName('article'))) evaluate(article);
        }
      }
    }
    schedule();
  }
  function apply(next: boolean, ids: string[] = []): void {
    if (stopped) return;
    ids.forEach(id => read.add(id));
    bridge(next ? { enabled: true, ids } : { enabled: false });
    if (enabled === next) { schedule(); return; }
    enabled = next;
    if (next) { scan(); return; }
    pending.clear(); read.clear(); readHere.clear(); reset();
    if (flushTimer !== undefined) { clearTimeout(flushTimer); flushTimer = undefined; }
  }
  async function load(): Promise<void> {
    const response = await chrome.runtime.sendMessage({ type: 'GET_UNREAD_FILTER' });
    if (response?.ok) apply(response.enabled === true, Array.isArray(response.ids) ? response.ids : []);
    else bridge({ enabled: false });
  }
  function onMessage(message: any, sender: chrome.runtime.MessageSender): void {
    if (sender.id !== chrome.runtime.id) return;
    if (message?.type === 'UNREAD_FILTER_STATE') {
      if (message.enabled === true) void load().catch(() => {});
      else apply(false);
    } else if (message?.type === 'UNREAD_FILTER_READ' && enabled && Array.isArray(message.postIds)) {
      const ids = message.postIds.filter((id: unknown): id is string => typeof id === 'string');
      ids.forEach((id: string) => read.add(id));
      bridge({ ids });
    }
  }
  function cleanup(): void {
    stopped = true; enabled = false; observer.disconnect(); visibility.disconnect(); clearInterval(timer);
    if (scheduled !== undefined) clearTimeout(scheduled);
    if (flushTimer !== undefined) clearTimeout(flushTimer);
    readTimers.forEach(pendingRead => clearTimeout(pendingRead)); readTimers.clear(); watched.clear();
    unhideAll(); bridge({ enabled: false });
    document.removeEventListener('scroll', schedule, true);
    document.removeEventListener('visibilitychange', onVisibilityChange);
    try { chrome.runtime.onMessage.removeListener(onMessage); } catch {}
  }
  if (!alive()) { cleanup(); return; }
  chrome.runtime.onMessage.addListener(onMessage);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener('scroll', schedule, { capture: true, passive: true });
  document.addEventListener('visibilitychange', onVisibilityChange);
  void load().catch(() => bridge({ enabled: false }));
})();
