const STORAGE_KEY_SAVED_MEDIA_MAP = "savedMediaMap";
const LEGACY_STORAGE_KEY_SAVED_MEDIA = "savedMediaKeys";
const STORAGE_KEY_SCROLL_SETTINGS = "allVisibleScrollSettings";

type SaveStats = {
  total: number;
  skipped: number;
  success: number;
  failed: number;
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

type AllVisibleScrollSettings = {
  scrollRatio: number;
  waitSecondsPerRound: number;
  stableRoundsNeeded: number;
  maxRounds: number;
  maxElapsedSeconds: number;
};

const DEFAULT_SCROLL_SETTINGS: AllVisibleScrollSettings = {
  scrollRatio: 0.8,
  waitSecondsPerRound: 0.7,
  stableRoundsNeeded: 3,
  maxRounds: 20,
  maxElapsedSeconds: 30,
};

const saveCurrentTweetButton = document.getElementById(
  "save-current-tweet"
) as HTMLButtonElement | null;

const saveAllVisibleButton = document.getElementById(
  "save-all-visible"
) as HTMLButtonElement | null;

const clearSavedHistoryButton = document.getElementById(
  "clear-saved-history"
) as HTMLButtonElement | null;

const checkCurrentSavedListInput = document.getElementById(
  "check-current-saved-list"
) as HTMLInputElement | null;

const checkAllSavedListInput = document.getElementById(
  "check-all-saved-list"
) as HTMLInputElement | null;

const statusElement = document.getElementById("status") as HTMLDivElement | null;

const scrollRatioInput = document.getElementById(
  "scroll-ratio"
) as HTMLInputElement | null;

const waitSecondsPerRoundInput = document.getElementById(
  "wait-seconds-per-round"
) as HTMLInputElement | null;

const stableRoundsNeededInput = document.getElementById(
  "stable-rounds-needed"
) as HTMLInputElement | null;

const maxRoundsInput = document.getElementById(
  "max-rounds"
) as HTMLInputElement | null;

const maxElapsedSecondsInput = document.getElementById(
  "max-elapsed-seconds"
) as HTMLInputElement | null;

function setStatus(message: string): void {
  if (statusElement) {
    statusElement.textContent = message;
  }
}

function formatStats(title: string, stats: SaveStats): string {
  return [
    title,
    "",
    `検出画像: ${stats.total}`,
    `保存済みスキップ: ${stats.skipped}`,
    `保存完了: ${stats.success}`,
    `保存失敗: ${stats.failed}`,
  ].join("\n");
}

function normalizeScrollSettings(value: unknown): AllVisibleScrollSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ...DEFAULT_SCROLL_SETTINGS };
  }

  const candidate = value as Partial<AllVisibleScrollSettings>;
  const positive = (value: unknown, fallback: number, max: number): number =>
    typeof value === "number" && Number.isFinite(value) && value > 0
      ? Math.min(value, max) : fallback;
  return {
    scrollRatio: positive(candidate.scrollRatio, DEFAULT_SCROLL_SETTINGS.scrollRatio, 1),
    waitSecondsPerRound: positive(candidate.waitSecondsPerRound, DEFAULT_SCROLL_SETTINGS.waitSecondsPerRound, 10),
    stableRoundsNeeded: Math.max(1, Math.floor(positive(candidate.stableRoundsNeeded, DEFAULT_SCROLL_SETTINGS.stableRoundsNeeded, 100))),
    maxRounds: Math.max(1, Math.floor(positive(candidate.maxRounds, DEFAULT_SCROLL_SETTINGS.maxRounds, 1000))),
    maxElapsedSeconds: positive(candidate.maxElapsedSeconds, DEFAULT_SCROLL_SETTINGS.maxElapsedSeconds, 300),
  };
}

async function getStoredScrollSettings(): Promise<AllVisibleScrollSettings> {
  const result = await chrome.storage.local.get(STORAGE_KEY_SCROLL_SETTINGS);
  return normalizeScrollSettings(result[STORAGE_KEY_SCROLL_SETTINGS]);
}

async function saveScrollSettings(
  settings: AllVisibleScrollSettings
): Promise<void> {
  await chrome.storage.local.set({
    [STORAGE_KEY_SCROLL_SETTINGS]: settings,
  });
}

