import { parseMediaUrl } from './media.js';
import { parseBookmarkPage } from './bookmarks.js';
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
            }
            return { pageUrl: location.href, scope, documentId: performance.timeOrigin, urls: [...urls], posts: articles.map(postId), issues,
                loading: !!root.querySelector('[role="progressbar"]'), y: window.scrollY,
                bottom: window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 50 };
        } });
    if (!injection?.result)
        throw new Error('ページを取得できません。');
    const result = injection.result;
    const ids = result.posts.filter(id => /^\d+$/.test(id));
    if (ids.length) {
        const [metadata] = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', args: [ids, result.scope], func: async (ids, scope) => {
                const reader = window.__xImageBookmarkReader;
                if (!reader)
                    return { posts: [] };
                try {
                    return await reader('posts', undefined, scope, ids);
                }
                catch (error) {
                    return { error: error instanceof Error ? error.message : String(error) };
                }
            } });
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
                result.issues.push(`投稿 ${id}: 全画像の一覧を確認できません。表示された画像のみの保存になる可能性があります。`);
        }
        result.urls = [...new Set(result.urls)];
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
    const media = value.urls.flatMap(url => {
        const parsed = parseMediaUrl(url);
        if (!parsed)
            issues.push(`未対応の画像URL: ${url}`);
        return parsed ? [parsed] : [];
    });
    return { media, ended: false, issues, posts: value.posts.length, verifiedPostIds: value.verifiedPostIds ?? [] };
}
