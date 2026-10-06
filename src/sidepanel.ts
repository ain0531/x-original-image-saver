const LEGACY_STORAGE_KEY_SAVED_MEDIA = "savedMediaKeys";
const versionElement = document.getElementById('version');
if (versionElement) versionElement.textContent = `バージョン ${chrome.runtime.getManifest?.()?.version ?? ''}`;

type SaveStats = {
  total: number;
  skipped: number;
  success: number;
  failed: number;
  canceled?: number;
};

type SaveResponse =
  | {
      ok: true;
      stats: SaveStats;
    }
  | {
      ok: false;
      error?: string;
    };

const saveCurrentTweetButton = document.getElementById(
  "save-current-tweet"
) as HTMLButtonElement | null;

const saveAllVisibleButton = document.getElementById(
  "save-all-visible"
) as HTMLButtonElement | null;
const bulkModeInput = document.getElementById('bulk-save-mode') as HTMLSelectElement | null;
const accountVideosInput = document.getElementById('account-save-videos') as HTMLInputElement | null;
const accountImagesInput = document.getElementById('account-save-images') as HTMLInputElement | null;
function describeBulkMode(): void {
  const mediaTypes = document.getElementById('account-media-types');
  if (mediaTypes) mediaTypes.hidden = bulkModeInput?.value !== 'account';
  const description = document.getElementById('bulk-save-description');
  if (description) description.textContent = bulkModeInput?.value === 'account'
    ? '現在開いているアカウントのメディアを保存します。'
    : 'ブックマークに保存された投稿から動画と画像を保存します。';
}
bulkModeInput?.addEventListener('change', describeBulkMode);

const clearSavedHistoryButton = document.getElementById(
  "clear-saved-history"
) as HTMLButtonElement | null;

const checkCurrentSavedListInput = document.getElementById(
  "check-current-saved-list"
) as HTMLInputElement | null;
const specifySaveLocationInput = document.getElementById('specify-save-location') as HTMLInputElement | null;
let saveLocationSettingWrite: Promise<void> = Promise.resolve();
specifySaveLocationInput?.addEventListener('change', () => {
  const checked = specifySaveLocationInput.checked;
  saveLocationSettingWrite = saveLocationSettingWrite.catch(() => {}).then(() => chrome.storage.local.set({ specifySaveLocation: checked }));
  void saveLocationSettingWrite.catch(error => setStatus(`設定を保存できません: ${String(error)}`));
});
const likeOnSaveInput = document.getElementById('like-on-save') as HTMLInputElement | null;
let likeSettingWrite: Promise<void> = Promise.resolve();
likeOnSaveInput?.addEventListener('change', () => {
  const checked = likeOnSaveInput.checked;
  likeSettingWrite = likeSettingWrite.catch(() => {}).then(() => chrome.storage.local.set({ likeOnSave: checked }));
  void likeSettingWrite.catch(error => setStatus(`設定を保存できません: ${String(error)}`));
});
const unreadOnlyInput = document.getElementById('unread-only') as HTMLInputElement | null;
let unreadSettingWrite: Promise<void> = Promise.resolve();
unreadOnlyInput?.addEventListener('change', () => {
  const checked = unreadOnlyInput.checked;
  unreadSettingWrite = unreadSettingWrite.catch(() => {}).then(async () => {
    const response = await chrome.runtime.sendMessage({ type: 'SET_UNREAD_FILTER', enabled: checked });
    if (!response?.ok) throw new Error(response?.error ?? '応答がありません。');
  });
  void unreadSettingWrite.catch(error => {
    unreadOnlyInput.checked = !checked;
    setStatus(`設定を保存できません: ${error instanceof Error ? error.message : String(error)}`);
  });
});

const checkAllSavedListInput = document.getElementById(
  "check-all-saved-list"
) as HTMLInputElement | null;

const statusElement = document.getElementById("status") as HTMLDivElement | null;

function setStatus(message: string): void {
  if (statusElement) {
    statusElement.textContent = message;
  }
}

function formatStats(title: string, stats: SaveStats): string {
  return [
    title,
    "",
    `検出ファイル: ${stats.total}`,
    `保存済みスキップ: ${stats.skipped}`,
    `保存完了: ${stats.success}`,
    `保存失敗: ${stats.failed}`,
    `キャンセル: ${stats.canceled ?? 0}`,
  ].join("\n");
}

