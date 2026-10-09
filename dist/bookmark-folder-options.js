"use strict";
const bookmarkTab = document.getElementById('bookmark-tab');
const bookmarkSelection = document.getElementById('bookmark-selection');
const bookmarkStatus = document.getElementById('bookmark-status');
const loadFolders = document.getElementById('load-bookmark-folders');
const saveFolder = document.getElementById('save-bookmark-folder');
const reloadTabs = document.getElementById('reload-bookmark-tabs');
const clearFolders = document.getElementById('clear-bookmark-folders');
let loadedAccount;
let loadedTab;
let bookmarkWorking = false;
function invalidateFolders() {
    loadedAccount = undefined;
    loadedTab = undefined;
    // Never leave a previously usable folder visible after this account's list fails.
    bookmarkSelection.replaceChildren(new Option('フォルダ一覧を取得してください', ''));
    bookmarkSelection.disabled = true;
    saveFolder.disabled = true;
}
function bookmarkControls(working) {
    bookmarkWorking = working;
    bookmarkTab.disabled = working;
    loadFolders.disabled = working || !bookmarkTab.options.length;
    reloadTabs.disabled = working;
    clearFolders.disabled = working;
    bookmarkSelection.disabled = working || !loadedAccount;
    saveFolder.disabled = working || !loadedAccount;
}
async function bookmarkMessage(message) {
    const response = await chrome.runtime.sendMessage(message);
    if (!response?.ok)
        throw new Error(response?.error ?? '拡張機能の応答がありません。');
    return response;
}
async function loadBookmarkFolders() {
    if (bookmarkWorking || !bookmarkTab.options.length)
        return;
    invalidateFolders();
    bookmarkControls(true);
    bookmarkStatus.textContent = 'Xからフォルダ一覧を自動取得しています...';
    const tabId = Number(bookmarkTab.value);
    try {
        const response = await bookmarkMessage({ type: 'LIST_BOOKMARK_FOLDERS', tabId });
        loadedAccount = response.account;
        loadedTab = tabId;
        bookmarkSelection.replaceChildren(new Option('フォルダ指定なし', ''), ...response.folders.map((folder) => new Option(folder.name, folder.id)));
        const exists = response.folders.some((folder) => folder.id === response.selected?.id);
        bookmarkSelection.value = exists ? response.selected.id : '';
        bookmarkStatus.textContent = response.selected && !exists ? '保存先フォルダが見つかりません。登録先を選び直して保存してください。'
            : response.folders.length ? `${response.folders.length}件のフォルダを取得しました。` : '既存フォルダはありません。Xでフォルダを作成してから再取得してください。';
    }
    catch (error) {
        bookmarkStatus.textContent = error instanceof Error ? error.message : String(error);
        bookmarkSelection.replaceChildren(new Option('フォルダ一覧を利用できません', ''));
    }
    finally {
        bookmarkControls(false);
    }
}
async function refreshBookmarkTabs() {
    if (bookmarkWorking)
        return;
    const previous = bookmarkTab.value;
    invalidateFolders();
    bookmarkControls(true);
    try {
        const tabs = (await chrome.tabs.query({ url: ['https://x.com/*'] })).filter(tab => tab.id !== undefined);
        tabs.sort((a, b) => Number(!!b.active) - Number(!!a.active));
        bookmarkTab.replaceChildren(...tabs.map(tab => new Option(tab.title ?? tab.url ?? 'X', String(tab.id))));
        if (tabs.some(tab => String(tab.id) === previous))
            bookmarkTab.value = previous;
        bookmarkStatus.textContent = tabs.length ? '' : 'ログイン済みのXのタブを開いてください。';
    }
    catch (error) {
        bookmarkStatus.textContent = error instanceof Error ? error.message : String(error);
    }
    finally {
        bookmarkControls(false);
    }
    await loadBookmarkFolders();
}
bookmarkTab.addEventListener('change', () => { void loadBookmarkFolders(); });
loadFolders.addEventListener('click', () => { void loadBookmarkFolders(); });
saveFolder.addEventListener('click', () => {
    if (bookmarkWorking || !loadedAccount || loadedTab === undefined)
        return;
    bookmarkControls(true);
    void bookmarkMessage({ type: 'SET_BOOKMARK_FOLDER', tabId: loadedTab, account: loadedAccount, folderId: bookmarkSelection.value }).then(response => {
        bookmarkStatus.textContent = response.selected ? `特別保存の登録先を「${response.selected.name}」に設定しました。` : 'フォルダ指定を解除しました。';
    }).catch(error => { bookmarkStatus.textContent = error.message; })
        .finally(() => { bookmarkControls(false); });
});
clearFolders.addEventListener('click', () => {
    if (bookmarkWorking)
        return;
    bookmarkControls(true);
    void bookmarkMessage({ type: 'CLEAR_BOOKMARK_FOLDERS' }).then(() => {
        invalidateFolders();
        bookmarkSelection.value = '';
        bookmarkStatus.textContent = 'すべてのフォルダ登録先を解除しました。';
    }).catch(error => { bookmarkStatus.textContent = error.message; })
        .finally(() => { bookmarkControls(false); });
});
reloadTabs.addEventListener('click', () => { void refreshBookmarkTabs(); });
void refreshBookmarkTabs();
