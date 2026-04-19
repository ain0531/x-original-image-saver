const STORAGE_KEY_SAVED_MEDIA_MAP = "savedMediaMap";
const LEGACY_STORAGE_KEY_SAVED_MEDIA = "savedMediaKeys";
const STORAGE_KEY_SCROLL_SETTINGS = "allVisibleScrollSettings";
const DEFAULT_SCROLL_SETTINGS = {
    scrollRatio: 0.8,
    waitSecondsPerRound: 0.7,
    stableRoundsNeeded: 3,
    maxRounds: 20,
    maxElapsedSeconds: 30,
};
const saveCurrentTweetButton = document.getElementById("save-current-tweet");
const saveAllVisibleButton = document.getElementById("save-all-visible");
const clearSavedHistoryButton = document.getElementById("clear-saved-history");
const checkCurrentSavedListInput = document.getElementById("check-current-saved-list");
const checkAllSavedListInput = document.getElementById("check-all-saved-list");
const statusElement = document.getElementById("status");
const scrollRatioInput = document.getElementById("scroll-ratio");
const waitSecondsPerRoundInput = document.getElementById("wait-seconds-per-round");
const stableRoundsNeededInput = document.getElementById("stable-rounds-needed");
const maxRoundsInput = document.getElementById("max-rounds");
const maxElapsedSecondsInput = document.getElementById("max-elapsed-seconds");
function setStatus(message) {
    if (statusElement) {
        statusElement.textContent = message;
    }
}
function formatStats(title, stats) {
    return [
        title,
        "",
        `Total detected: ${stats.total}`,
        `Skipped: ${stats.skipped}`,
        `Downloaded: ${stats.success}`,
        `Failed: ${stats.failed}`,
    ].join("\n");
}
function normalizeScrollSettings(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return { ...DEFAULT_SCROLL_SETTINGS };
    }
    const candidate = value;
    return {
        scrollRatio: typeof candidate.scrollRatio === "number"
            ? candidate.scrollRatio
            : DEFAULT_SCROLL_SETTINGS.scrollRatio,
        waitSecondsPerRound: typeof candidate.waitSecondsPerRound === "number"
            ? candidate.waitSecondsPerRound
            : DEFAULT_SCROLL_SETTINGS.waitSecondsPerRound,
        stableRoundsNeeded: typeof candidate.stableRoundsNeeded === "number"
            ? candidate.stableRoundsNeeded
            : DEFAULT_SCROLL_SETTINGS.stableRoundsNeeded,
        maxRounds: typeof candidate.maxRounds === "number"
            ? candidate.maxRounds
            : DEFAULT_SCROLL_SETTINGS.maxRounds,
        maxElapsedSeconds: typeof candidate.maxElapsedSeconds === "number"
            ? candidate.maxElapsedSeconds
            : DEFAULT_SCROLL_SETTINGS.maxElapsedSeconds,
    };
}
async function getStoredScrollSettings() {
    const result = await chrome.storage.local.get(STORAGE_KEY_SCROLL_SETTINGS);
    return normalizeScrollSettings(result[STORAGE_KEY_SCROLL_SETTINGS]);
}
async function saveScrollSettings(settings) {
    await chrome.storage.local.set({
        [STORAGE_KEY_SCROLL_SETTINGS]: settings,
    });
}
function applyScrollSettingsToInputs(settings) {
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
function parsePositiveNumber(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
function readScrollSettingsFromInputs() {
    return {
        scrollRatio: parsePositiveNumber(scrollRatioInput?.value ?? "", DEFAULT_SCROLL_SETTINGS.scrollRatio),
        waitSecondsPerRound: parsePositiveNumber(waitSecondsPerRoundInput?.value ?? "", DEFAULT_SCROLL_SETTINGS.waitSecondsPerRound),
        stableRoundsNeeded: Math.floor(parsePositiveNumber(stableRoundsNeededInput?.value ?? "", DEFAULT_SCROLL_SETTINGS.stableRoundsNeeded)),
        maxRounds: Math.floor(parsePositiveNumber(maxRoundsInput?.value ?? "", DEFAULT_SCROLL_SETTINGS.maxRounds)),
        maxElapsedSeconds: parsePositiveNumber(maxElapsedSecondsInput?.value ?? "", DEFAULT_SCROLL_SETTINGS.maxElapsedSeconds),
    };
}
async function persistScrollSettingsFromInputs() {
    const settings = readScrollSettingsFromInputs();
    await saveScrollSettings(settings);
    applyScrollSettingsToInputs(settings);
    return settings;
}
async function getActiveTab() {
    const tabs = await chrome.tabs.query({
        active: true,
        currentWindow: true,
    });
    return tabs[0] ?? null;
}
async function getSavedMediaCount() {
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
        return legacy.filter((item) => typeof item === "string")
            .length;
    }
    return 0;
}
async function initializePopup() {
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
    }));
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
    const confirmed = window.confirm("Save all visible images in batch mode?\n\nThe extension will auto-scroll and collect image URLs until the scan stabilizes or reaches the safety limits.");
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
    }));
    if (!response.ok) {
        setStatus(`Error: ${response.error ?? "Unknown error"}`);
        return;
    }
    setStatus(formatStats("All visible images scan complete", response.stats));
});
clearSavedHistoryButton?.addEventListener("click", async () => {
    const count = await getSavedMediaCount();
    const confirmed = window.confirm(`Clear saved history?\n\nCurrently stored items: ${count}\n\nThis will remove the saved media history used for duplicate skipping.`);
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