async function getActiveTab(): Promise<chrome.tabs.Tab | null> {
  const tabs = await chrome.tabs.query({
    active: true,
    currentWindow: true,
  });

  return tabs[0] ?? null;
}

async function getSavedMediaCount(): Promise<number> {
  const stored = await chrome.storage.local.get(null);
  return Object.keys(stored).filter(key => key.startsWith('savedImage:') || key.startsWith('savedVideo:')).length;
}
async function initializeSidePanel(): Promise<void> {
  if (bulkModeInput) bulkModeInput.value = 'bookmarks';
  if (accountVideosInput) accountVideosInput.checked = true;
  if (accountImagesInput) accountImagesInput.checked = true;
  describeBulkMode();
  const stored = await chrome.storage.local.get(['imageSaverOptions', 'likeOnSave', 'specifySaveLocation']);
  if (specifySaveLocationInput) specifySaveLocationInput.checked = stored.specifySaveLocation === true;
  if (likeOnSaveInput) likeOnSaveInput.checked = stored.likeOnSave === true;
  if (unreadOnlyInput) {
    const unread = await chrome.runtime.sendMessage({ type: 'GET_UNREAD_FILTER' });
    unreadOnlyInput.checked = unread?.ok === true && unread.enabled === true;
  }

  if (checkCurrentSavedListInput) {
    checkCurrentSavedListInput.checked = true;
  }

  if (checkAllSavedListInput) {
    checkAllSavedListInput.checked = true;
  }
}

bindAction(saveCurrentTweetButton, async () => {
  await likeSettingWrite;
  await saveLocationSettingWrite;
  const activeTab = await getActiveTab();

  if (!activeTab?.id) {
    setStatus("開いているタブを確認できません。");
    return;
  }

  setStatus("現在の投稿の画像・動画を保存しています...");

  const response = (await chrome.runtime.sendMessage({
    type: "SAVE_CURRENT_TWEET_IMAGES",
    tabId: activeTab.id,
    tabUrl: activeTab.url ?? "",
    saveAs: specifySaveLocationInput?.checked === true,
    skipPreviouslySaved: checkCurrentSavedListInput?.checked ?? true,
  })) as SaveResponse;

  if (!response?.ok) {
    setStatus(`エラー: ${response?.error ?? "原因を確認できません。"}`);
    return;
  }

  renderProgress(response);
});

bindAction(saveAllVisibleButton, async () => {
  const accountMode = bulkModeInput?.value === 'account';
  const mediaTypes = { videos: accountVideosInput?.checked ?? true, images: accountImagesInput?.checked ?? true };
  if (accountMode && !mediaTypes.videos && !mediaTypes.images) { setStatus('動画または画像を選択してください。'); return; }
  const activeTab = await getActiveTab();

  if (!activeTab?.id) {
    setStatus("開いているタブを確認できません。");
    return;
  }


  setStatus(accountMode ? 'アカウントのメディア一覧を取得しています。必要な場合は取得用タブを一時的に開き、通信後に自動で閉じます...' : "ブックマークの初回データを取得しています。必要な場合は取得用タブを一時的に開き、通信後に自動で閉じます...");

  const response = (await chrome.runtime.sendMessage({
    type: accountMode ? 'SAVE_ACCOUNT_MEDIA' : "SAVE_ALL_VISIBLE_IMAGES",
    ...(accountMode ? { mediaTypes } : {}),
    tabId: activeTab.id,
    tabUrl: activeTab.url ?? "",
    saveAs: false,
    skipPreviouslySaved: checkAllSavedListInput?.checked ?? true,
  })) as SaveResponse;

  if (!response?.ok) {
    setStatus(`エラー: ${response?.error ?? "原因を確認できません。"}`);
    return;
  }

  renderProgress(response);
});

bindAction(clearSavedHistoryButton, async () => {
  const count = await getSavedMediaCount();

  const confirmed = window.confirm(
    `保存履歴を消去しますか？\n\n保存履歴: ${count}件\n\n重複判定に使う履歴を消去します。保存した画像ファイルは削除されません。`
  );

  if (!confirmed) {
    setStatus("保存履歴の消去をキャンセルしました。");
    return;
  }

  const response = await chrome.runtime.sendMessage({ type: "CLEAR_SAVED_HISTORY" });
  if (!response?.ok) throw new Error(response?.error ?? "応答がありません。");
  setStatus(`保存履歴を消去しました。消去件数: ${response.removed}`);
});

