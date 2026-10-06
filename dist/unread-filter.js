"use strict";
// Unread-only filter for the home timeline. A post becomes read when shown for 0.5s, or when it
// was on screen and then scrolled past the top (quick skimming). The read list is
// passed to timeline-filter (MAIN world), which drops read posts from X's timeline responses
// before they are rendered. Posts read on this page stay in X's own list and are not hidden while
// scrolling back; returning to the very top releases them so they are hidden from then on.
// Posts already painted are only hidden below the visible area, so what is on screen never moves.
(() => {
    const instance = globalThis;
    if (instance.__xOriginalUnreadFilter)
        return;
    instance.__xOriginalUnreadFilter = true;
    const hiddenMarker = 'data-x-original-unread-hidden';
    const READ_DELAY = 500;
    // X's in-timeline "N件のポストを表示" bar. The floating "posted" pill is not matched.
    const NEW_POSTS_LABEL = /^(?:[\d,.]+\s*件の(?:ポスト|ツイート)を表示|Show\s+[\d,.]+[KM]?\s+(?:posts?|Tweets?))$/i;
    let lastExpand = 0;
    let awayFromTop = false;
    let stopped = false;
    let enabled = false;
    let scheduled;
    let flushTimer;
    let evaluated = new WeakMap();
    const read = new Set();
    const readHere = new Set();
    const pending = new Set();
    const watched = new Set();
    const appeared = new WeakSet();
    const readTimers = new Map();
    const visibility = new IntersectionObserver(onVisibility, { threshold: [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1] });
    const observer = new MutationObserver(onMutations);
    const timer = setInterval(() => { if (!alive())
        cleanup(); }, 1000);
    function alive() {
        try {
            return !!chrome.runtime.id && !!chrome.runtime.getManifest();
        }
        catch {
            return false;
        }
    }
    function onHome() { return location.pathname === '/home'; }
    function postId(article) {
        const link = Array.from(article.querySelectorAll('a[href]')).find(link => link.querySelector('time') && link.closest('article') === article);
        if (!link)
            return;
        return new URL(link.href, location.href).pathname.match(/\/status\/(\d+)/)?.[1];
    }
    function cellOf(article) {
        return (article.closest('[data-testid="cellInnerDiv"]') ?? article);
    }
    function bridge(data) {
        try {
            if (data.enabled === true)
                sessionStorage.setItem('__xOriginalUnreadOn', '1');
            else if (data.enabled === false)
                sessionStorage.removeItem('__xOriginalUnreadOn');
        }
        catch { /* Without the flag, the first response of a page is simply not waited for. */ }
        try {
            window.postMessage({ __xOriginalUnread: true, ...data }, location.origin);
        }
        catch { /* The page filter keeps its last state. */ }
    }
    // A cell below the viewport can collapse without moving anything on screen; a cell above it
    // would pull the visible posts up, so those are never hidden.
    function belowViewport(cell) {
        return cell.getBoundingClientRect().top >= innerHeight;
    }
    function hideable(id) { return read.has(id) && !readHere.has(id); }
    function hide(article) {
        const cell = cellOf(article);
        cell.setAttribute(hiddenMarker, '');
        cell.style.setProperty('display', 'none', 'important');
    }
    function unhideAll() {
        document.querySelectorAll(`[${hiddenMarker}]`).forEach(cell => { cell.removeAttribute(hiddenMarker); cell.style.removeProperty('display'); });
    }
    function unwatch(article) {
        visibility.unobserve(article);
        watched.delete(article);
        const pendingRead = readTimers.get(article);
        if (pendingRead !== undefined) {
            clearTimeout(pendingRead);
            readTimers.delete(article);
        }
    }
    function reset() {
        for (const article of Array.from(watched))
            unwatch(article);
        evaluated = new WeakMap();
        unhideAll();
    }
    function onVisibility(entries) {
        for (const entry of entries) {
            const article = entry.target;
            const visible = entry.isIntersecting && (entry.intersectionRatio >= 0.5 || entry.intersectionRect.height >= innerHeight * 0.5);
            const pendingRead = readTimers.get(article);
            if (entry.isIntersecting)
                appeared.add(article);
            else if (appeared.has(article) && entry.boundingClientRect.bottom <= (entry.rootBounds?.top ?? 0) + 1) {
                markRead(article);
                continue;
            }
            if (!visible) {
                if (pendingRead !== undefined) {
                    clearTimeout(pendingRead);
                    readTimers.delete(article);
                }
                continue;
            }
            if (pendingRead === undefined)
                readTimers.set(article, setTimeout(() => { readTimers.delete(article); markRead(article); }, READ_DELAY));
        }
    }
    function markRead(article) {
        const id = evaluated.get(article);
        if (!enabled || stopped || !onHome() || !article.isConnected || !id || postId(article) !== id)
            return;
        unwatch(article);
        if (read.has(id))
            return;
        read.add(id);
        readHere.add(id);
        pending.add(id);
        bridge({ ids: [id] });
        if (flushTimer === undefined)
            flushTimer = setTimeout(flush, 1000);
    }
    function flush() {
        flushTimer = undefined;
        if (!pending.size || !enabled || !alive()) {
            pending.clear();
            return;
        }
        const postIds = Array.from(pending).slice(0, 1000);
        postIds.forEach(id => pending.delete(id));
        if (pending.size)
            flushTimer = setTimeout(flush, 1000);
        void chrome.runtime.sendMessage({ type: 'MARK_POSTS_READ', postIds }).catch(() => { });
    }
    function schedule() {
        if (stopped || !enabled || scheduled !== undefined)
            return;
        scheduled = setTimeout(() => { scheduled = undefined; scan(); }, 80);
    }
    function scan() {
        if (!alive()) {
            cleanup();
            return;
        }
        if (!enabled)
            return;
        if (!onHome()) {
            if (watched.size || document.querySelector(`[${hiddenMarker}]`))
                reset();
            return;
        }
        for (const article of Array.from(watched))
            if (!article.isConnected)
                unwatch(article);
        const root = timelineRoot();
        if (!root)
            return;
        checkTop(root);
        for (const article of Array.from(root.querySelectorAll('article')))
            evaluate(article);
        expandNewPosts(root);
    }
    // Arriving back at the top after scrolling at least one screen releases posts read on this page:
    // those X still keeps rendered below the viewport are hidden now, the rest when X draws them.
    function checkTop(root) {
        if (scrollY > innerHeight) {
            awayFromTop = true;
            return;
        }
        if (scrollY > 1 || !awayFromTop || !root)
            return;
        awayFromTop = false;
        if (readHere.size)
            releaseReadHere(root);
    }
    function releaseReadHere(root) {
        // Posts on screen stay in X's list (removing them would move what is shown); the rest are
        // dropped from it on the next timeline response so X no longer redraws them.
        const shown = new Set();
        for (const article of Array.from(root.querySelectorAll('article'))) {
            const id = evaluated.get(article);
            const box = cellOf(article).getBoundingClientRect();
            if (id && box.bottom > 0 && box.top < innerHeight)
                shown.add(id);
        }
        const release = Array.from(readHere).filter(id => !shown.has(id));
        if (release.length)
            bridge({ release });
        readHere.clear();
        for (const article of Array.from(root.querySelectorAll('article'))) {
            const id = evaluated.get(article);
            const cell = cellOf(article);
            if (id && hideable(id) && !cell.hasAttribute(hiddenMarker) && belowViewport(cell)) {
                unwatch(article);
                hide(article);
            }
        }
    }
    // Opens the bar only while it is on screen, so reading further down is never interrupted.
    function expandNewPosts(root) {
        if (document.visibilityState !== 'visible' || Date.now() - lastExpand < 1000)
            return;
        const button = Array.from(root.querySelectorAll('[role="button"], button'))
            .find(node => NEW_POSTS_LABEL.test((node.textContent ?? '').trim()) && !node.closest('article'));
        if (!button)
            return;
        const box = button.getBoundingClientRect();
        if (box.height === 0 || box.bottom <= 0 || box.top >= innerHeight)
            return;
        lastExpand = Date.now();
        button.click();
    }
    function timelineRoot() {
        return document.querySelector('[data-testid="primaryColumn"]') ?? document.querySelector('main');
    }
    function evaluate(article) {
        if (article.parentElement?.closest('article'))
            return;
        const id = postId(article);
        if (!id || evaluated.get(article) === id)
            return;
        evaluated.set(article, id);
        unwatch(article);
        const cell = cellOf(article);
        if (cell.hasAttribute(hiddenMarker)) {
            cell.removeAttribute(hiddenMarker);
            cell.style.removeProperty('display');
        }
        // Fallback for posts X shows from its own list: hide only posts read before this page, in
        // another tab, or before returning to the top. A newly drawn cell is hidden before it is
        // painted when it is below the visible area, or anywhere while at the top (X redraws the top
        // after a jump there and on load, and nothing above can shift).
        if (read.has(id)) {
            if (hideable(id) && (belowViewport(cell) || scrollY <= 1))
                hide(article);
        }
        else {
            watched.add(article);
            visibility.observe(article);
        }
    }
    // Mutation callbacks run before the next paint, so read posts X adds (including the ones it
    // pre-renders below the viewport) are hidden before they are ever drawn at full height.
    function onMutations(records = []) {
        if (stopped || !enabled)
            return;
        if (onHome()) {
            const root = timelineRoot();
            checkTop(root);
            for (const record of records) {
                for (const node of Array.from(record.addedNodes)) {
                    if (!(node instanceof Element) || !root?.contains(node))
                        continue;
                    if (node.tagName === 'ARTICLE')
                        evaluate(node);
                    for (const article of Array.from(node.getElementsByTagName('article')))
                        evaluate(article);
                }
            }
        }
        schedule();
    }
    function apply(next, ids = []) {
        if (stopped)
            return;
        ids.forEach(id => read.add(id));
        bridge(next ? { enabled: true, ids } : { enabled: false });
        if (enabled === next) {
            schedule();
            return;
        }
        enabled = next;
        if (next) {
            scan();
            return;
        }
        pending.clear();
        read.clear();
        readHere.clear();
        reset();
        if (flushTimer !== undefined) {
            clearTimeout(flushTimer);
            flushTimer = undefined;
        }
    }
    async function load() {
        const response = await chrome.runtime.sendMessage({ type: 'GET_UNREAD_FILTER' });
        if (response?.ok)
            apply(response.enabled === true, Array.isArray(response.ids) ? response.ids : []);
        else
            bridge({ enabled: false });
    }
    function onMessage(message, sender) {
        if (sender.id !== chrome.runtime.id)
            return;
        if (message?.type === 'UNREAD_FILTER_STATE') {
            if (message.enabled === true)
                void load().catch(() => { });
            else
                apply(false);
        }
        else if (message?.type === 'UNREAD_FILTER_READ' && enabled && Array.isArray(message.postIds)) {
            const ids = message.postIds.filter((id) => typeof id === 'string');
            ids.forEach((id) => read.add(id));
            bridge({ ids });
        }
    }
    function cleanup() {
        stopped = true;
        enabled = false;
        observer.disconnect();
        visibility.disconnect();
        clearInterval(timer);
        if (scheduled !== undefined)
            clearTimeout(scheduled);
        if (flushTimer !== undefined)
            clearTimeout(flushTimer);
        readTimers.forEach(pendingRead => clearTimeout(pendingRead));
        readTimers.clear();
        watched.clear();
        unhideAll();
        bridge({ enabled: false });
        document.removeEventListener('scroll', schedule, true);
        document.removeEventListener('visibilitychange', schedule);
        try {
            chrome.runtime.onMessage.removeListener(onMessage);
        }
        catch { }
    }
    if (!alive()) {
        cleanup();
        return;
    }
    chrome.runtime.onMessage.addListener(onMessage);
    observer.observe(document.documentElement, { childList: true, subtree: true });
    document.addEventListener('scroll', schedule, { capture: true, passive: true });
    document.addEventListener('visibilitychange', schedule);
    void load().catch(() => bridge({ enabled: false }));
})();
