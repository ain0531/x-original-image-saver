"use strict";
// Runs in the page's MAIN world. Authentication headers never leave this closure.
(() => {
    const host = window;
    if (host.__xImageBookmarkReader)
        return;
    const nativeFetch = window.fetch.bind(window);
    let template;
    const postImages = new Map();
    const scope = () => {
        const root = document.querySelector('[data-testid="primaryColumn"]') ?? document.querySelector('main');
        const selected = root?.querySelector('[role="tab"][aria-selected="true"]');
        const account = document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"]')?.textContent ?? "";
        return JSON.stringify([location.href, selected?.textContent ?? "", account]);
    };
    const accepts = (raw) => {
        try {
            const u = new URL(raw, location.href);
            return u.origin === location.origin && /^\/i\/api\/graphql\/[^/]+\/(Bookmarks|BookmarkFolderTimeline)$/.test(u.pathname) && u.searchParams.has('variables');
        }
        catch {
            return false;
        }
    };
    const compatible = (before, after) => {
        const a = JSON.parse(before), b = JSON.parse(after);
        // Initial requests can finish before X mounts the header/tab controls.
        // Once present, account and selected-tab changes always invalidate them.
        return a[0] === b[0] && (!a[1] || a[1] === b[1]) && (!a[2] || a[2] === b[2]);
    };
    const observes = (raw) => {
        try {
            const url = new URL(raw, location.href);
            return url.origin === location.origin && /^\/i\/api\/graphql\/[^/]+\/[^/]+$/.test(url.pathname);
        }
        catch {
            return false;
        }
    };
    const remember = (body, requestScope) => {
        if (!compatible(requestScope, scope()))
            return;
        let nodes = 0;
        const visit = (value, depth) => {
            if (!value || typeof value !== 'object' || depth > 30 || ++nodes > 30000)
                return;
            const legacy = value.legacy ?? value;
            const id = value.rest_id ?? legacy.id_str;
            if (typeof id === 'string' && /^\d+$/.test(id) && (typeof legacy.full_text === 'string' || legacy.extended_entities?.media || legacy.entities?.media)) {
                const full = [legacy.extended_entities?.media, legacy.extended_tweet?.extended_entities?.media].filter(Array.isArray);
                const items = full.length ? full.flat() : legacy.entities?.media ?? [];
                const urls = new Set();
                let valid = true;
                for (const item of items) {
                    if (item.type === 'video' || item.type === 'animated_gif')
                        continue;
                    const raw = item.media_url_https ?? item.media_url;
                    try {
                        const url = new URL(raw);
                        if (item.type !== 'photo' || url.hostname !== 'pbs.twimg.com' || !/^\/media\//.test(url.pathname) || !['http:', 'https:'].includes(url.protocol)) {
                            valid = false;
                            continue;
                        }
                        url.protocol = 'https:';
                        urls.add(url.toString());
                    }
                    catch {
                        valid = false;
                    }
                }
                const complete = valid && (full.length > 0 || !(legacy.entities?.media?.length));
                const old = postImages.get(id);
                // A truncated result must not replace a previously observed full list.
                if (!old || !compatible(old.scope, scope()) || complete || !old.complete) {
                    postImages.delete(id);
                    postImages.set(id, { postId: id, urls: [...urls], complete, scope: scope(), at: Date.now() });
                }
                while (postImages.size > 2000)
                    postImages.delete(postImages.keys().next().value);
            }
            for (const child of Object.values(value))
                visit(child, depth + 1);
        };
        visit(body, 0);
    };
    const capture = (url, headers, requestScope) => {
        if (!compatible(requestScope, scope()))
            return;
        // A response for a different tab/account must never authorize a bookmark scan.
        template = { url, headers, scope: scope(), at: Date.now() };
    };
    window.fetch = async (input, init) => {
        const url = input instanceof Request ? input.url : String(input);
        const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
        if (!observes(url) || method.toUpperCase() !== 'GET')
            return nativeFetch(input, init);
        const headers = new Headers(input instanceof Request ? input.headers : undefined);
        new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
        const requestScope = scope();
        const response = await nativeFetch(input, init);
        if (response.ok) {
            if (accepts(url))
                capture(url, headers, requestScope);
            void response.clone().json().then(body => remember(body, requestScope)).catch(() => { });
        }
        return response;
    };
    // X also uses XMLHttpRequest in some builds.
    const open = XMLHttpRequest.prototype.open;
    const setHeader = XMLHttpRequest.prototype.setRequestHeader;
    const send = XMLHttpRequest.prototype.send;
    const requests = new WeakMap();
    XMLHttpRequest.prototype.open = function (method, url, ...args) {
        requests.delete(this);
        if (method.toUpperCase() === 'GET' && observes(String(url)))
            requests.set(this, { url: String(url), headers: new Headers(), scope: scope() });
        return open.call(this, method, url, ...args);
    };
    XMLHttpRequest.prototype.setRequestHeader = function (key, value) {
        requests.get(this)?.headers.set(key, value);
        return setHeader.call(this, key, value);
    };
    XMLHttpRequest.prototype.send = function (body) {
        const request = requests.get(this);
        if (request)
            this.addEventListener('load', () => {
                try {
                    if (this.status >= 200 && this.status < 300) {
                        if (accepts(request.url))
                            capture(request.url, request.headers, request.scope);
                        remember(this.responseType === 'json' ? this.response : JSON.parse(this.responseText), request.scope);
                    }
                }
                catch { /* A malformed response cannot establish the source. */ }
            }, { once: true });
        return send.call(this, body);
    };
    let busy = false;
    host.__xImageBookmarkReader = async (operation, cursor, expectedScope, postIds) => {
        const current = scope();
        if (operation === 'posts') {
            if (expectedScope !== current)
                throw new Error('画像取得中にページ・アカウントが変わりました。');
            const posts = (postIds ?? []).slice(0, 200).flatMap(id => {
                const record = postImages.get(id);
                if (!record || (record.scope !== current && !(Date.now() - record.at < 30000 && compatible(record.scope, current))))
                    return [];
                record.scope = current;
                return [{ postId: record.postId, urls: record.urls, complete: record.complete }];
            });
            return { posts, scope: current };
        }
        if (template && template.scope !== current && Date.now() - template.at < 30000 && compatible(template.scope, current))
            template.scope = current;
        if (!template || template.scope !== current)
            return { available: false, scope: current, documentId: performance.timeOrigin, reason: template ? 'scope-changed' : 'no-bookmark-request' };
        if (operation === 'probe')
            return { available: true, scope: current, documentId: performance.timeOrigin };
        if (expectedScope !== current)
            throw new Error('取得対象のページ・タブ・アカウントが変わりました。');
        if (busy)
            throw new Error('投稿データ取得中です。');
        busy = true;
        try {
            const url = new URL(template.url, location.href);
            const variables = JSON.parse(url.searchParams.get('variables'));
            if (cursor)
                variables.cursor = cursor;
            else
                delete variables.cursor;
            url.searchParams.set('variables', JSON.stringify(variables));
            // Reuse only the request X itself sent. Do not persist cookies or tokens.
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 15000);
            try {
                const response = await nativeFetch(url.toString(), { method: 'GET', headers: template.headers, credentials: 'include', signal: controller.signal });
                if (!response.ok)
                    throw new Error(`投稿データ取得失敗 (HTTP ${response.status})。未処理位置は保持しています。`);
                const data = await response.json();
                if (scope() !== current)
                    throw new Error('取得中にページ・アカウントが変わりました。');
                remember(data, current);
                return { available: true, scope: current, documentId: performance.timeOrigin, data };
            }
            finally {
                clearTimeout(timer);
            }
        }
        finally {
            busy = false;
        }
    };
})();
