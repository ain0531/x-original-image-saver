"use strict";
// Runs in the page's MAIN world. Authentication headers never leave this closure.
(() => {
    const host = window;
    if (host.__xImageBookmarkReader)
        return;
    const nativeFetch = window.fetch.bind(window);
    let template;
    let initialPage;
    let accountInitial;
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
    const postCompatible = (before, after) => {
        const a = JSON.parse(before), b = JSON.parse(after);
        // A post ID's media do not depend on route or selected timeline. Keep the
        // account boundary; initially blank account labels may settle on this page.
        return a[2] ? a[2] === b[2] : a[0] === b[0];
    };
    const remember = (body, requestScope, onlyId, rendered = false) => {
        // Traversal is synchronous, so one DOM read of the scope serves every post.
        const currentScope = scope();
        if (!compatible(requestScope, currentScope))
            return;
        let nodes = 0;
        const seen = new WeakSet();
        const visit = (value, depth) => {
            if (!value || typeof value !== 'object' || depth > 30 || ++nodes > 30000 || seen.has(value))
                return;
            seen.add(value);
            const legacy = value.legacy ?? value;
            const id = value.rest_id ?? legacy.id_str;
            if (typeof id === 'string' && /^\d+$/.test(id) && (!onlyId || id === onlyId) && (typeof legacy.full_text === 'string' || legacy.extended_entities?.media || legacy.extended_tweet?.extended_entities?.media || legacy.entities?.media) && (!rendered || Array.isArray(legacy.extended_entities?.media) || Array.isArray(legacy.extended_tweet?.extended_entities?.media))) {
                const full = [legacy.extended_entities?.media, legacy.extended_tweet?.extended_entities?.media].filter(Array.isArray);
                const items = full.length ? full.flat() : legacy.entities?.media ?? [];
                const urls = new Set();
                const videos = [];
                let valid = true;
                for (const item of items) {
                    if (item.type === 'video' || item.type === 'animated_gif') {
                        videos.push({ type: item.type, id_str: item.id_str, media_key: item.media_key, video_info: { variants: Array.isArray(item.video_info?.variants) ? item.video_info.variants.map((variant) => ({ bitrate: variant.bitrate, content_type: variant.content_type, url: variant.url })) : [] } });
                        continue;
                    }
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
                if (!old || !postCompatible(old.scope, currentScope) || complete || !old.complete) {
                    postImages.delete(id);
                    postImages.set(id, { postId: id, urls: [...urls], videos, complete, scope: currentScope, at: Date.now() });
                }
                while (postImages.size > 2000)
                    postImages.delete(postImages.keys().next().value);
            }
            for (const [key, child] of Object.entries(value))
                if (!['_owner', 'return', 'stateNode', 'alternate', 'child', 'sibling', 'ref'].includes(key))
                    visit(child, depth + 1);
        };
        visit(body, 0);
    };
    const renderedPost = (id, current) => {
        const root = document.querySelector('[data-testid="primaryColumn"]') ?? document.querySelector('main');
        const article = Array.from(root?.querySelectorAll?.('article') ?? []).find(article => {
            const link = Array.from(article.querySelectorAll('a[href]')).find(link => link.querySelector('time') && link.closest('article') === article);
            try {
                return !!link && new URL(link.href, location.href).pathname.match(/\/status\/(\d+)/)?.[1] === id;
            }
            catch {
                return false;
            }
        });
        if (!article)
            return;
        // Read only committed props for this article. Never execute React callbacks
        // or inspect a different post's metadata as a substitute.
        const complete = () => { const record = postImages.get(id); return !!record?.complete && postCompatible(record.scope, current); };
        const inspected = new WeakSet();
        let node = article;
        for (let parent = 0; node && parent < 4; parent++, node = node.parentElement) {
            for (const key of Object.keys(node)) {
                if (key.startsWith('__reactProps$'))
                    remember(node[key], current, id, true);
                if (key.startsWith('__reactFiber$') || key.startsWith('__reactInternalInstance$')) {
                    let fiber = node[key];
                    for (let step = 0; fiber && typeof fiber === 'object' && step < 24 && !inspected.has(fiber); step++, fiber = fiber.return) {
                        inspected.add(fiber);
                        remember(fiber.memoizedProps, current, id, true);
                        if (complete())
                            return;
                    }
                }
                if (complete())
                    return;
            }
        }
    };
    const capture = (url, headers, requestScope) => {
        if (!compatible(requestScope, scope()))
            return;
        // A response for a different tab/account must never authorize a bookmark scan.
        template = { url, headers, scope: scope(), at: Date.now() };
    };
    const rememberInitial = (url, body, requestScope) => {
        if (!accepts(url) || !compatible(requestScope, scope()))
            return;
        const endpoint = new URL(url, location.href);
        if (!endpoint.pathname.endsWith('/Bookmarks'))
            return;
        try {
            if (JSON.parse(endpoint.searchParams.get('variables')).cursor)
                return;
            initialPage = { data: body, scope: requestScope };
        }
        catch { /* Only a proven first page can initialize a batch. */ }
    };
    const rememberAccount = (raw, body, requestScope, method, requestBody) => {
        if (!compatible(requestScope, scope()))
            return;
        try {
            const url = new URL(raw, location.href);
            if (url.origin !== location.origin || !/^\/i\/api\/graphql\/[^/]+\/UserMedia$/.test(url.pathname))
                return;
            const page = new URL(JSON.parse(requestScope)[0]);
            const handle = page.pathname.match(/^\/([A-Za-z0-9_]{1,15})\/media\/?$/)?.[1];
            if (!handle)
                return;
            const payload = method === 'POST' && typeof requestBody === 'string' ? JSON.parse(requestBody) : undefined;
            const variables = payload?.variables ?? JSON.parse(url.searchParams.get('variables') ?? 'null');
            const user = body?.data?.user?.result;
            if (!variables || variables.cursor || typeof variables.userId !== 'string' || !/^\d+$/.test(variables.userId) || user?.rest_id !== variables.userId)
                return;
            const returnedHandle = user?.core?.screen_name ?? user?.legacy?.screen_name;
            if (returnedHandle && String(returnedHandle).toLowerCase() !== handle.toLowerCase())
                return;
            const booleans = (value) => value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).filter(([, flag]) => typeof flag === 'boolean')) : {};
            accountInitial = { data: body, scope: requestScope, userId: variables.userId, request: { url: url.toString(), method: method === 'POST' ? 'POST' : 'GET', variables, features: booleans(payload?.features ?? JSON.parse(url.searchParams.get('features') ?? '{}')), fieldToggles: booleans(payload?.fieldToggles ?? JSON.parse(url.searchParams.get('fieldToggles') ?? '{}')) } };
        }
        catch { /* Only a matching first native media response can initialize a scan. */ }
    };
    window.fetch = async (input, init) => {
        const url = input instanceof Request ? input.url : String(input);
        const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
        if (!observes(url) || !['GET', 'POST'].includes(method.toUpperCase()))
            return nativeFetch(input, init);
        const headers = new Headers(input instanceof Request ? input.headers : undefined);
        new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
        const requestScope = scope();
        // Inspect only media query bodies; a failed clone must never block X's request.
        let requestBody = init?.body;
        if (method.toUpperCase() === 'POST' && /\/UserMedia(?:\?|$)/.test(url) && requestBody === undefined && input instanceof Request) {
            try {
                requestBody = await input.clone().text();
            }
            catch { /* Native request still proceeds. */ }
        }
        const response = await nativeFetch(input, init);
        if (response.ok) {
            if (method.toUpperCase() === 'GET' && accepts(url))
                capture(url, headers, requestScope);
            void response.clone().json().then(body => { remember(body, requestScope); rememberAccount(url, body, requestScope, method.toUpperCase(), requestBody); if (method.toUpperCase() === 'GET')
                rememberInitial(url, body, requestScope); }).catch(() => { });
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
        if (['GET', 'POST'].includes(method.toUpperCase()) && observes(String(url)))
            requests.set(this, { url: String(url), method: method.toUpperCase(), headers: new Headers(), scope: scope() });
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
                        if (request.method === 'GET' && accepts(request.url))
                            capture(request.url, request.headers, request.scope);
                        const data = this.responseType === 'json' ? this.response : JSON.parse(this.responseText);
                        remember(data, request.scope);
                        rememberAccount(request.url, data, request.scope, request.method, body);
                        if (request.method === 'GET')
                            rememberInitial(request.url, data, request.scope);
                    }
                }
                catch { /* A malformed response cannot establish the source. */ }
            }, { once: true });
        return send.call(this, body);
    };
    let busy = false;
    host.__xImageBookmarkReader = async (operation, cursor, expectedScope, postIds) => {
        const current = scope();
        if (operation === 'account-config') {
            // Return only public asset URLs and explicit boolean feature values.
            // Never serialize the initial state itself (it can contain account data).
            const features = {};
            const switches = host.__INITIAL_STATE__?.featureSwitch;
            for (const layer of [switches?.defaultConfig, switches?.config, switches?.user]) {
                if (!layer || typeof layer !== 'object')
                    continue;
                for (const [key, entry] of Object.entries(layer)) {
                    const value = typeof entry === 'boolean' ? entry : entry?.value;
                    if (/^[A-Za-z0-9_]+$/.test(key) && typeof value === 'boolean')
                        features[key] = value;
                }
            }
            const resources = [...Array.from(document.scripts ?? [], script => script.src), ...performance.getEntriesByType('resource').map(entry => entry.name)];
            const assets = [...new Set(resources.filter(raw => {
                    try {
                        const url = new URL(raw);
                        return url.origin === 'https://abs.twimg.com' && /^\/responsive-web\/[A-Za-z0-9_./-]+\.js$/.test(url.pathname) && !url.search;
                    }
                    catch {
                        return false;
                    }
                }))].slice(0, 64);
            return { pageUrl: location.href, features, assets };
        }
        if (operation === 'account-bootstrap') {
            if (!accountInitial || !compatible(accountInitial.scope, current))
                return { available: false, reason: 'no-native-media-first-page' };
            return { available: true, data: accountInitial.data, userId: accountInitial.userId, request: accountInitial.request };
        }
        if (operation === 'bootstrap') {
            if (!initialPage || !compatible(initialPage.scope, current))
                return { available: false, scope: current, documentId: performance.timeOrigin };
            return { available: true, scope: current, documentId: performance.timeOrigin, data: initialPage.data };
        }
        if (operation === 'posts') {
            if (expectedScope !== current)
                throw new Error('画像取得中にページ・アカウントが変わりました。');
            const posts = (postIds ?? []).slice(0, 200).flatMap(id => {
                let record = postImages.get(id);
                if (!record?.complete || !postCompatible(record.scope, current)) {
                    renderedPost(id, current);
                    record = postImages.get(id);
                }
                if (!record || !postCompatible(record.scope, current))
                    return [];
                record.scope = current;
                return [{ postId: record.postId, urls: record.urls, videos: record.videos, complete: record.complete }];
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