function applyScrollSettingsToInputs(
  settings: AllVisibleScrollSettings
): void {
  if (scrollRatioInput) {
    scrollRatioInput.value = String(settings.scrollRatio);
  }

  if (waitSecondsPerRoundInput) {
    waitSecondsPerRoundInput.value = String(settings.waitSecondsPerRound);
  }

  if (stableRoundsNeededInput) {
    stableRoundsNeededInput.value = String(settings.stableRoundsNeeded);
  }

  if (maxRoundsInput) {
    maxRoundsInput.value = String(settings.maxRounds);
  }

  if (maxElapsedSecondsInput) {
    maxElapsedSecondsInput.value = String(settings.maxElapsedSeconds);
  }
}

function parsePositiveNumber(value: string, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readScrollSettingsFromInputs(): AllVisibleScrollSettings {
  return normalizeScrollSettings({
    scrollRatio: parsePositiveNumber(
      scrollRatioInput?.value ?? "",
      DEFAULT_SCROLL_SETTINGS.scrollRatio
    ),
    waitSecondsPerRound: parsePositiveNumber(
      waitSecondsPerRoundInput?.value ?? "",
      DEFAULT_SCROLL_SETTINGS.waitSecondsPerRound
    ),
    stableRoundsNeeded: Math.max(1, Math.floor(
      parsePositiveNumber(
        stableRoundsNeededInput?.value ?? "",
        DEFAULT_SCROLL_SETTINGS.stableRoundsNeeded
      )
    )),
    maxRounds: Math.max(1, Math.floor(
      parsePositiveNumber(
        maxRoundsInput?.value ?? "",
        DEFAULT_SCROLL_SETTINGS.maxRounds
      )
    )),
    maxElapsedSeconds: parsePositiveNumber(
      maxElapsedSecondsInput?.value ?? "",
      DEFAULT_SCROLL_SETTINGS.maxElapsedSeconds
    ),
  });
}

async function persistScrollSettingsFromInputs(): Promise<AllVisibleScrollSettings> {
  const settings = readScrollSettingsFromInputs();
  await saveScrollSettings(settings);
  applyScrollSettingsToInputs(settings);
  return settings;
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
  return Object.keys(stored).filter(key => key.startsWith('savedImage:')).length;
}
async function initializeSidePanel(): Promise<void> {
  const storedSettings = await getStoredScrollSettings();
  applyScrollSettingsToInputs(storedSettings);

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
  })) as SaveResponse;

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

  const scrollSettings = await persistScrollSettingsFromInputs();

  setStatus("スクロールせずに取得・保存を開始しています...");

  const response = (await chrome.runtime.sendMessage({
    type: "SAVE_ALL_VISIBLE_IMAGES",
    tabId: activeTab.id,
    tabUrl: activeTab.url ?? "",
    saveAs: false,
    skipPreviouslySaved: checkAllSavedListInput?.checked ?? true,
    scrollSettings: {
      scrollRatio: scrollSettings.scrollRatio,
      waitMsPerRound: Math.round(scrollSettings.waitSecondsPerRound * 1000),
      stableRoundsNeeded: scrollSettings.stableRoundsNeeded,
      maxRounds: scrollSettings.maxRounds,
      maxElapsedMs: Math.round(scrollSettings.maxElapsedSeconds * 1000),
    },
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
  watchProgress = jobActive || response.busy === true;
  const source = job?.source === 'network' ? 'ブックマークの投稿データを直接取得（スクロールなし）' : job?.source === 'loaded' ? '読み込み済み画像のみ（スクロールなし）' : '現在の投稿';
  const reasons: Record<string, string> = {
    'timeline-end': '投稿データの末尾まで取得', 'max-rounds': '取得ページ数の上限。続きは未取得',
    'max-time': '取得時間の上限。続きは未取得', 'loaded-only': '読み込み済みの範囲のみ。全件の取得は未確認',
    'current-post': '現在の投稿のみ', 'user-paused': '一時停止',
  };
  const stats = response.stats ?? { total: 0, skipped: 0, success: 0, failed: 0 };
  const title = !job ? '待機中' : jobActive ? '取得・保存中' : job.status === 'done' ? '対象範囲の保存完了' : '停止・要確認';
  setStatus([formatStats(title, stats), job ? `経路: ${source}\n取得ページ: ${job.rounds}\n保存待ち・転送中: ${stats.pending ?? 0}\n${reasons[job.endedBy] ?? job.endedBy}` : '',
    ...(job?.issues ?? []), ...(response.failures ?? [])].filter(Boolean).join('\n'));
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

export {};
