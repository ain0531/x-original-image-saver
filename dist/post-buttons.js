"use strict";
// Special save uses X's own controls. Local save targets this article's post ID.
(() => {
    const instance = globalThis;
    if (instance.__xOriginalPostButtons)
        return;
    instance.__xOriginalPostButtons = true;
    const marker = 'data-x-original-save';
    let stopped = false;
    let scheduled;
    const busy = new Set();
    const specialStatus = new Map();
    const localBusy = new WeakSet();
    const folderKey = 'specialSaveBookmarkFolders';
    let folderConfigured = false;
    const folderReady = chrome.storage.local.get(folderKey).then(stored => {
        folderConfigured = Object.keys(stored[folderKey] ?? {}).length > 0;
        schedule();
    });
    // Keep storage failures visible when the user next requests a save.
    void folderReady.catch(() => { });
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local' || !changes[folderKey])
            return;
        folderConfigured = Object.keys(changes[folderKey].newValue ?? {}).length > 0;
        specialStatus.clear();
        schedule();
    });
    const observer = new MutationObserver(() => schedule());
    const timer = setInterval(() => { if (!enabled())
        cleanup(); }, 1000);
    function enabled() {
        try {
            return !!chrome.runtime.id && !!chrome.runtime.getManifest();
        }
        catch {
            return false;
        }
    }
    function cleanup() {
        stopped = true;
        observer.disconnect();
        clearInterval(timer);
        if (scheduled !== undefined)
            clearTimeout(scheduled);
        document.querySelectorAll(`[${marker}]`).forEach(node => node.remove());
        document.removeEventListener('visibilitychange', check);
    }
    function check() { if (!enabled())
        cleanup();
    else
        schedule(); }
    function schedule() {
        if (stopped || scheduled !== undefined)
            return;
        scheduled = setTimeout(() => { scheduled = undefined; scan(); }, 80);
    }
    function postId(article) {
        const link = Array.from(article.querySelectorAll('a[href]')).find(link => link.querySelector('time') && link.closest('article') === article);
        if (!link)
            return;
        try {
            return new URL(link.href, location.href).pathname.match(/\/status\/(\d+)/)?.[1];
        }
        catch {
            return;
        }
    }
    function control(article, testId) {
        return Array.from(article.querySelectorAll(`[data-testid="${testId}"]`)).find(node => node.closest('article') === article);
    }
    function currentArticle(id, previous) {
        if (previous?.isConnected && postId(previous) === id)
            return previous;
        const root = document.querySelector('[data-testid="primaryColumn"]') ?? document.querySelector('main');
        return Array.from(root?.querySelectorAll('article') ?? []).find(article => article.isConnected && postId(article) === id);
    }
    const accountLabel = () => document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"]')?.textContent ?? '';
    function showSpecialStatus(id, text) {
        specialStatus.set(id, text);
        const article = currentArticle(id);
        const row = article && Array.from(article.querySelectorAll(`[${marker}]`)).find(node => node.closest('article') === article);
        const status = row?.querySelector('[role="status"]');
        if (status)
            status.textContent = text;
        schedule();
    }
    function refresh(button, article) {
        const id = postId(article) ?? '';
        const active = !!control(article, 'unlike') && !!control(article, 'removeBookmark') && !folderConfigured;
        const pressed = String(active);
        if (button.getAttribute('aria-pressed') !== pressed)
            button.setAttribute('aria-pressed', pressed);
        const text = busy.has(id) ? '設定中...' : active ? '特別保存済み' : '特別保存';
        if (button.textContent !== text)
            button.textContent = text;
        button.disabled = busy.has(id);
    }
    async function activateControl(article, id, off, on, label, account) {
        const live = currentArticle(id, article);
        if (!enabled() || !live || accountLabel() !== account)
            throw new Error('投稿・アカウントが変わりました。再度お試しください。');
        if (control(live, on))
            return;
        const target = control(live, off);
        if (!target || target.getAttribute('aria-disabled') === 'true' || target.disabled)
            throw new Error(`${label}の操作ボタンを確認できません。`);
        target.click();
        for (let attempt = 0; attempt < 25; attempt++) {
            await new Promise(resolve => setTimeout(resolve, 100));
            if (!enabled() || accountLabel() !== account)
                throw new Error('アカウントが変わりました。再度お試しください。');
            const updated = currentArticle(id, article);
            if (updated && control(updated, on))
                return;
        }
        throw new Error(`${label}の反映を確認できません。状態を確認して再試行してください。`);
    }
    async function save(button, status, article, id) {
        if (!enabled()) {
            cleanup();
            return;
        }
        if (postId(article) !== id || busy.has(id)) {
            schedule();
            return;
        }
        const account = accountLabel();
        busy.add(id);
        refresh(button, article);
        showSpecialStatus(id, 'いいね・ブックマークを設定しています...');
        try {
            await folderReady;
            const errors = [];
            let bookmarked = false;
            for (const [off, on, label] of [['like', 'unlike', 'いいね'], ['bookmark', 'removeBookmark', 'ブックマーク']]) {
                try {
                    await activateControl(article, id, off, on, label, account);
                    if (off === 'bookmark')
                        bookmarked = true;
                }
                catch (error) {
                    errors.push(error instanceof Error ? error.message : String(error));
                }
            }
            let folderName;
            if (folderConfigured && bookmarked) {
                try {
                    if (!enabled() || accountLabel() !== account)
                        throw new Error('アカウントが変わりました。再度お試しください。');
                    showSpecialStatus(id, '指定フォルダへ登録しています...');
                    const response = await chrome.runtime.sendMessage({ type: 'SPECIAL_SAVE_FOLDER', postId: id });
                    if (accountLabel() !== account)
                        throw new Error('アカウントが変わりました。Xで保存状態を確認してください。');
                    if (!response?.ok)
                        throw new Error(response?.error ?? 'フォルダ登録の応答を確認できません。');
                    folderName = response.folder?.name;
                    if (!response.configured)
                        errors.push('このログインにはフォルダ登録先が設定されていません。通常のブックマークのみ保存しました。');
                }
                catch (error) {
                    errors.push(`フォルダ登録: ${error instanceof Error ? error.message : String(error)}`);
                }
            }
            showSpecialStatus(id, errors.length ? errors.join(' ') : folderName ? `いいね・ブックマーク済み / フォルダ「${folderName}」に登録済み` : 'いいね・ブックマーク済み');
        }
        catch (error) {
            if (!enabled()) {
                cleanup();
                return;
            }
            showSpecialStatus(id, error instanceof Error ? error.message : String(error));
        }
        finally {
            busy.delete(id);
            refresh(button, article);
            schedule();
        }
    }
    async function localSave(button, status, article, id) {
        if (!enabled()) {
            cleanup();
            return;
        }
        if (!article.isConnected || postId(article) !== id || localBusy.has(article))
            return;
        localBusy.add(article);
        button.disabled = true;
        button.textContent = '保存中...';
        status.textContent = '画像・動画を取得しています...';
        try {
            let response = await chrome.runtime.sendMessage({ type: 'LOCAL_SAVE_POST', postId: id });
            if (!response?.ok)
                throw new Error(response?.error ?? '応答がありません。');
            const jobId = response.job?.id;
            while (true) {
                if (!enabled()) {
                    cleanup();
                    return;
                }
                if (!article.isConnected || postId(article) !== id)
                    return;
                if (response.unavailable || !response.job || response.job.id !== jobId)
                    throw new Error('保存処理が切り替わりました。サイドパネルで状態を確認してください。');
                const stats = response.stats;
                button.textContent = response.queued ? '保存予約済み' : '保存中...';
                status.textContent = response.queued ? '予約済み。順番に保存します。' : `保存完了: ${stats.success} / 保存済み: ${stats.skipped} / 失敗: ${stats.failed}`;
                if (!response.busy && response.job.status !== 'running') {
                    if (response.job.status !== 'done')
                        status.textContent += ` / 要確認: ${[response.job.endedBy, ...(response.job.issues ?? []), ...(response.failures ?? [])].filter(Boolean).join(' ')}`;
                    break;
                }
                await new Promise(resolve => setTimeout(resolve, 500));
                if (!enabled()) {
                    cleanup();
                    return;
                }
                if (!article.isConnected || postId(article) !== id)
                    return;
                response = await chrome.runtime.sendMessage({ type: 'GET_LOCAL_SAVE_STATUS', postId: id, jobId });
                if (!response?.ok)
                    throw new Error(response?.error ?? '応答がありません。');
            }
        }
        catch (error) {
            if (!enabled()) {
                cleanup();
                return;
            }
            if (article.isConnected && postId(article) === id)
                status.textContent = `保存エラー: ${error instanceof Error ? error.message : String(error)}`;
        }
        finally {
            localBusy.delete(article);
            button.disabled = false;
            button.textContent = 'ローカル保存';
        }
    }
    function scan() {
        if (!enabled()) {
            cleanup();
            return;
        }
        const root = document.querySelector('[data-testid="primaryColumn"]') ?? document.querySelector('main');
        if (!root)
            return;
        for (const article of Array.from(root.querySelectorAll('article'))) {
            const id = postId(article);
            const group = Array.from(article.querySelectorAll('[role="group"]')).filter(node => node.closest('article') === article && node.querySelector('[data-testid="reply"], [data-testid="like"], [data-testid="unlike"]')).pop();
            const existing = Array.from(article.querySelectorAll(`[${marker}]`)).find(node => node.closest('article') === article);
            if (existing && existing.getAttribute(marker) === id && group) {
                if (existing.parentElement !== group)
                    group.appendChild(existing);
                const status = existing.querySelector('[role="status"]');
                if (status && specialStatus.has(id))
                    status.textContent = specialStatus.get(id);
                refresh(existing.querySelector('button'), article);
                continue;
            }
            existing?.remove();
            if (!id || !group)
                continue;
            const row = document.createElement('div');
            row.setAttribute(marker, id);
            row.style.cssText = 'display:flex;flex-direction:column;align-items:flex-start;gap:4px;min-width:0;font:inherit;color:inherit;';
            const button = document.createElement('button');
            button.type = 'button';
            button.textContent = '特別保存';
            button.setAttribute('aria-label', 'この投稿にいいねとブックマークを付ける');
            button.style.cssText = 'border:1px solid currentColor;border-radius:16px;background:transparent;color:inherit;padding:4px 12px;font:inherit;font-size:13px;cursor:pointer;';
            const status = document.createElement('span');
            status.setAttribute('role', 'status');
            status.setAttribute('aria-live', 'polite');
            status.style.cssText = 'font-size:12px;overflow-wrap:anywhere;';
            status.textContent = specialStatus.get(id) ?? '';
            row.append(button, status);
            const localButton = document.createElement('button');
            localButton.type = 'button';
            localButton.textContent = 'ローカル保存';
            localButton.setAttribute('aria-label', 'この投稿の画像と動画をローカルに保存する');
            localButton.style.cssText = button.style.cssText;
            const localStatus = document.createElement('span');
            localStatus.setAttribute('role', 'status');
            localStatus.setAttribute('aria-live', 'polite');
            localStatus.style.cssText = status.style.cssText;
            row.append(localButton, localStatus);
            row.addEventListener('click', event => event.stopPropagation());
            button.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); if (!button.disabled)
                void save(button, status, article, id); });
            localButton.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); if (!localButton.disabled)
                void localSave(localButton, localStatus, article, id); });
            group.appendChild(row);
            refresh(button, article);
        }
    }
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-testid'] });
    document.addEventListener('visibilitychange', check);
    scan();
})();
