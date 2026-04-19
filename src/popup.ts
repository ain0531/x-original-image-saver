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
    `Total detected: ${stats.total}`,
    `Skipped: ${stats.skipped}`,
    `Downloaded: ${stats.success}`,
    `Failed: ${stats.failed}`,
  ].join("\n");
}

function normalizeScrollSettings(value: unknown): AllVisibleScrollSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ...DEFAULT_SCROLL_SETTINGS };
  }

  const candidate = value as Partial<AllVisibleScrollSettings>;

  return {
    scrollRatio:
      typeof candidate.scrollRatio === "number"
        ? candidate.scrollRatio
        : DEFAULT_SCROLL_SETTINGS.scrollRatio,
    waitSecondsPerRound:
      typeof candidate.waitSecondsPerRound === "number"
        ? candidate.waitSecondsPerRound
        : DEFAULT_SCROLL_SETTINGS.waitSecondsPerRound,
    stableRoundsNeeded:
      typeof candidate.stableRoundsNeeded === "number"
        ? candidate.stableRoundsNeeded
        : DEFAULT_SCROLL_SETTINGS.stableRoundsNeeded,
    maxRounds:
      typeof candidate.maxRounds === "number"
        ? candidate.maxRounds
        : DEFAULT_SCROLL_SETTINGS.maxRounds,
    maxElapsedSeconds:
      typeof candidate.maxElapsedSeconds === "number"
        ? candidate.maxElapsedSeconds
        : DEFAULT_SCROLL_SETTINGS.maxElapsedSeconds,
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
  return {
    scrollRatio: parsePositiveNumber(
      scrollRatioInput?.value ?? "",
      DEFAULT_SCROLL_SETTINGS.scrollRatio
    ),
    waitSecondsPerRound: parsePositiveNumber(
      waitSecondsPerRoundInput?.value ?? "",
      DEFAULT_SCROLL_SETTINGS.waitSecondsPerRound
    ),
    stableRoundsNeeded: Math.floor(
      parsePositiveNumber(
        stableRoundsNeededInput?.value ?? "",
        DEFAULT_SCROLL_SETTINGS.stableRoundsNeeded
      )
    ),
    maxRounds: Math.floor(
      parsePositiveNumber(
        maxRoundsInput?.value ?? "",
        DEFAULT_SCROLL_SETTINGS.maxRounds
      )
    ),
    maxElapsedSeconds: parsePositiveNumber(
      maxElapsedSecondsInput?.value ?? "",
      DEFAULT_SCROLL_SETTINGS.maxElapsedSeconds
    ),
  };
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
  const result = await chrome.storage.local.get([
    STORAGE_KEY_SAVED_MEDIA_MAP,
    LEGACY_STORAGE_KEY_SAVED_MEDIA,
  ]);

  const current = result[STORAGE_KEY_SAVED_MEDIA_MAP];
  if (current && typeof current === "object" && !Array.isArray(current)) {
    return Object.keys(current).length;
  }

  const legacy = result[LEGACY_STORAGE_KEY_SAVED_MEDIA];
  if (Array.isArray(legacy)) {
    return legacy.filter((item): item is string => typeof item === "string")
      .length;
  }

  return 0;
}

async function initializePopup(): Promise<void> {
  const storedSettings = await getStoredScrollSettings();
  applyScrollSettingsToInputs(storedSettings);

  if (checkCurrentSavedListInput) {
    checkCurrentSavedListInput.checked = true;
  }

  if (checkAllSavedListInput) {
    checkAllSavedListInput.checked = true;
  }
}

saveCurrentTweetButton?.addEventListener("click", async () => {
  const activeTab = await getActiveTab();

  if (!activeTab?.id) {
    setStatus("No active tab found.");
    return;
  }

  setStatus("Running: Save current tweet images...");

  const response = (await chrome.runtime.sendMessage({
    type: "SAVE_CURRENT_TWEET_IMAGES",
    tabId: activeTab.id,
    tabUrl: activeTab.url ?? "",
    saveAs: true,
    skipPreviouslySaved: checkCurrentSavedListInput?.checked ?? true,
  })) as SaveResponse;

  if (!response.ok) {
    setStatus(`Error: ${response.error ?? "Unknown error"}`);
    return;
  }

  setStatus(formatStats("Current tweet scan complete", response.stats));
});

saveAllVisibleButton?.addEventListener("click", async () => {
  const activeTab = await getActiveTab();

  if (!activeTab?.id) {
    setStatus("No active tab found.");
    return;
  }

  const confirmed = window.confirm(
    "Save all visible images in batch mode?\n\nThe extension will auto-scroll and collect image URLs until the scan stabilizes or reaches the safety limits."
  );

  if (!confirmed) {
    setStatus("Batch save cancelled.");
    return;
  }

  const scrollSettings = await persistScrollSettingsFromInputs();

  setStatus("Auto-scrolling scan started...");

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

  if (!response.ok) {
    setStatus(`Error: ${response.error ?? "Unknown error"}`);
    return;
  }

  setStatus(formatStats("All visible images scan complete", response.stats));
});

clearSavedHistoryButton?.addEventListener("click", async () => {
  const count = await getSavedMediaCount();

  const confirmed = window.confirm(
    `Clear saved history?\n\nCurrently stored items: ${count}\n\nThis will remove the saved media history used for duplicate skipping.`
  );

  if (!confirmed) {
    setStatus("Clear history cancelled.");
    return;
  }

  await chrome.storage.local.remove([
    STORAGE_KEY_SAVED_MEDIA_MAP,
    LEGACY_STORAGE_KEY_SAVED_MEDIA,
  ]);
  setStatus(`Saved history cleared. Removed items: ${count}`);
});

void initializePopup();

export {};