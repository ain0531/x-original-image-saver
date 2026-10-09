import { directBookmarks } from './direct-bookmarks.js';
export const BOOKMARK_FOLDER_KEY = 'specialSaveBookmarkFolders';
export class BookmarkFolders {
    constructor() {
        this.captures = Promise.resolve();
        this.authentication = new Map();
        // Observe the actual Web client's headers even when its fetch reference was
        // bound before our MAIN-world observer installed. Never replay transaction IDs.
        chrome.webRequest.onBeforeSendHeaders.addListener(details => {
            if (details.tabId < 0 || !/^https:\/\/x\.com\/i\/api\/graphql\/[A-Za-z0-9_-]+\/[A-Za-z0-9_]+(?:\?|$)/.test(details.url) || /\/(?:BookmarkFoldersSlice|bookmarkTweetToFolder)(?:\?|$)/.test(details.url))
                return;
            this.captures = this.captures.then(async () => {
                const identity = await directBookmarks.login(details.tabId);
                const captured = Object.fromEntries((details.requestHeaders ?? []).map(item => [item.name.toLowerCase(), item.value ?? '']));
                if (!captured.authorization?.startsWith('Bearer ') || captured['x-csrf-token'] !== identity.csrf || captured['x-guest-token'])
                    return;
                const headers = {};
                for (const name of ['authorization', 'x-csrf-token', 'x-twitter-auth-type', 'x-twitter-active-user', 'x-twitter-client-language', 'x-act-as-user-id']) {
                    if (captured[name])
                        headers[name] = captured[name];
                }
                this.authentication.set(identity.scope, { at: Date.now(), headers });
            }).catch(() => { });
        }, { urls: ['https://x.com/i/api/graphql/*'] }, ['requestHeaders']);
    }
    async nativeHeaders(identity) {
        const current = async () => {
            await this.captures;
            await directBookmarks.check(identity.storeId, identity.scope);
            const saved = this.authentication.get(identity.scope);
            return saved && Date.now() - saved.at < 300000 && saved.headers['x-csrf-token'] === identity.csrf ? saved.headers : undefined;
        };
        const saved = await current();
        if (saved)
            return saved;
        // A short native page load establishes the client's real authentication
        // without requiring the user to open a folder picker or replay a request.
        const tab = await chrome.tabs.create({ url: 'https://x.com/home', active: false });
        try {
            for (let attempt = 0; attempt < 100; attempt++) {
                const observed = await current();
                if (observed)
                    return observed;
                await new Promise(resolve => setTimeout(resolve, 100));
            }
            throw new Error('X標準通信の認証情報を自動取得できませんでした。フォルダ通信は開始していません。');
        }
        finally {
            if (tab.id !== undefined)
                await chrome.tabs.remove(tab.id).catch(() => { });
        }
    }
    async clear() { await chrome.storage.local.remove(BOOKMARK_FOLDER_KEY); return {}; }
    async settingsAccount(tabId, identity) {
        const cookies = await chrome.cookies.getAll({ url: 'https://x.com/', storeId: identity.storeId });
        await directBookmarks.check(identity.storeId, identity.scope);
        const twid = cookies.find(cookie => cookie.name === 'twid')?.value;
        let userId;
        try {
            userId = twid ? /^"?u=(\d+)"?$/.exec(decodeURIComponent(twid))?.[1] : undefined;
        }
        catch { /* Older sessions can still use their verified login key. */ }
        return userId ? `x-bookmark-account:${identity.storeId}:${userId}` : identity.scope;
    }
    async selection(account, legacyScope) {
        const stored = ((await chrome.storage.local.get(BOOKMARK_FOLDER_KEY))[BOOKMARK_FOLDER_KEY] ?? {});
        const selected = stored[account] ?? stored[legacyScope];
        if (selected && account !== legacyScope && !stored[account]) {
            stored[account] = selected;
            delete stored[legacyScope];
            await chrome.storage.local.set({ [BOOKMARK_FOLDER_KEY]: stored });
        }
        return selected;
    }
    async run(tabId, operation, identity, folderId, postId) {
        await directBookmarks.check((await directBookmarks.login(tabId)).storeId, identity.scope);
        const cacheKey = 'bookmarkFolderTemplates:' + identity.scope;
        const cached = (await chrome.storage.session.get(cacheKey))[cacheKey];
        // Chrome requires JSON-serializable arguments, including nested properties.
        const templates = JSON.parse(JSON.stringify(cached && Date.now() - cached.at < 3600000 ? cached.templates ?? {} : {}));
        const account = await this.settingsAccount(tabId, identity);
        const expectedUserId = /^x-bookmark-account:[^:]+:(\d+)$/.exec(account)?.[1] ?? '';
        const nativeHeaders = await this.nativeHeaders(identity);
        // Install lazily too: pages that were already open when the extension updated
        // need no manual visit to X's folder picker. The reader is versioned/idempotent.
        await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', files: ['dist/bookmark-folder-reader.js'] });
        const results = await chrome.scripting.executeScript({
            target: { tabId }, world: 'MAIN',
            func: async (operation, csrf, folderId, postId, templates, expectedUserId, nativeHeaders) => {
                const reader = window.__xOriginalBookmarkFolders;
                if (!reader)
                    throw new Error('Xのフォルダ取得処理を開始できませんでした。再試行してください。');
                return reader(operation, csrf, folderId, postId, templates, expectedUserId, nativeHeaders);
            }, args: [operation, identity.csrf, folderId ?? '', postId ?? '', templates, expectedUserId, nativeHeaders],
        });
        const current = await directBookmarks.login(tabId);
        if (current.scope !== identity.scope)
            throw new Error('処理中にXのアカウントが変わりました。再読み込みしてください。');
        const result = results[0]?.result;
        if (!result?.ok)
            throw new Error(result?.error ?? 'Xのフォルダ操作の応答を確認できません。');
        if (result.templates)
            await chrome.storage.session.set({ [cacheKey]: { at: Date.now(), templates: result.templates } });
        return result;
    }
    async list(tabId) {
        const identity = await directBookmarks.login(tabId);
        const account = await this.settingsAccount(tabId, identity);
        const result = await this.run(tabId, 'list', identity);
        return { folders: result.folders, account, selected: await this.selection(account, identity.scope) };
    }
    async select(tabId, expectedAccount, folderId) {
        const current = await this.list(tabId);
        if (current.account !== expectedAccount)
            throw new Error('Xのアカウントが変わりました。一覧を読み込み直してください。');
        const folder = current.folders.find(folder => folder.id === folderId);
        if (folderId && !folder)
            throw new Error('指定されたフォルダは存在しません。一覧を更新してください。');
        const stored = ((await chrome.storage.local.get(BOOKMARK_FOLDER_KEY))[BOOKMARK_FOLDER_KEY] ?? {});
        if (folder)
            stored[current.account] = folder;
        else
            delete stored[current.account];
        await chrome.storage.local.set({ [BOOKMARK_FOLDER_KEY]: stored });
        return { selected: folder };
    }
    async add(tabId, postId) {
        const identity = await directBookmarks.login(tabId);
        const account = await this.settingsAccount(tabId, identity);
        const selected = await this.selection(account, identity.scope);
        if (!selected)
            return { configured: false };
        const list = await this.run(tabId, 'list', identity);
        const folder = list.folders.find(folder => folder.id === selected.id);
        if (!folder)
            throw new Error('指定フォルダが見つかりません。オプションで保存先を選び直してください。');
        const result = await this.run(tabId, 'add', identity, folder.id, postId);
        if (result.verified !== true)
            throw new Error('指定フォルダ内への保存を確認できません。再試行してください。');
        return { configured: true, folder };
    }
}
