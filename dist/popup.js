const STORAGE_KEY_SAVED_MEDIA = "savedMediaKeys";
const saveCurrentTweetButton = document.getElementById("save-current-tweet");
const saveAllVisibleButton = document.getElementById("save-all-visible");
const clearSavedHistoryButton = document.getElementById("clear-saved-history");
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
        `Total detected: ${stats.total}`,
        `Skipped: ${stats.skipped}`,
        `Downloaded: ${stats.success}`,
        `Failed: ${stats.failed}`,
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
    const result = await chrome.storage.local.get(STORAGE_KEY_SAVED_MEDIA);
    const raw = result[STORAGE_KEY_SAVED_MEDIA];
    if (!Array.isArray(raw)) {
        return 0;
    }
    return raw.filter((item) => typeof item === "string").length;
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
    setStatus("Auto-scrolling scan started...");
    const response = (await chrome.runtime.sendMessage({
        type: "SAVE_ALL_VISIBLE_IMAGES",
        tabId: activeTab.id,
        tabUrl: activeTab.url ?? "",
        saveAs: false,
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
    await chrome.storage.local.remove(STORAGE_KEY_SAVED_MEDIA);
    setStatus(`Saved history cleared. Removed items: ${count}`);
});
export {};
