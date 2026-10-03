import { parseAccountMediaPage, AccountMediaResponseError } from './bookmarks.js';
import { directBookmarks, clientBookmarkConfig, featureValues } from './direct-bookmarks.js';
import { isXPage } from './media.js';
const ACCOUNT_DIRECT_KEY = 'accountMediaDirect:';
const ACCOUNT_BOOTSTRAP_KEY = 'accountMediaBootstrapTab';
const ACCOUNT_READY_KEY = 'accountMediaBootstrapReady:';
const ACCOUNT_ORIGIN = 'https://x.com';
export function accountMediaTarget(raw) {
    let url;
    try {
        url = new URL(raw);
    }
    catch {
        throw new Error('保存したいアカウントのページを開いてください。');
    }
    const match = url.pathname.match(/^\/([A-Za-z0-9_]{1,15})(?:\/|$)/);
    const mediaPage = /^\/[^/]+\/media\/?$/.test(url.pathname);
    const filter = url.searchParams.get('filter');
    if (!isXPage(raw) || !match || ['i', 'home', 'explore', 'settings', 'search', 'messages', 'notifications', 'compose', 'login', 'logout', 'signup', 'account', 'intent', 'oauth', 'hashtag', 'grok', 'tos', 'privacy', 'download', 'about', 'jobs', 'who_to_follow', 'lists'].includes(match[1].toLowerCase()) || (mediaPage && filter !== null && filter !== 'photo'))
        throw new Error('保存したいアカウントのページを開いてください。');
    const handle = match[1].toLowerCase();
    const photoOnly = mediaPage && filter === 'photo';
    return { handle, photoOnly, url: `${ACCOUNT_ORIGIN}/${handle}/media${photoOnly ? '?filter=photo' : ''}` };
}
function accountOperation(raw) {
    try {
        const url = new URL(raw);
        if (url.origin !== ACCOUNT_ORIGIN)
            return;
        return url.pathname.match(/^\/i\/api\/graphql\/[A-Za-z0-9_-]+\/(UserMedia|UserByScreenName)$/)?.[1];
    }
    catch {
        return;
    }
}
export function assertAccountMediaScope(url, scope) {
    try {
        const [target, kind, login, userId] = JSON.parse(scope);
        if (accountMediaTarget(url).url === url && target === url && kind === 'UserMedia' && typeof login === 'string' && /^\d+:/.test(login) && /^\d+$/.test(userId))
            return;
    }
    catch { /* Unknown targets never authorize account media downloads. */ }
    throw new Error('個別アカウントのメディア保存対象を確認できません。');
}
export class DirectAccountMedia {
    constructor() {
        this.captures = Promise.resolve();
        this.initialPages = new Map();
        this.recovery = this.cleanup().catch(() => { });
        chrome.webRequest.onBeforeSendHeaders.addListener(details => {
            if (['GET', 'POST'].includes(details.method) && details.tabId >= 0 && accountOperation(details.url))
                this.captures = this.captures.then(() => this.capture(details)).catch(() => { });
        }, { urls: [`${ACCOUNT_ORIGIN}/i/api/graphql/*`] }, ['requestHeaders']);
    }
    key(storeId, photoOnly) { return ACCOUNT_DIRECT_KEY + storeId + ':' + (photoOnly ? 'photo' : 'all'); }
    async capture(details) {
        const tab = await chrome.tabs.get(details.tabId);
        const target = accountMediaTarget(tab.url ?? '');
        const identity = await directBookmarks.login(details.tabId);
        const headers = new Map((details.requestHeaders ?? []).map(header => [header.name.toLowerCase(), header.value ?? '']));
        const authorization = headers.get('authorization');
        if (!authorization?.startsWith('Bearer ') || (headers.has('x-csrf-token') && headers.get('x-csrf-token') !== identity.csrf))
            return;
        const url = new URL(details.url);
        const variables = JSON.parse(url.searchParams.get('variables') ?? 'null');
        const operation = accountOperation(details.url);
        const validVariables = variables && typeof variables === 'object' && !Array.isArray(variables) && (operation === 'UserMedia' ? typeof variables.userId === 'string' && /^\d+$/.test(variables.userId) : String(variables.screen_name).toLowerCase() === target.handle);
        // Keep features, fieldToggles and other query fields exactly as X sent them.
        const key = this.key(identity.storeId, target.photoOnly);
        const old = (await chrome.storage.session.get(key))[key];
        const template = { ...(old?.loginScope === identity.scope ? old : {}), loginScope: identity.scope, authorization, at: Date.now() };
        if (validVariables && details.method === 'GET') {
            template.lastTabId = details.tabId;
            template[operation === 'UserMedia' ? 'media' : 'lookup'] = { url: url.toString(), variables };
        }
        await chrome.storage.session.set({ [key]: template });
    }
    async request(url, init = {}, timeoutMs = 15000) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const response = await fetch(url, { ...init, signal: controller.signal });
            if (!response.ok)
                throw new Error(`アカウントのメディア取得に失敗しました（HTTP ${response.status}）。`);
            return response;
        }
        catch (error) {
            if (controller.signal.aborted)
                throw new Error('アカウントのメディア通信が時間切れになりました。取得位置は保持します。');
            throw error;
        }
        finally {
            clearTimeout(timer);
        }
    }
    async clientConfig(tabId, target) {
        const [read] = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', args: ['account-config'], func: async (operation) => {
                const reader = window.__xImageBookmarkReader;
                return reader ? await reader(operation) : undefined;
            } });
        const result = read?.result;
        if (!result?.pageUrl || accountMediaTarget(result.pageUrl).handle !== target.handle)
            return;
        const live = await chrome.tabs.get(tabId);
        if (accountMediaTarget(live.url ?? '').handle !== target.handle)
            throw new Error('取得設定の確認中に対象アカウントが変わりました。');
        const features = Object.fromEntries(Object.entries(result.features ?? {}).filter(([name, value]) => /^[A-Za-z0-9_]+$/.test(name) && typeof value === 'boolean'));
        const assets = (Array.isArray(result.assets) ? result.assets : []).filter((raw) => {
            try {
                const url = new URL(String(raw));
                return url.origin === 'https://abs.twimg.com' && /^\/responsive-web\/[A-Za-z0-9_./-]+\.js$/.test(url.pathname) && !url.search;
            }
            catch {
                return false;
            }
        }).slice(0, 64);
        return { pageUrl: result.pageUrl, features, assets };
    }
    async template(storeId, loginScope, target, requireLookup = true, client) {
        await this.captures;
        const key = this.key(storeId, target.photoOnly);
        const stored = (await chrome.storage.session.get(key))[key];
        if (stored?.loginScope === loginScope && stored.media && (!requireLookup || stored.lookup) && stored.authorization && Date.now() - stored.at < 3600000)
            return stored;
        const identity = await directBookmarks.sessionIdentity(storeId);
        if (identity.scope !== loginScope)
            throw new Error('Xのログイン・アカウントが変わりました。');
        const response = await this.request(target.url, { credentials: 'include' });
        if (/\/login|\/i\/flow\/login/.test(response.url))
            throw new Error('Xにログインしてから再試行してください。');
        const html = await response.text();
        const shared = await directBookmarks.clientSession(storeId, loginScope);
        const values = { ...shared.features, ...featureValues(html), ...client?.features };
        if (stored?.loginScope === loginScope)
            for (const route of [stored.lookup, stored.media]) {
                if (!route)
                    continue;
                try {
                    for (const [name, value] of Object.entries(JSON.parse(new URL(route.url).searchParams.get('features') ?? '{}')))
                        if (typeof value === 'boolean' && !(name in values))
                            values[name] = value;
                }
                catch { /* Only proven boolean feature values are reused. */ }
            }
        const assets = [...new Set([...client?.assets ?? [], ...Array.from(html.matchAll(/https:\/\/abs\.twimg\.com\/responsive-web\/[A-Za-z0-9_./-]+\.js/g), match => match[0])])];
        assets.sort((a, b) => Number(!a.includes('/main.')) - Number(!b.includes('/main.')));
        const result = { ...(stored?.loginScope === loginScope ? stored : {}), loginScope, authorization: (stored?.loginScope === loginScope ? stored.authorization : '') || shared.authorization || '', at: Date.now() };
        let configurationError;
        const discoveryDeadline = Date.now() + 15000;
        let scanned = 0;
        const pendingScripts = [];
        for (let offset = 0; offset < Math.min(assets.length, 64) && Date.now() < discoveryDeadline; offset += 4) {
            const scripts = await Promise.allSettled(assets.slice(offset, offset + 4).map(async (asset) => (await this.request(asset, { credentials: 'omit', redirect: 'error' }, Math.max(1, discoveryDeadline - Date.now()))).text()));
            for (const script of scripts) {
                scanned++;
                if (script.status === 'rejected') {
                    configurationError = script.reason;
                    continue;
                }
                pendingScripts.push(script.value);
                for (const [name, value] of Object.entries(featureValues(script.value)))
                    if (!(name in values))
                        values[name] = value;
            }
            // Definitions may be in a later chunk than the operation metadata.
            for (const js of pendingScripts) {
                const token = /["'](AAAAAAA[A-Za-z0-9%_-]{30,})["']/.exec(js)?.[1];
                if (token)
                    result.authorization = `Bearer ${token}`;
                for (const operation of ['UserMedia', 'UserByScreenName']) {
                    const field = operation === 'UserMedia' ? 'media' : 'lookup';
                    if (result[field])
                        continue;
                    let config;
                    try {
                        config = clientBookmarkConfig(js, values, operation);
                    }
                    catch (error) {
                        configurationError = error;
                        continue;
                    }
                    if (!config)
                        continue;
                    const url = new URL(config.route);
                    url.searchParams.set('features', JSON.stringify(config.features));
                    result[field] = { url: url.toString(), variables: {} };
                    result.authorization = config.authorization ?? result.authorization;
                }
                if (result.media && (!requireLookup || result.lookup) && result.authorization) {
                    for (const route of [result.media, result.lookup]) {
                        if (!route || route.method === 'POST')
                            continue;
                        const endpoint = new URL(route.url);
                        const flags = JSON.parse(endpoint.searchParams.get('features') ?? '{}');
                        for (const name of Object.keys(flags))
                            if (typeof values[name] === 'boolean')
                                flags[name] = values[name];
                        endpoint.searchParams.set('features', JSON.stringify(flags));
                        route.url = endpoint.toString();
                    }
                    await directBookmarks.check(storeId, loginScope);
                    await chrome.storage.session.set({ [key]: result });
                    return result;
                }
            }
        }
        throw configurationError ?? new Error(`Xのアカウントメディア取得設定を確認できません（公開スクリプト${scanned}件を確認）。`);
    }
    async query(storeId, loginScope, template, route, operation, variables) {
        const identity = await directBookmarks.sessionIdentity(storeId);
        if (identity.scope !== loginScope)
            throw new Error('Xのログイン・アカウントが変わりました。');
        if (accountOperation(route.url) !== operation)
            throw new Error('メディア以外の取得先は使用できません。');
        const url = new URL(route.url);
        const post = route.method === 'POST';
        if (!post)
            url.searchParams.set('variables', JSON.stringify(variables));
        const response = await this.request(url.toString(), { method: post ? 'POST' : 'GET', ...(post ? { body: JSON.stringify({ variables, features: route.features ?? {}, fieldToggles: route.fieldToggles ?? {} }) } : {}), credentials: 'include', redirect: 'error', headers: { authorization: template.authorization, 'x-csrf-token': identity.csrf, 'x-twitter-auth-type': 'OAuth2Session', 'x-twitter-active-user': 'yes', ...(post ? { 'content-type': 'application/json' } : {}) } });
        const body = await response.json();
        await directBookmarks.check(storeId, loginScope);
        if (body?.errors?.length)
            throw new Error('Xがアカウントの投稿データ取得エラーを返しました。');
        return body;
    }
    async first(storeId, loginScope, target, client) {
        await this.captures;
        const stored = (await chrome.storage.session.get(this.key(storeId, target.photoOnly)))[this.key(storeId, target.photoOnly)];
        const owner = stored?.loginScope === loginScope && stored.owner?.handle === target.handle ? stored.owner : undefined;
        const template = await this.template(storeId, loginScope, target, !owner, client);
        if (owner) {
            const scope = JSON.stringify([target.url, 'UserMedia', JSON.parse(loginScope)[2], owner.userId]);
            return { scope, page: await this.fetchPage(storeId, scope, template) };
        }
        const variables = { ...template.lookup.variables, screen_name: target.handle };
        delete variables.cursor;
        const user = (await this.query(storeId, loginScope, template, template.lookup, 'UserByScreenName', variables))?.data?.user?.result;
        const handle = user?.legacy?.screen_name ?? user?.core?.screen_name;
        if (typeof user?.rest_id !== 'string' || !/^\d+$/.test(user.rest_id) || (handle && String(handle).toLowerCase() !== target.handle))
            throw new Error('対象アカウントを特定できません。非公開・削除・アクセス不能の可能性があります。');
        const scope = JSON.stringify([target.url, 'UserMedia', JSON.parse(loginScope)[2], user.rest_id]);
        await chrome.storage.session.set({ [this.key(storeId, target.photoOnly)]: { ...template, owner: { handle: target.handle, userId: user.rest_id } } });
        return { scope, page: await this.fetchPage(storeId, scope, template) };
    }
    async nativeFirst(tabId, storeId, loginScope, target) {
        const [read] = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', args: ['account-bootstrap'], func: async (operation) => {
                const reader = window.__xImageBookmarkReader;
                return reader ? await reader(operation) : { available: false };
            } });
        const result = read?.result;
        if (!result?.available || !result.request || typeof result.userId !== 'string')
            return;
        const live = await chrome.tabs.get(tabId);
        if (accountMediaTarget(live.url ?? '').url !== target.url || !/^\/[^/]+\/media\/?$/.test(new URL(live.url).pathname))
            throw new Error('ネイティブ応答の取得対象が変わりました。');
        const route = result.request;
        if (accountOperation(route.url) !== 'UserMedia' || !['GET', 'POST'].includes(route.method ?? 'GET') || route.variables?.userId !== result.userId || route.variables.cursor)
            throw new Error('アカウントの先頭メディア応答を確認できません。');
        const page = parseAccountMediaPage(result.data, result.userId, target.photoOnly);
        await this.captures;
        await directBookmarks.check(storeId, loginScope);
        const key = this.key(storeId, target.photoOnly);
        const stored = (await chrome.storage.session.get(key))[key];
        const shared = await directBookmarks.clientSession(storeId, loginScope);
        const authorization = (stored?.loginScope === loginScope ? stored.authorization : '') || shared.authorization || '';
        await chrome.storage.session.set({ [key]: { ...(stored?.loginScope === loginScope ? stored : {}), loginScope, authorization, at: Date.now(), lastTabId: tabId, media: route, owner: { handle: target.handle, userId: result.userId } } });
        return { scope: JSON.stringify([target.url, 'UserMedia', JSON.parse(loginScope)[2], result.userId]), page };
    }
    async cleanup() {
        const owned = (await chrome.storage.session.get(ACCOUNT_BOOTSTRAP_KEY))[ACCOUNT_BOOTSTRAP_KEY];
        if (!owned || !Number.isInteger(owned.tabId))
            return;
        try {
            await chrome.tabs.remove(owned.tabId);
        }
        catch {
            try {
                await chrome.tabs.get(owned.tabId);
            }
            catch {
                await chrome.storage.session.remove(ACCOUNT_BOOTSTRAP_KEY);
                return;
            }
            throw new Error('メディア取得用タブを閉じられませんでした。');
        }
        await chrome.storage.session.remove(ACCOUNT_BOOTSTRAP_KEY);
    }
    async bootstrap(storeId, loginScope, target, originalTabId, originalError) {
        const original = await chrome.tabs.get(originalTabId);
        const tab = await chrome.tabs.create({ windowId: original.windowId, url: target.url, active: false });
        if (tab.id === undefined)
            throw new Error('メディア取得用タブを開けませんでした。');
        try {
            await chrome.storage.session.set({ [ACCOUNT_BOOTSTRAP_KEY]: { tabId: tab.id } });
            const deadline = Date.now() + 30000;
            let attemptedConfig = '';
            let configCheckAt = 0;
            let configurationError = '';
            while (Date.now() < deadline) {
                await directBookmarks.check(storeId, loginScope);
                const live = await chrome.tabs.get(tab.id);
                if (/\/login|\/i\/flow\/login/.test(live.url ?? ''))
                    throw new Error('Xにログインしてから再試行してください。');
                if (live.status === 'complete' && accountMediaTarget(live.url ?? '').url !== target.url)
                    throw new Error('取得用タブが別のアカウント・ページへ移動しました。');
                await this.captures;
                const template = (await chrome.storage.session.get(this.key(storeId, target.photoOnly)))[this.key(storeId, target.photoOnly)];
                const native = await this.nativeFirst(tab.id, storeId, loginScope, target);
                if (native)
                    return native;
                if (template?.loginScope === loginScope && template.lastTabId === tab.id && template.media && template.lookup)
                    return await this.first(storeId, loginScope, target);
                if (live.status === 'complete' && Date.now() >= configCheckAt) {
                    configCheckAt = Date.now() + 1000;
                    const config = await this.clientConfig(tab.id, target);
                    const fingerprint = config ? JSON.stringify([config.assets, config.features]) : '';
                    if (config?.assets.length && fingerprint !== attemptedConfig) {
                        attemptedConfig = fingerprint;
                        try {
                            return await this.first(storeId, loginScope, target, config);
                        }
                        catch (error) {
                            await directBookmarks.check(storeId, loginScope);
                            if (error instanceof AccountMediaResponseError)
                                throw error;
                            const message = error instanceof Error ? error.message : String(error);
                            if (/HTTP|^Xにログインして|非公開・削除|投稿データ取得エラー/.test(message))
                                throw error;
                            configurationError = message;
                        }
                    }
                }
                await new Promise(resolve => setTimeout(resolve, 250));
            }
            const state = (await chrome.storage.session.get(this.key(storeId, target.photoOnly)))[this.key(storeId, target.photoOnly)];
            throw new Error(`初回のメディア応答を30秒以内に確認できませんでした。取得先: ${state?.media ? '確認済み' : '未確認'}。直接取得のエラー: ${configurationError || originalError}`);
        }
        finally {
            await this.cleanupOwned(tab.id);
        }
    }
    async cleanupOwned(tabId) {
        try {
            await chrome.tabs.remove(tabId);
        }
        catch {
            try {
                await chrome.tabs.get(tabId);
            }
            catch {
                await chrome.storage.session.remove(ACCOUNT_BOOTSTRAP_KEY);
                return;
            }
            throw new Error('メディア取得用タブを閉じられませんでした。');
        }
        await chrome.storage.session.remove(ACCOUNT_BOOTSTRAP_KEY);
    }
    async prepare(tabId) {
        await this.recovery;
        await this.cleanup();
        const tab = await chrome.tabs.get(tabId);
        const target = accountMediaTarget(tab.url ?? '');
        const identity = await directBookmarks.login(tabId);
        let initial;
        const stored = (await chrome.storage.session.get(this.key(identity.storeId, target.photoOnly)))[this.key(identity.storeId, target.photoOnly)];
        const knownOwner = stored?.loginScope === identity.scope && stored.owner?.handle === target.handle;
        try {
            const native = !knownOwner && /^\/[^/]+\/media\/?$/.test(new URL(tab.url).pathname) ? await this.nativeFirst(tabId, identity.storeId, identity.scope, target) : undefined;
            initial = native ?? await this.first(identity.storeId, identity.scope, target, await this.clientConfig(tabId, target));
        }
        catch (error) {
            await directBookmarks.check(identity.storeId, identity.scope);
            if (error instanceof AccountMediaResponseError)
                throw error;
            const message = error instanceof Error ? error.message : String(error);
            // Configuration hints contain "ログイン済み" too; they are not login errors.
            if (/HTTP 429|^Xにログインして|^Xのログイン・アカウントが変|非公開・削除/.test(message))
                throw error;
            const key = ACCOUNT_READY_KEY + target.url;
            if ((await chrome.storage.session.get(key))[key] === identity.scope)
                throw error;
            // Retain partial learned settings; wait for a fresh capture from our owned tab.
            initial = await this.bootstrap(identity.storeId, identity.scope, target, tabId, message);
            await chrome.storage.session.set({ [key]: identity.scope });
        }
        const current = await chrome.tabs.get(tabId);
        if (accountMediaTarget(current.url ?? '').handle !== target.handle)
            throw new Error('開始準備中に対象アカウントのページが変わりました。');
        this.initialPages.set(initial.scope, initial.page);
        return { storeId: identity.storeId, scope: initial.scope, url: target.url };
    }
    async check(storeId, scope) {
        const [url, , login] = JSON.parse(scope);
        assertAccountMediaScope(url, scope);
        await directBookmarks.check(storeId, JSON.stringify([ACCOUNT_ORIGIN + '/i/bookmarks', 'Bookmarks', login]));
    }
    async page(storeId, scope, cursor) {
        await this.check(storeId, scope);
        if (!cursor && this.initialPages.has(scope)) {
            const page = this.initialPages.get(scope);
            this.initialPages.delete(scope);
            return page;
        }
        return this.fetchPage(storeId, scope, undefined, cursor);
    }
    async fetchPage(storeId, scope, supplied, cursor) {
        await this.check(storeId, scope);
        const [url, , login, userId] = JSON.parse(scope);
        const target = accountMediaTarget(url);
        const loginScope = JSON.stringify([ACCOUNT_ORIGIN + '/i/bookmarks', 'Bookmarks', login]);
        const template = supplied ?? await this.template(storeId, loginScope, target, false);
        const variables = { ...template.media.variables, userId, count: 20, includePromotedContent: false };
        if (cursor)
            variables.cursor = cursor;
        else
            delete variables.cursor;
        const body = await this.query(storeId, loginScope, template, template.media, 'UserMedia', variables);
        const returnedHandle = body?.data?.user?.result?.core?.screen_name ?? body?.data?.user?.result?.legacy?.screen_name;
        if (returnedHandle !== undefined && (typeof returnedHandle !== 'string' || returnedHandle.toLowerCase() !== target.handle))
            throw new AccountMediaResponseError('取得したメディア一覧のアカウント名が対象と一致しません。');
        return parseAccountMediaPage(body, userId, target.photoOnly, variables.userId);
    }
}
export const directAccountMedia = new DirectAccountMedia();
