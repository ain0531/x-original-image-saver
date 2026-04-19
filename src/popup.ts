const STORAGE_KEY_SAVED_MEDIA_MAP = "savedMediaMap";
const LEGACY_STORAGE_KEY_SAVED_MEDIA = "savedMediaKeys";

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

const saveCurrentTweetButton = document.getElementById(
  "save-current-tweet"
) as HTMLButtonElement | null;

const saveAllVisibleButton = document.getElementById(
  "save-all-visible"
) as HTMLButtonElement | null;

const clearSavedHistoryButton = document.getElementById(
  "clear-saved-history"
) as HTMLButtonElement | null;

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
    `Total detected: ${stats.total}`,
    `Skipped: ${stats.skipped}`,
    `Downloaded: ${stats.success}`,
    `Failed: ${stats.failed}`,
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

  setStatus("Auto-scrolling scan started...");

  const response = (await chrome.runtime.sendMessage({
    type: "SAVE_ALL_VISIBLE_IMAGES",
    tabId: activeTab.id,
    tabUrl: activeTab.url ?? "",
    saveAs: false,
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

export {};