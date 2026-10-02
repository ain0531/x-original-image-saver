import { parseMediaUrl, isXPage, tweetMedia } from './media.js';
import { parseBookmarkPage } from './bookmarks.js';
export function assertBookmarkScope(pageUrl, scope) {
    let valid = false;
    try {
        const [url, selected] = JSON.parse(scope);
        const path = new URL(pageUrl).pathname;
        valid = isXPage(pageUrl) && url === pageUrl &&
            (/^\/i\/bookmarks(?:\/[^/]+)*\/?$/.test(path) ||
                /^\/i\/history\/?$/.test(path) && /^(ブックマーク|Bookmarks)[▼▾⌄]?$/i.test(String(selected).replace(/\s/g, '')));
    }
    catch { /* Unknown page state cannot authorize a bookmark save. */ }
    if (!valid)
        throw new Error('ブックマークのページを開いてから画像をまとめて保存してください。履歴ページでは「ブックマーク」を選択してください。');
}
export async function snapshot(tabId, current = false, targetPostId) {
    const args = targetPostId ? [current, targetPostId] : [current];
    const [injection] = await chrome.scripting.executeScript({ target: { tabId }, args, func: (current, targetPostId) => {
            const root = document.querySelector('[data-testid="primaryColumn"]') ?? document.querySelector('main');
            if (!root)
                throw new Error('投稿一覧を確認できません。Xのページを開いてください。');
            const selected = root.querySelector('[role="tab"][aria-selected="true"]');
            const account = document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"]')?.textContent ?? '';
            const scope = JSON.stringify([location.href, selected?.textContent ?? '', account]);
            let articles = Array.from(root.querySelectorAll('article'));
            const postId = (article) => {
                const link = Array.from(article.querySelectorAll('a[href]')).find(link => link.querySelector('time') && link.closest('article') === article);
                return link ? new URL(link.href, location.href).pathname.match(/\/status\/(\d+)/)?.[1] ?? '' : '';
            };
            if (current) {
                const id = targetPostId ?? location.pathname.match(/\/status\/(\d+)/)?.[1];
                const selected = id ? articles.find(article => postId(article) === id) : articles.find(article => {
                    const rect = article.getBoundingClientRect();
                    return rect.bottom > 0 && rect.top < window.innerHeight;
                });
                if (!selected)
                    throw new Error('現在の投稿を特定できません。投稿の詳細ページを開いてください。');
                articles = [selected];
            }
            const unconfirmed = current ? [] : articles.filter(article => !Array.from(article.querySelectorAll('[data-testid="removeBookmark"]')).some(button => button.closest('article') === article));
            if (!current)
                articles = articles.filter(article => !unconfirmed.includes(article));
            const urls = new Set();
            const issues = [];
            for (const article of articles) {
                for (const image of Array.from(article.querySelectorAll('img'))) {
                    const url = image.currentSrc || image.getAttribute('src') || '';
                    if (/^https:\/\/pbs\.twimg\.com\/media\//.test(url))
                        urls.add(url);
                }
                for (const photo of Array.from(article.querySelectorAll('[data-testid="tweetPhoto"]'))) {
                    if (!Array.from(photo.querySelectorAll('img')).some(image => /^https:\/\/pbs\.twimg\.com\/media\//.test(image.currentSrc || image.getAttribute('src') || ''))) {
                        issues.push(`投稿 ${postId(article) || '不明'}: 読み込まれていない画像があります。`);
                    }
                }
                if (article.querySelector('[data-testid="sensitiveMediaInterstitial"]'))
                    issues.push(`投稿 ${postId(article) || '不明'}: 非表示の画像があります。`);
                if (article.querySelector('[data-testid="videoPlayer"], video'))
                    issues.push(`投稿 ${postId(article) || '不明'}: 動画の全データを確認できません。`);
            }
            return { pageUrl: location.href, scope, documentId: performance.timeOrigin, urls: [...urls], posts: articles.map(postId), issues, excludedPosts: unconfirmed.length,
                loading: !!root.querySelector('[role="progressbar"]'), y: window.scrollY,
                bottom: window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 50 };
        } });
    if (!injection?.result)
        throw new Error('ページを取得できません。');
    const result = injection.result;
    if (!current)
        assertBookmarkScope(result.pageUrl, result.scope);
    const ids = result.posts.filter(id => /^\d+$/.test(id));
    if (ids.length) {
        const readMetadata = () => chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', args: [ids, result.scope], func: async (ids, scope) => {
                const reader = window.__xImageBookmarkReader;
                if (!reader)
                    return { posts: [], readerMissing: true };
                try {
                    return await reader('posts', undefined, scope, ids);
                }
                catch (error) {
                    return { error: error instanceof Error ? error.message : String(error) };
                }
            } });
        let [metadata] = await readMetadata();
        if (metadata?.result?.readerMissing) {
            // An extension reload can leave an already open X page without its MAIN
            // reader. Install our bundled code and recover from committed post props.
            await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', files: ['dist/bookmark-reader.js'] });
            [metadata] = await readMetadata();
        }
        if (metadata?.result?.error)
            throw new Error(metadata.result.error);
        const records = metadata?.result?.posts ?? [];
        for (const id of ids) {
            const record = records.find((post) => post.postId === id);
            if (record)
                result.urls.push(...record.urls);
            if (record?.complete) {
                (result.verifiedPostIds ?? (result.verifiedPostIds = [])).push(id);
                result.issues = result.issues.filter(issue => !issue.startsWith(`投稿 ${id}:`));
            }
            else
                result.issues.push(`投稿 ${id}: 全画像・動画の一覧を確認できません。通信情報と投稿の表示データから取得できませんでした。`);
            for (const video of record?.videos ?? []) {
                const parsed = tweetMedia(video);
                if (parsed.media)
                    (result.media ?? (result.media = [])).push(parsed.media);
                if (parsed.issue)
                    result.issues.push(`投稿 ${id}: ${parsed.issue}`);
            }
        }
        result.urls = [...new Set(result.urls)];
        // A timeline-wide progress indicator does not mean this post's media are
        // incomplete once the full attachment list is verified.
        if (current && ids.every(id => result.verifiedPostIds?.includes(id)))
            result.loading = false;
    }
    return result;
}
export async function network(tabId, operation, cursor, expectedScope) {
    const [injection] = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', args: [operation, cursor ?? null, expectedScope ?? null], func: async (operation, cursor, scope) => {
            const reader = window.__xImageBookmarkReader;
            if (!reader)
                return { available: false, scope: '', documentId: performance.timeOrigin };
            // Return errors as data; executeScript otherwise obscures page exceptions.
            try {
                return await reader(operation, cursor ?? undefined, scope ?? undefined);
            }
            catch (error) {
                return { error: error instanceof Error ? error.message : String(error) };
            }
        } });
    const result = injection?.result;
    if (result?.error)
        throw new Error(result.error);
    if (!result)
        throw new Error('投稿データ取得に応答がありません。');
    return { available: !!result.available, scope: result.scope, documentId: result.documentId, page: result.data ? parseBookmarkPage(result.data) : undefined };
}
export function domPage(value) {
    const issues = [...value.issues];
    if (value.excludedPosts)
        issues.push(`ブックマーク済みと確認できない投稿 ${value.excludedPosts}件は保存対象から除外しました。`);
    const media = value.urls.flatMap(url => {
        const parsed = parseMediaUrl(url);
        if (!parsed)
            issues.push(`未対応の画像URL: ${url}`);
        return parsed ? [parsed] : [];
    });
    return { media: [...media, ...(value.media ?? [])], ended: false, issues, posts: value.posts.length, verifiedPostIds: value.verifiedPostIds ?? [] };
}
// Serialize like operations for the same post and never click the unlike control.
const likeOperations = new Map();
export function likePost(tabId, postId) {
    const key = tabId + ':' + postId;
    const operation = (likeOperations.get(key) ?? Promise.resolve()).catch(() => { }).then(async () => {
        const [result] = await chrome.scripting.executeScript({ target: { tabId }, world: 'ISOLATED', args: [postId], func: async (id) => {
                const root = document.querySelector('[data-testid="primaryColumn"]') ?? document.querySelector('main');
                const matches = (article) => Array.from(article.querySelectorAll('a[href]')).some(link => link.closest('article') === article && link.querySelector('time') && new URL(link.href, location.href).pathname.match(/\/status\/(\d+)/)?.[1] === id);
                const article = Array.from(root?.querySelectorAll('article') ?? []).find(matches);
                if (!article)
                    return { error: '対象投稿のいいねボタンを確認できません。' };
                const control = (testId) => Array.from(article.querySelectorAll(`[data-testid="${testId}"]`)).find(node => node.closest('article') === article);
                if (control('unlike'))
                    return { liked: true };
                const button = control('like');
                if (!button || button.getAttribute('aria-disabled') === 'true' || button.disabled)
                    return { error: 'いいねボタンを操作できません。' };
                button.click();
                for (let attempt = 0; attempt < 25; attempt++) {
                    if (!article.isConnected || !matches(article))
                        return { error: 'いいねの確認中に投稿が変わりました。' };
                    if (control('unlike'))
                        return { liked: true };
                    await new Promise(resolve => setTimeout(resolve, 100));
                }
                return { error: 'いいねの反映を確認できません。' };
            } });
        if (!result?.result?.liked)
            throw new Error(result?.result?.error ?? 'いいねの状態を確認できません。');
    });
    likeOperations.set(key, operation);
    void operation.finally(() => { if (likeOperations.get(key) === operation)
        likeOperations.delete(key); }).catch(() => { });
    return operation;
}
