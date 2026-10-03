import { parseBookmarkPage } from './bookmarks.js';
import { network, assertBookmarkScope } from './sources.js';
const DIRECT_KEY = 'bookmarkDirect:';
const ORIGIN = 'https://x.com';
const BOOTSTRAP_TAB_KEY = 'bookmarkBootstrapTab';
const BOOTSTRAP_READY_KEY = 'bookmarkBootstrapReady:';
const validRoute = (raw) => {
    try {
        const u = new URL(raw);
        return u.origin === ORIGIN && /^\/i\/api\/graphql\/[A-Za-z0-9_-]+\/Bookmarks$/.test(u.pathname);
    }
    catch {
        return false;
    }
};
export function featureValues(text) {
    const values = {};
    // Parse literal values only; do not evaluate downloaded JavaScript.
    const boolean = (raw) => raw === 'true' || raw === '!0';
    for (const match of text.matchAll(/["']?([a-zA-Z0-9_]+)["']?\s*:\s*\{\s*["']?value["']?\s*:\s*(true|false|!0|!1)\s*(?=[,}])/g))
        values[match[1]] = boolean(match[2]);
    for (const match of text.matchAll(/["']?([a-zA-Z0-9_]+)["']?\s*:\s*(true|false|!0|!1)\s*(?=[,}])/g))
        if (!(match[1] in values))
            values[match[1]] = boolean(match[2]);
    return values;
}
export function clientBookmarkConfig(text, values, operation = 'Bookmarks') {
    const queryId = '["\']?queryId["\']?\\s*:\\s*["\']([A-Za-z0-9_-]+)["\']';
    const name = '["\']?operationName["\']?\\s*:\\s*["\']' + operation + '["\']';
    const match = new RegExp(queryId + '\\s*,\\s*' + name + '|' + name + '\\s*,\\s*' + queryId).exec(text);
    if (!match)
        return;
    const section = text.slice(match.index, match.index + 6000);
    const list = /["']?featureSwitches["']?\s*:\s*\[([^\]]*)\]/.exec(section)?.[1];
    if (list === undefined)
        return;
    const features = {};
    for (const name of list.matchAll(/["']([a-zA-Z0-9_]+)["']/g)) {
        const key = name[1];
        // Narrow compatibility setting, not a blanket false for unknown features.
        // Native captured requests also use false for this reply-downvote flag:
        // https://github.com/fa0311/twitter_api_safe_relay_skills/blob/main/skills/twitter-api-relay/requests.ndjson
        const value = typeof values[key] === 'boolean' ? values[key] : operation !== 'Bookmarks' && key === 'rweb_conversational_replies_downvote_enabled' ? false : undefined;
        if (typeof value !== 'boolean')
            throw new Error(`Xの${operation === 'Bookmarks' ? 'ブックマーク' : 'アカウントメディア'}取得設定を確認できません（不足: ${key}）。`);
        features[key] = value;
    }
    const token = /["'](AAAAAAA[A-Za-z0-9%_-]{30,})["']/.exec(text)?.[1];
    return { route: `${ORIGIN}/i/api/graphql/${match[1] ?? match[2]}/${operation}`, authorization: token ? `Bearer ${token}` : undefined, features };
}
export class DirectBookmarks {
    constructor() {
        this.captures = Promise.resolve();
        this.initialPages = new Map();
        this.recovery = this.cleanupBootstrap().catch(() => { });
        chrome.webRequest.onBeforeSendHeaders.addListener(details => {
            if (details.method !== 'GET' || details.tabId < 0)
                return;
            this.captures = this.captures.then(() => this.capture(details)).catch(() => { });
        }, { urls: [`${ORIGIN}/i/api/graphql/*`] }, ['requestHeaders']);
    }
    async cookieStore(tabId) {
        const stores = await chrome.cookies.getAllCookieStores();
        const store = stores.find(store => store.tabIds.includes(tabId));
        if (!store)
            throw new Error('Xのログイン状態を確認するブラウザーの領域を特定できません。');
        return store.id;
    }
    async identity(storeId) {
        const cookies = await chrome.cookies.getAll({ url: ORIGIN + '/', storeId });
        const auth = cookies.find(cookie => cookie.name === 'auth_token')?.value;
        const csrf = cookies.find(cookie => cookie.name === 'ct0')?.value;
        if (!auth || !csrf)
            throw new Error('Xにログインしてから再試行してください。');
        const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(auth));
        const fingerprint = Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
        return { storeId, csrf, scope: JSON.stringify([ORIGIN + '/i/bookmarks', 'Bookmarks', storeId + ':' + fingerprint]) };
    }
    async login(tabId) {
        const storeId = await this.cookieStore(tabId);
        const expected = chrome.extension.inIncognitoContext ? '1' : '0';
        if (storeId !== expected)
            throw new Error('このブラウザー領域では直接取得を実行できません。通常のウィンドウで実行してください。');
        return this.identity(storeId);
    }
    async sessionIdentity(storeId) { return this.identity(storeId); }
    async clientSession(storeId, scope) {
        await this.captures;
        await this.check(storeId, scope);
        const saved = (await chrome.storage.session.get(DIRECT_KEY + storeId))[DIRECT_KEY + storeId];
        return saved?.scope === scope ? { authorization: saved.authorization, features: saved.features ?? {} } : { features: {} };
    }
    async capture(details) {
        const headers = new Map((details.requestHeaders ?? []).map(header => [header.name.toLowerCase(), header.value ?? '']));
        const authorization = headers.get('authorization');
        if (!authorization?.startsWith('Bearer '))
            return;
        const storeId = await this.cookieStore(details.tabId);
        const identity = await this.identity(storeId);
        if (headers.get('x-csrf-token') !== identity.csrf)
            return;
        const key = DIRECT_KEY + storeId;
        const old = (await chrome.storage.session.get(key))[key];
        const url = new URL(details.url);
        let features = {};
        try {
            features = JSON.parse(url.searchParams.get('features') ?? '{}');
        }
        catch {
            return;
        }
        features = Object.fromEntries(Object.entries(features).filter(([, value]) => typeof value === 'boolean'));
        const same = old?.scope === identity.scope;
        await chrome.storage.session.set({ [key]: {
                scope: identity.scope, authorization, at: Date.now(),
                route: validRoute(details.url) ? details.url : same ? old?.route : undefined,
                features: { ...(same ? old?.features : {}), ...features },
            } });
    }
    async request(url, init = {}) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 15000);
        try {
            const response = await fetch(url, { ...init, signal: controller.signal });
            if (!response.ok)
                throw new Error(`ブックマークのデータ取得に失敗しました（HTTP ${response.status}）。`);
            return response;
        }
        catch (error) {
            if (controller.signal.aborted)
                throw new Error('ブックマークの通信が時間切れになりました。取得位置は保持します。');
            throw error;
        }
        finally {
            clearTimeout(timer);
        }
    }
    async template(identity) {
        await this.captures;
        const key = DIRECT_KEY + identity.storeId;
        const saved = (await chrome.storage.session.get(key))[key];
        const old = saved?.scope === identity.scope ? saved : undefined;
        if (old?.route && validRoute(old.route) && old.authorization && Date.now() - old.at < 3600000)
            return old;
        // Try text-only discovery before resorting to a temporary native X page.
        const response = await this.request(ORIGIN + '/i/bookmarks', { credentials: 'include' });
        if (/\/login|\/i\/flow\/login/.test(response.url))
            throw new Error('Xにログインしてから再試行してください。');
        const html = await response.text();
        const values = { ...old?.features, ...featureValues(html) };
        const assets = [...new Set(Array.from(html.matchAll(/https:\/\/abs\.twimg\.com\/responsive-web\/[A-Za-z0-9_./-]+\.js/g), match => match[0]))];
        assets.sort((a, b) => Number(!a.includes('/main.')) - Number(!b.includes('/main.')));
        let authorization = old?.authorization;
        for (const asset of assets.slice(0, 6)) {
            const js = await (await this.request(asset, { credentials: 'omit', redirect: 'error' })).text();
            const token = /["'](AAAAAAA[A-Za-z0-9%_-]{30,})["']/.exec(js)?.[1];
            if (token)
                authorization = `Bearer ${token}`;
            const config = clientBookmarkConfig(js, values);
            if (config && (config.authorization || authorization)) {
                const result = { scope: identity.scope, route: config.route, features: config.features, authorization: config.authorization ?? authorization, at: Date.now() };
                await chrome.storage.session.set({ [key]: result });
                return result;
            }
        }
        throw new Error('Xのブックマーク取得先を確認できません。');
    }
    async cleanupBootstrap() {
        const stored = (await chrome.storage.session.get(BOOTSTRAP_TAB_KEY))[BOOTSTRAP_TAB_KEY];
        if (!stored || !Number.isInteger(stored.tabId) || stored.tabId < 0)
            return;
        try {
            await chrome.tabs.remove(stored.tabId);
        }
        catch {
            try {
                await chrome.tabs.get(stored.tabId);
            }
            catch {
                await chrome.storage.session.remove(BOOTSTRAP_TAB_KEY);
                return;
            }
            throw new Error('初回取得用タブを閉じられませんでした。タブを閉じて再試行してください。');
        }
        await chrome.storage.session.remove(BOOTSTRAP_TAB_KEY);
    }
    async bootstrap(identity, originalTabId) {
        const original = await chrome.tabs.get(originalTabId);
        // Only tabs created here are owned and closed. Existing user tabs stay open.
        const tab = await chrome.tabs.create({ windowId: original.windowId, url: ORIGIN + '/i/bookmarks', active: false });
        if (tab.id === undefined)
            throw new Error('初回取得用タブを開けませんでした。');
        try {
            await chrome.storage.session.set({ [BOOTSTRAP_TAB_KEY]: { tabId: tab.id } });
            const deadline = Date.now() + 30000;
            while (Date.now() < deadline) {
                await this.check(identity.storeId, identity.scope);
                const live = await chrome.tabs.get(tab.id);
                const url = live.url ?? '';
                if (/\/login|\/i\/flow\/login/.test(url))
                    throw new Error('Xにログインしてから再試行してください。');
                if (url.startsWith(ORIGIN + '/i/bookmarks') || url === ORIGIN + '/i/history') {
                    // The document-start reader returns native JSON, never DOM images.
                    let result;
                    try {
                        result = await network(tab.id, 'bootstrap');
                    }
                    catch (error) {
                        if (live.status === 'complete')
                            throw error;
                    }
                    if (result?.available && result.page) {
                        // X may redirect to /i/history and finish its request before the
                        // selected bookmark tab is mounted. Wait for the scope to settle.
                        if (url === ORIGIN + '/i/history' && !String(JSON.parse(result.scope)[1] ?? '').trim()) {
                            await new Promise(resolve => setTimeout(resolve, 250));
                            continue;
                        }
                        assertBookmarkScope(url, result.scope);
                        await this.captures;
                        await this.check(identity.storeId, identity.scope);
                        const saved = (await chrome.storage.session.get(DIRECT_KEY + identity.storeId))[DIRECT_KEY + identity.storeId];
                        if (saved?.scope === identity.scope && saved.route && validRoute(saved.route) && saved.authorization) {
                            await chrome.storage.session.set({ [BOOTSTRAP_READY_KEY + identity.storeId]: identity.scope });
                            return result.page;
                        }
                    }
                }
                await new Promise(resolve => setTimeout(resolve, 250));
            }
            throw new Error('初回のブックマーク通信を30秒以内に確認できませんでした。');
        }
        finally {
            // Also close on timeout, logout, parsing error and failed initialization.
            try {
                await chrome.tabs.remove(tab.id);
            }
            catch {
                let exists = true;
                try {
                    await chrome.tabs.get(tab.id);
                }
                catch {
                    exists = false;
                }
                if (exists)
                    throw new Error('初回取得用タブを閉じられませんでした。');
            }
            await chrome.storage.session.remove(BOOTSTRAP_TAB_KEY);
        }
    }
    async prepare(tabId) {
        await this.recovery;
        await this.cleanupBootstrap();
        const storeId = await this.cookieStore(tabId);
        const identity = await this.identity(storeId);
        // fetch() uses this extension context's default cookie store. Never cross
        // into an incognito store in a spanning extension.
        const expected = chrome.extension.inIncognitoContext ? '1' : '0';
        if (storeId !== expected)
            throw new Error('このブラウザー領域では直接取得を実行できません。通常のウィンドウで実行してください。');
        try {
            // Verify the first real response before reporting that saving has started.
            this.initialPages.set(identity.scope, await this.fetchPage(storeId, identity.scope));
        }
        catch (error) {
            await this.check(storeId, identity.scope);
            const message = error instanceof Error ? error.message : String(error);
            if (/HTTP 429|ログイン/.test(message))
                throw error;
            const readyKey = BOOTSTRAP_READY_KEY + storeId;
            if ((await chrome.storage.session.get(readyKey))[readyKey] === identity.scope)
                throw error;
            this.initialPages.set(identity.scope, await this.bootstrap(identity, tabId));
        }
        return { storeId, scope: identity.scope };
    }
    async check(storeId, expectedScope) {
        if ((await this.identity(storeId)).scope !== expectedScope)
            throw new Error('Xのログイン・アカウントが変わりました。元のアカウントで再開してください。');
    }
    async page(storeId, expectedScope, cursor) {
        await this.check(storeId, expectedScope);
        if (!cursor && this.initialPages.has(expectedScope)) {
            const page = this.initialPages.get(expectedScope);
            this.initialPages.delete(expectedScope);
            return page;
        }
        return this.fetchPage(storeId, expectedScope, cursor);
    }
    async fetchPage(storeId, expectedScope, cursor) {
        const identity = await this.identity(storeId);
        if (identity.scope !== expectedScope)
            throw new Error('Xのログイン・アカウントが変わりました。取得位置を保持して停止します。');
        const template = await this.template(identity);
        const url = new URL(template.route);
        if (!validRoute(url.toString()))
            throw new Error('ブックマーク以外の取得先は使用できません。');
        const variables = { count: 20, includePromotedContent: false, ...(cursor ? { cursor } : {}) };
        url.searchParams.set('variables', JSON.stringify(variables));
        url.searchParams.set('features', JSON.stringify(template.features ?? {}));
        let response;
        try {
            response = await this.request(url.toString(), { credentials: 'include', redirect: 'error', headers: {
                    authorization: template.authorization, 'x-csrf-token': identity.csrf,
                    'x-twitter-auth-type': 'OAuth2Session', 'x-twitter-active-user': 'yes',
                } });
        }
        catch (error) {
            await chrome.storage.session.remove(DIRECT_KEY + storeId);
            throw error;
        }
        try {
            const body = await response.json();
            await this.check(storeId, expectedScope);
            return parseBookmarkPage(body);
        }
        catch (error) {
            await chrome.storage.session.remove(DIRECT_KEY + storeId);
            throw error;
        }
    }
}
export const directBookmarks = new DirectBookmarks();
