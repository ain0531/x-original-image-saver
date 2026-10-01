import { parseBookmarkPage } from './bookmarks.js';
const DIRECT_KEY = 'bookmarkDirect:';
const ORIGIN = 'https://x.com';
const validRoute = (raw) => {
    try {
        const u = new URL(raw);
        return u.origin === ORIGIN && /^\/i\/api\/graphql\/[A-Za-z0-9_-]+\/Bookmarks$/.test(u.pathname);
    }
    catch {
        return false;
    }
};
function featureValues(text) {
    const values = {};
    for (const match of text.matchAll(/"([a-zA-Z0-9_]+)"\s*:\s*\{\s*"value"\s*:\s*(true|false)/g))
        values[match[1]] = match[2] === 'true';
    return values;
}
export function clientBookmarkConfig(text, values) {
    const match = /queryId\s*:\s*"([A-Za-z0-9_-]+)"\s*,\s*operationName\s*:\s*"Bookmarks"/.exec(text);
    if (!match)
        return;
    const section = text.slice(match.index, match.index + 6000);
    const list = /featureSwitches\s*:\s*\[([^\]]*)\]/.exec(section)?.[1];
    if (list === undefined)
        return;
    const features = {};
    for (const name of list.matchAll(/"([a-zA-Z0-9_]+)"/g)) {
        if (typeof values[name[1]] !== 'boolean')
            throw new Error('Xのブックマーク取得設定を確認できません。ログイン済みのXを再読み込みして再試行してください。');
        features[name[1]] = values[name[1]];
    }
    const token = /["'](AAAAAAA[A-Za-z0-9%_-]{30,})["']/.exec(text)?.[1];
    return { route: `${ORIGIN}/i/api/graphql/${match[1]}/Bookmarks`, authorization: token ? `Bearer ${token}` : undefined, features };
}
export class DirectBookmarks {
    constructor() {
        this.captures = Promise.resolve();
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
        // Fetch text only. Never navigate a tab, execute remote code, or embed X.
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
        throw new Error('Xのブックマーク取得先を確認できません。ログイン済みのXを再読み込みして再試行してください。タブは自動で開きません。');
    }
    async prepare(tabId) {
        const storeId = await this.cookieStore(tabId);
        const identity = await this.identity(storeId);
        // fetch() uses this extension context's default cookie store. Never cross
        // into an incognito store in a spanning extension.
        const expected = chrome.extension.inIncognitoContext ? '1' : '0';
        if (storeId !== expected)
            throw new Error('このブラウザー領域では直接取得を実行できません。通常のウィンドウで実行してください。');
        await this.template(identity);
        return { storeId, scope: identity.scope };
    }
    async check(storeId, expectedScope) {
        if ((await this.identity(storeId)).scope !== expectedScope)
            throw new Error('Xのログイン・アカウントが変わりました。元のアカウントで再開してください。');
    }
    async page(storeId, expectedScope, cursor) {
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