let panelBusy = false;
let jobActive = false;
let watchProgress = false;
let workerBusy = false;
const pauseButton = document.getElementById('pause-save') as HTMLButtonElement | null;
const resumeButton = document.getElementById('resume-save') as HTMLButtonElement | null;
function renderProgress(response: any): void {
  const job = response.job;
  jobActive = job?.status === 'running';
  workerBusy = response.busy === true;
  watchProgress = jobActive || response.busy === true || (response.localQueue?.pending ?? 0) > 0;
  const source = job?.source === 'account' ? `個別アカウントのメディアを取得（スクロールなし）\n対象: ${job.url}` : job?.source === 'direct' ? 'ブックマークのデータを取得（タブなし）' : job?.source === 'network' ? 'ブックマークの投稿データを直接取得（スクロールなし）' : job?.source === 'loaded' ? '読み込み済み画像のみ（スクロールなし）' : '現在の投稿';
  const reasons: Record<string, string> = {
    'timeline-end': '投稿データの末尾まで取得', 'max-rounds': '取得ページ数の上限。続きは未取得',
    'max-time': '取得時間の上限。続きは未取得', 'loaded-only': '読み込み済みの範囲のみ。全件の取得は未確認',
    'current-post': '現在の投稿のみ', 'user-paused': '一時停止',
  };
  const stats = response.stats ?? { total: 0, skipped: 0, success: 0, failed: 0 };
  const title = !job ? '待機中' : jobActive ? '取得・保存中' : job.status === 'done' ? (stats.canceled ? '対象範囲の処理終了（キャンセルあり）' : '対象範囲の保存完了') : '停止・要確認';
  setStatus([formatStats(title, stats), job ? `経路: ${source}\n取得ページ: ${job.rounds}\n保存待ち・転送中: ${stats.pending ?? 0}\n${reasons[job.endedBy] ?? job.endedBy}` : '',
    ...(job?.issues ?? []), ...(response.failures ?? []), response.localQueue ? `ローカル保存の予約・処理中: ${response.localQueue.pending} / 要確認: ${response.localQueue.review}（対象投稿から再試行）` : ''].filter(Boolean).join('\n'));
  if (pauseButton) pauseButton.disabled = !jobActive;
  if (resumeButton) resumeButton.disabled = !job || jobActive || workerBusy || job.status === 'done';
  setBusy(panelBusy);
}
bindAction(pauseButton, async () => {
  const response = await chrome.runtime.sendMessage({ type: 'PAUSE_SAVE' });
  if (!response?.ok) throw new Error(response?.error ?? '応答がありません。');
  renderProgress(response);
});
bindAction(resumeButton, async () => {
  const response = await chrome.runtime.sendMessage({ type: 'RESUME_SAVE' });
  if (!response?.ok) throw new Error(response?.error ?? '応答がありません。');
  renderProgress(response);
});
function setBusy(busy: boolean): void {
  for (const button of [saveCurrentTweetButton, saveAllVisibleButton, clearSavedHistoryButton]) {
    if (button) button.disabled = busy || jobActive || workerBusy;
  }
}
function bindAction(button: HTMLButtonElement | null, action: () => Promise<void>): void {
  button?.addEventListener("click", () => {
    if (panelBusy) return;
    panelBusy = true;
    setBusy(true);
    void action().catch((error) => setStatus(`エラー: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => { panelBusy = false; setBusy(false); });
  });
}
setBusy(true);
void initializeSidePanel().catch((error) => setStatus(`設定を読み込めません: ${error instanceof Error ? error.message : String(error)}`))
  .finally(() => setBusy(false));
async function refreshProgress(): Promise<void> {
  if (panelBusy) return;
  try {
    const response = await chrome.runtime.sendMessage({ type: 'GET_SAVE_STATUS' });
    if (response?.ok) renderProgress(response);
  } catch (error) { setStatus(`エラー: ${error instanceof Error ? error.message : String(error)}`); }
}
void refreshProgress();
setInterval(() => { if (watchProgress) void refreshProgress(); }, 1000);

document.getElementById('open-options')?.addEventListener('click', () => {
  void chrome.runtime.openOptionsPage().catch(error => setStatus(`オプションを開けません: ${error instanceof Error ? error.message : String(error)}`));
});

export {};
