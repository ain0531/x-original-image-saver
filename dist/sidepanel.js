const LEGACY_STORAGE_KEY_SAVED_MEDIA = "savedMediaKeys";
const saveCurrentTweetButton = document.getElementById("save-current-tweet");
const saveAllVisibleButton = document.getElementById("save-all-visible");
const clearSavedHistoryButton = document.getElementById("clear-saved-history");
const checkCurrentSavedListInput = document.getElementById("check-current-saved-list");
const checkAllSavedListInput = document.getElementById("check-all-saved-list");
const statusElement = document.getElementById("status");
function setStatus(message) {
    if (statusElement) {
        statusElement.textContent = message;
    }
}
function formatStats(title, stats) {
    return [
        title,
        "",
        `検出画像: ${stats.total}`,
        `保存済みスキップ: ${stats.skipped}`,
        `保存完了: ${stats.success}`,
        `保存失敗: ${stats.failed}`,
    ].join("\n");
}
async function getActiveTab() {
    const tabs = await chrome.tabs.query({
        active: true,
        currentWindow: true,
    });
    return tabs[0] ?? null;
}
async function getSavedMediaCount() {
    const stored = await chrome.storage.local.get(null);
    return Object.keys(stored).filter(key => key.startsWith('savedImage:')).length;
}
async function initializeSidePanel() {
    await chrome.storage.local.get('imageSaverOptions');
    if (checkCurrentSavedListInput) {
        checkCurrentSavedListInput.checked = true;
    }
    if (checkAllSavedListInput) {
        checkAllSavedListInput.checked = true;
    }
}
bindAction(saveCurrentTweetButton, async () => {
    const activeTab = await getActiveTab();
    if (!activeTab?.id) {
        setStatus("開いているタブを確認できません。");
        return;
    }
    setStatus("現在の投稿の画像を保存しています...");
    const response = (await chrome.runtime.sendMessage({
        type: "SAVE_CURRENT_TWEET_IMAGES",
        tabId: activeTab.id,
        tabUrl: activeTab.url ?? "",
        saveAs: true,
        skipPreviouslySaved: checkCurrentSavedListInput?.checked ?? true,
    }));
    if (!response?.ok) {
        setStatus(`エラー: ${response?.error ?? "原因を確認できません。"}`);
        return;
    }
    renderProgress(response);
});
bindAction(saveAllVisibleButton, async () => {
    const activeTab = await getActiveTab();
    if (!activeTab?.id) {
        setStatus("開いているタブを確認できません。");
        return;
    }
    setStatus("タブを開かずにブックマークのデータ取得を準備しています...");
    const response = (await chrome.runtime.sendMessage({
        type: "SAVE_ALL_VISIBLE_IMAGES",
        tabId: activeTab.id,
        tabUrl: activeTab.url ?? "",
        saveAs: false,
        skipPreviouslySaved: checkAllSavedListInput?.checked ?? true,
    }));
    if (!response?.ok) {
        setStatus(`エラー: ${response?.error ?? "原因を確認できません。"}`);
        return;
    }
    renderProgress(response);
});
bindAction(clearSavedHistoryButton, async () => {
    const count = await getSavedMediaCount();
    const confirmed = window.confirm(`保存履歴を消去しますか？\n\n保存履歴: ${count}件\n\n重複判定に使う履歴を消去します。保存した画像ファイルは削除されません。`);
    if (!confirmed) {
        setStatus("保存履歴の消去をキャンセルしました。");
        return;
    }
    const response = await chrome.runtime.sendMessage({ type: "CLEAR_SAVED_HISTORY" });
    if (!response?.ok)
        throw new Error(response?.error ?? "応答がありません。");
    setStatus(`保存履歴を消去しました。消去件数: ${response.removed}`);
});
let panelBusy = false;
let jobActive = false;
let watchProgress = false;
let workerBusy = false;
const pauseButton = document.getElementById('pause-save');
const resumeButton = document.getElementById('resume-save');
function renderProgress(response) {
    const job = response.job;
    jobActive = job?.status === 'running';
    workerBusy = response.busy === true;
    watchProgress = jobActive || response.busy === true;
    const source = job?.source === 'direct' ? 'ブックマークのデータを取得（タブなし）' : job?.source === 'network' ? 'ブックマークの投稿データを直接取得（スクロールなし）' : job?.source === 'loaded' ? '読み込み済み画像のみ（スクロールなし）' : '現在の投稿';
    const reasons = {
        'timeline-end': '投稿データの末尾まで取得', 'max-rounds': '取得ページ数の上限。続きは未取得',
        'max-time': '取得時間の上限。続きは未取得', 'loaded-only': '読み込み済みの範囲のみ。全件の取得は未確認',
        'current-post': '現在の投稿のみ', 'user-paused': '一時停止',
    };
    const stats = response.stats ?? { total: 0, skipped: 0, success: 0, failed: 0 };
    const title = !job ? '待機中' : jobActive ? '取得・保存中' : job.status === 'done' ? '対象範囲の保存完了' : '停止・要確認';
    setStatus([formatStats(title, stats), job ? `経路: ${source}\n取得ページ: ${job.rounds}\n保存待ち・転送中: ${stats.pending ?? 0}\n${reasons[job.endedBy] ?? job.endedBy}` : '',
        ...(job?.issues ?? []), ...(response.failures ?? [])].filter(Boolean).join('\n'));
    if (pauseButton)
        pauseButton.disabled = !jobActive;
    if (resumeButton)
        resumeButton.disabled = !job || jobActive || workerBusy || job.status === 'done';
    setBusy(panelBusy);
}
bindAction(pauseButton, async () => {
    const response = await chrome.runtime.sendMessage({ type: 'PAUSE_SAVE' });
    if (!response?.ok)
        throw new Error(response?.error ?? '応答がありません。');
    renderProgress(response);
});
bindAction(resumeButton, async () => {
    const response = await chrome.runtime.sendMessage({ type: 'RESUME_SAVE' });
    if (!response?.ok)
        throw new Error(response?.error ?? '応答がありません。');
    renderProgress(response);
});
function setBusy(busy) {
    for (const button of [saveCurrentTweetButton, saveAllVisibleButton, clearSavedHistoryButton]) {
        if (button)
            button.disabled = busy || jobActive || workerBusy;
    }
}
function bindAction(button, action) {
    button?.addEventListener("click", () => {
        if (panelBusy)
            return;
        panelBusy = true;
        setBusy(true);
        void action().catch((error) => setStatus(`エラー: ${error instanceof Error ? error.message : String(error)}`))
            .finally(() => { panelBusy = false; setBusy(false); });
    });
}
setBusy(true);
void initializeSidePanel().catch((error) => setStatus(`設定を読み込めません: ${error instanceof Error ? error.message : String(error)}`))
    .finally(() => setBusy(false));
async function refreshProgress() {
    if (panelBusy)
        return;
    try {
        const response = await chrome.runtime.sendMessage({ type: 'GET_SAVE_STATUS' });
        if (response?.ok)
            renderProgress(response);
    }
    catch (error) {
        setStatus(`エラー: ${error instanceof Error ? error.message : String(error)}`);
    }
}
void refreshProgress();
setInterval(() => { if (watchProgress)
    void refreshProgress(); }, 1000);
document.getElementById('open-options')?.addEventListener('click', () => {
    void chrome.runtime.openOptionsPage().catch(error => setStatus(`オプションを開けません: ${error instanceof Error ? error.message : String(error)}`));
});
export {};
