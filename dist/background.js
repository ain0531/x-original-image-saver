const STORAGE_KEY_SAVED_MEDIA_MAP = "savedMediaMap";
const LEGACY_STORAGE_KEY_SAVED_MEDIA = "savedMediaKeys";
const SAVED_MEDIA_KEEP_DAYS = 180;
const SAVED_MEDIA_KEEP_MS = SAVED_MEDIA_KEEP_DAYS * 24 * 60 * 60 * 1000;
function parseMediaUrl(rawUrl) {
    try {
        const url = new URL(rawUrl);
        if (url.protocol !== "https:" || url.hostname !== "pbs.twimg.com") {
            return null;
        }
        const pathMatch = url.pathname.match(/^\/media\/([A-Za-z0-9_-]+)(?:\.([A-Za-z0-9]+)(?::[A-Za-z0-9]+)?)?$/);
        const mediaId = pathMatch?.[1] ?? null;
        if (!mediaId) {
            console.warn("[parseMediaUrl] mediaId not found:", rawUrl);
            return null;
        }
        const format = (url.searchParams.get("format") ?? pathMatch?.[2] ?? "").toLowerCase();
        if (!["jpg", "jpeg", "png", "webp", "gif"].includes(format)) {
            return null;
        }
        const quality = url.searchParams.get("name");
        url.pathname = `/media/${mediaId}`;
        url.searchParams.set("format", format);
        const orig = new URL(url.toString());
        orig.searchParams.set("name", "orig");
        const large = new URL(url.toString());
        large.searchParams.set("name", "large");
        const parsed = {
            originalUrl: rawUrl,
            mediaId,
            format,
            quality,
            origUrl: orig.toString(),
            largeUrl: large.toString(),
        };
        console.log("[parseMediaUrl] parsed:", parsed);
        return parsed;
    }
    catch (error) {
        console.error("Failed to parse media URL:", rawUrl, error);
        return null;
    }
}
function buildMediaIdentityKey(parsed) {
    if (!parsed.format) {
        console.warn("[buildMediaIdentityKey] format missing:", parsed);
        return null;
    }
    return `${parsed.mediaId}|${parsed.format}`;
}
function isSavedMediaMap(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return false;
    }
    return Object.values(value).every((v) => typeof v === "number");
}
async function getSavedMediaMap() {
    const result = await chrome.storage.local.get([
        STORAGE_KEY_SAVED_MEDIA_MAP,
        LEGACY_STORAGE_KEY_SAVED_MEDIA,
    ]);
    const current = result[STORAGE_KEY_SAVED_MEDIA_MAP];
    if (isSavedMediaMap(current)) {
        console.log(`[getSavedMediaMap] current map loaded: ${Object.keys(current).length} item(s)`);
        return current;
    }
    const legacy = result[LEGACY_STORAGE_KEY_SAVED_MEDIA];
    if (Array.isArray(legacy)) {
        const now = Date.now();
        const migrated = {};
        for (const item of legacy) {
            if (typeof item === "string") {
                migrated[item] = now;
            }
        }
        await chrome.storage.local.set({
            [STORAGE_KEY_SAVED_MEDIA_MAP]: migrated,
        });
        await chrome.storage.local.remove(LEGACY_STORAGE_KEY_SAVED_MEDIA);
        console.log(`[migration] migrated legacy savedMediaKeys -> savedMediaMap (${Object.keys(migrated).length} items)`);
        return migrated;
    }
    console.log("[getSavedMediaMap] no saved map found, using empty map");
    return {};
}
async function saveSavedMediaMap(map) {
    await chrome.storage.local.set({
        [STORAGE_KEY_SAVED_MEDIA_MAP]: map,
    });
}
function pruneExpiredSavedMediaMap(map, now = Date.now()) {
    const cutoff = now - SAVED_MEDIA_KEEP_MS;
    const prunedMap = {};
    let removedCount = 0;
    for (const [key, savedAt] of Object.entries(map)) {
        if (savedAt >= cutoff) {
            prunedMap[key] = savedAt;
        }
        else {
            removedCount += 1;
        }
    }
    return { prunedMap, removedCount };
}
function buildDownloadCandidates(parsed) {
    if (!parsed.format) {
        console.warn("[buildDownloadCandidates] format missing:", parsed);
        return [];
    }
    const candidates = [
        {
            url: parsed.origUrl,
            quality: "orig",
            fileName: `${parsed.mediaId}_orig.${parsed.format}`,
        },
        {
            url: parsed.largeUrl,
            quality: "large",
            fileName: `${parsed.mediaId}_large.${parsed.format}`,
        },
    ];
    console.log("[buildDownloadCandidates] candidates:", candidates);
    return candidates;
}
function addSequenceToFileName(fileName, sequence) {
    const lastDotIndex = fileName.lastIndexOf(".");
    if (lastDotIndex === -1) {
        return `${fileName}_${sequence}`;
    }
    const base = fileName.slice(0, lastDotIndex);
    const ext = fileName.slice(lastDotIndex);
    return `${base}_${sequence}${ext}`;
}
function resolveUniqueFileName(requestedFileName, usedFileNames) {
    if (!usedFileNames.has(requestedFileName)) {
        usedFileNames.add(requestedFileName);
        return requestedFileName;
    }
    let sequence = 2;
    while (true) {
        const candidate = addSequenceToFileName(requestedFileName, sequence);
        if (!usedFileNames.has(candidate)) {
            usedFileNames.add(candidate);
            return candidate;
        }
        sequence += 1;
    }
}
class DownloadInterruptedError extends Error {
    constructor(reason) {
        super(`Download interrupted: ${reason}`);
        this.reason = reason;
    }
}
// Subscribe before searching so completion between download() and search() is
// observed. Periodic API calls also keep the worker active during long transfers.
function waitForDownload(downloadId) {
    return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (error) => {
            if (settled)
                return;
            settled = true;
            clearInterval(pollTimer);
            clearTimeout(timeoutTimer);
            chrome.downloads.onChanged.removeListener(onChanged);
            error ? reject(error) : resolve();
        };
        const onChanged = (delta) => {
            if (delta.id !== downloadId)
                return;
            if (delta.state?.current === "complete")
                finish();
            if (delta.state?.current === "interrupted") {
                finish(new DownloadInterruptedError(delta.error?.current ?? "UNKNOWN"));
            }
        };
        const checkState = async () => {
            try {
                const [item] = await chrome.downloads.search({ id: downloadId });
                if (item?.state === "complete")
                    finish();
                else if (item?.state === "interrupted") {
                    finish(new DownloadInterruptedError(item.error ?? "UNKNOWN"));
                }
                else if (!item)
                    finish(new Error("Download no longer exists."));
            }
            catch (error) {
                // Monitoring failure does not prove the transfer stopped.
                finish(new DownloadInterruptedError(`MONITOR_FAILED: ${String(error)}`));
            }
        };
        const pollTimer = setInterval(() => { void checkState(); }, 15000);
        const timeoutTimer = setTimeout(() => {
            void chrome.downloads.cancel(downloadId)
                .then(async () => {
                const [item] = await chrome.downloads.search({ id: downloadId });
                finish(item?.state === "complete" ? undefined : new Error("Download timed out."));
            })
                .catch((error) => finish(new DownloadInterruptedError(`CANCEL_FAILED: ${String(error)}`)));
        }, 120000);
        chrome.downloads.onChanged.addListener(onChanged);
        void checkState();
    });
}
async function tryDownloadSequentially(candidates, usedFileNames, saveAs) {
    console.log(`[tryDownloadSequentially] start: candidates=${candidates.length}, saveAs=${saveAs}`);
    for (const candidate of candidates) {
        const finalFileName = resolveUniqueFileName(candidate.fileName, usedFileNames);
        let started = false;
        try {
            console.log(`Trying download: quality=${candidate.quality}, requested=${candidate.fileName}, final=${finalFileName}, saveAs=${saveAs}`, candidate.url);
            const downloadId = await chrome.downloads.download({
                url: candidate.url,
                filename: finalFileName,
                saveAs,
            });
            started = true;
            await waitForDownload(downloadId);
            console.log(`[tryDownloadSequentially] completed: quality=${candidate.quality}, finalFileName=${finalFileName}, downloadId=${downloadId}`);
            return {
                success: true,
                used: candidate,
                finalFileName,
                downloadId,
            };
        }
        catch (error) {
            console.warn(`Download failed with ${candidate.quality}:`, error);
            // A rejected Save As request can mean cancellation; Chrome provides no
            // stable error code here. Do not reopen the chooser in that case.
            if (saveAs && !started)
                return { success: false };
            // User cancellation must not open another Save As dialog.
            if (error instanceof DownloadInterruptedError &&
                (error.reason.startsWith("USER_") || error.reason.startsWith("CANCEL_FAILED") ||
                    error.reason.startsWith("MONITOR_FAILED"))) {
                return { success: false };
            }
        }
    }
    console.warn("[tryDownloadSequentially] all candidates failed");
    return { success: false };
}
async function getAllVisibleMediaUrlsFromPage(tabId) {
    const injectionResults = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
            const allImgSrcs = Array.from(document.querySelectorAll("img"))
                .map((img) => img.getAttribute("src"))
                .filter((src) => Boolean(src));
            const mediaUrls = Array.from(new Set(allImgSrcs.filter((src) => src.includes("pbs.twimg.com/media/"))));
            return {
                mode: "all-visible",
                pageUrl: location.href,
                totalImages: allImgSrcs.length,
                matchedMediaUrls: mediaUrls,
            };
        },
    });
    const result = injectionResults[0]?.result ?? null;
    console.log("[getAllVisibleMediaUrlsFromPage] result:", result);
    return result;
}
async function autoScrollAndCollectVisibleMediaUrls(tabId, options) {
    const positive = (value, fallback, max) => typeof value === "number" && Number.isFinite(value) && value > 0
        ? Math.min(value, max) : fallback;
    const scrollRatio = positive(options?.scrollRatio, 0.8, 1);
    const waitMs = positive(options?.waitMsPerRound, 700, 10000);
    const stableNeeded = Math.max(1, Math.floor(positive(options?.stableRoundsNeeded, 3, 100)));
    const maxRounds = Math.max(1, Math.floor(positive(options?.maxRounds, 20, 1000)));
    const maxElapsedMs = positive(options?.maxElapsedMs, 30000, 300000);
    const startedAt = Date.now();
    const collected = new Map();
    let pageUrl = "";
    let rounds = 0;
    let stableRounds = 0;
    const collect = async () => {
        const result = await getAllVisibleMediaUrlsFromPage(tabId);
        if (!result)
            throw new Error("Could not read the page.");
        if (pageUrl && result.pageUrl !== pageUrl)
            throw new Error("The page changed during scanning.");
        pageUrl = result.pageUrl;
        if (!isTargetXPage(pageUrl))
            throw new Error("Open an X/Twitter page.");
        for (const url of result.matchedMediaUrls) {
            const parsed = parseMediaUrl(url);
            const key = parsed && buildMediaIdentityKey(parsed);
            if (key)
                collected.set(key, url);
        }
    };
    const finish = (endedBy) => ({
        pageUrl, totalUniqueMediaUrls: Array.from(collected.values()), rounds,
        elapsedMs: Date.now() - startedAt, endedBy,
    });
    await collect();
    for (let round = 1; round <= maxRounds; round += 1) {
        if (Date.now() - startedAt >= maxElapsedMs)
            return finish("max-time");
        const previousCount = collected.size;
        const [injection] = await chrome.scripting.executeScript({
            target: { tabId }, args: [scrollRatio],
            func: (ratio) => {
                const beforeY = window.scrollY;
                window.scrollBy(0, Math.max(1, Math.floor(window.innerHeight * ratio)));
                return { beforeY, afterY: window.scrollY,
                    nearBottom: window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 50 };
            },
        });
        const scrollInfo = injection?.result;
        if (!scrollInfo)
            throw new Error("Could not scroll the page.");
        rounds = round;
        const remainingMs = Math.max(0, maxElapsedMs - (Date.now() - startedAt));
        await new Promise((resolve) => setTimeout(resolve, Math.min(waitMs, remainingMs)));
        // Every scroll, including the last, is followed by a scan.
        await collect();
        stableRounds = collected.size === previousCount ? stableRounds + 1 : 0;
        if (Date.now() - startedAt >= maxElapsedMs)
            return finish("max-time");
        // Text-only posts are not the end of a timeline. Only stop for stability
        // when scrolling has stopped making progress at the bottom.
        if (scrollInfo.nearBottom && scrollInfo.beforeY === scrollInfo.afterY && stableRounds >= stableNeeded) {
            return finish("near-bottom-and-stable");
        }
    }
    return finish("max-rounds");
}
async function getCurrentTweetMediaUrlsFromPage(tabId) {
    const injectionResults = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
            const articles = Array.from(document.querySelectorAll("article"));
            const articleCandidates = articles
                .map((article, index) => {
                const imgSrcs = Array.from(article.querySelectorAll("img"))
                    .map((img) => img.getAttribute("src"))
                    .filter((src) => Boolean(src));
                const mediaUrls = Array.from(new Set(imgSrcs.filter((src) => src.includes("pbs.twimg.com/media/"))));
                return {
                    index,
                    mediaUrls,
                    mediaCount: mediaUrls.length,
                };
            })
                .filter((item) => item.mediaCount > 0);
            if (articleCandidates.length === 0) {
                return {
                    mode: "current-tweet",
                    pageUrl: location.href,
                    matchedMediaUrls: [],
                    articleCandidates: [],
                    selectedArticleIndex: null,
                };
            }
            const statusId = location.pathname.match(/\/status\/(\d+)/)?.[1];
            // A timestamp permalink belongs to the article itself; quoted-post links
            // and image links must not be used to identify the enclosing post.
            const matchingIndex = statusId
                ? articles.findIndex((article) => {
                    const permalink = Array.from(article.querySelectorAll("a[href]"))
                        .find((link) => link.querySelector("time"));
                    return permalink !== undefined &&
                        new URL(permalink.href, location.href)
                            .pathname.match(/\/status\/(\d+)/)?.[1] === statusId;
                })
                : articles.findIndex((article) => {
                    const rect = article.getBoundingClientRect();
                    return rect.bottom > 0 && rect.top < window.innerHeight;
                });
            if (matchingIndex < 0) {
                throw new Error("Could not identify the current post. Open its post detail page and try again.");
            }
            const selected = articleCandidates.find((candidate) => candidate.index === matchingIndex);
            return {
                mode: "current-tweet",
                pageUrl: location.href,
                matchedMediaUrls: selected?.mediaUrls ?? [],
                articleCandidates,
                selectedArticleIndex: matchingIndex,
            };
        },
    });
    const result = injectionResults[0]?.result ?? null;
    console.log("[getCurrentTweetMediaUrlsFromPage] result:", result);
    return result;
}
async function saveParsedMediaList(parsedList, saveAs, options) {
    const unique = new Map();
    for (const item of parsedList)
        unique.set(buildMediaIdentityKey(item) ?? item.originalUrl, item);
    const stats = { total: unique.size, skipped: 0, success: 0, failed: 0 };
    if (unique.size === 0)
        return stats;
    const { prunedMap: savedMediaMap, removedCount } = pruneExpiredSavedMediaMap(await getSavedMediaMap());
    if (removedCount > 0)
        await saveSavedMediaMap(savedMediaMap);
    const usedFileNames = new Set();
    for (const target of unique.values()) {
        const key = buildMediaIdentityKey(target);
        if (options?.skipPreviouslySaved && key && savedMediaMap[key] !== undefined) {
            stats.skipped += 1;
            continue;
        }
        const result = await tryDownloadSequentially(buildDownloadCandidates(target), usedFileNames, saveAs);
        if (!result.success) {
            stats.failed += 1;
            continue;
        }
        // Record completed downloads even when duplicate checking is disabled.
        // Persist per image so a later failure does not discard earlier successes.
        if (key) {
            savedMediaMap[key] = Date.now();
            await saveSavedMediaMap(savedMediaMap);
        }
        stats.success += 1;
    }
    return stats;
}
function isTargetXPage(tabUrl) {
    return (tabUrl.startsWith("https://x.com/") ||
        tabUrl.startsWith("https://twitter.com/"));
}
async function saveAllVisibleImages(tabId, tabUrl, saveAs, scrollSettings, skipPreviouslySaved = true) {
    console.log("[saveAllVisibleImages] start:", {
        tabId,
        tabUrl,
        saveAs,
        scrollSettings,
        skipPreviouslySaved,
    });
    if (!isTargetXPage(tabUrl)) {
        throw new Error("Open an X/Twitter page.");
    }
    const collectResult = await autoScrollAndCollectVisibleMediaUrls(tabId, scrollSettings);
    console.log("[saveAllVisibleImages] collectResult:", collectResult);
    if (!collectResult || collectResult.totalUniqueMediaUrls.length === 0) {
        console.log("No pbs.twimg.com/media/ image URLs collected.");
        return { total: 0, skipped: 0, success: 0, failed: 0 };
    }
    const parsedCandidates = collectResult.totalUniqueMediaUrls.map((url) => parseMediaUrl(url));
    console.log("[saveAllVisibleImages] parsedCandidates:", parsedCandidates);
    const parsedList = parsedCandidates.filter((item) => item !== null);
    console.log("[saveAllVisibleImages] parsedList length:", parsedList.length);
    return await saveParsedMediaList(parsedList, saveAs, {
        skipPreviouslySaved,
    });
}
async function saveCurrentTweetImages(tabId, tabUrl, saveAs, skipPreviouslySaved = true) {
    console.log("[saveCurrentTweetImages] start:", {
        tabId,
        tabUrl,
        saveAs,
        skipPreviouslySaved,
    });
    if (!isTargetXPage(tabUrl)) {
        throw new Error("Open an X/Twitter page.");
    }
    const result = await getCurrentTweetMediaUrlsFromPage(tabId);
    if (result && result.pageUrl !== tabUrl) {
        throw new Error("The page changed during scanning. Try again.");
    }
    console.log("[saveCurrentTweetImages] raw result:", result);
    if (!result || result.matchedMediaUrls.length === 0) {
        console.log("No media URLs found for current tweet candidate.");
        return { total: 0, skipped: 0, success: 0, failed: 0 };
    }
    const parsedCandidates = result.matchedMediaUrls.map((url) => parseMediaUrl(url));
    console.log("[saveCurrentTweetImages] parsedCandidates:", parsedCandidates);
    const parsedList = parsedCandidates.filter((item) => item !== null);
    console.log("[saveCurrentTweetImages] parsedList length:", parsedList.length);
    return await saveParsedMediaList(parsedList, saveAs, {
        skipPreviouslySaved,
    });
}
// Serialize saves and history deletion across all popup windows. Reject a second
// operation instead of queuing a stale tab/page request.
let operationRunning = false;
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const types = ["SAVE_ALL_VISIBLE_IMAGES", "SAVE_CURRENT_TWEET_IMAGES", "CLEAR_SAVED_HISTORY"];
    if (!types.includes(message?.type))
        return false;
    if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL("popup.html")) {
        sendResponse({ ok: false, error: "Untrusted request." });
        return false;
    }
    if (operationRunning) {
        sendResponse({ ok: false, error: "Another operation is running. Wait for it to finish." });
        return false;
    }
    operationRunning = true;
    const run = async () => {
        if (message.type === "CLEAR_SAVED_HISTORY") {
            const map = await getSavedMediaMap();
            const removed = Object.keys(map).length;
            await chrome.storage.local.remove([STORAGE_KEY_SAVED_MEDIA_MAP, LEGACY_STORAGE_KEY_SAVED_MEDIA]);
            return { ok: true, removed };
        }
        if (!Number.isInteger(message.tabId) || message.tabId < 0)
            throw new Error("Invalid tab.");
        const tab = await chrome.tabs.get(message.tabId);
        const tabUrl = tab.url ?? "";
        if (!isTargetXPage(tabUrl))
            throw new Error("Open an X/Twitter page.");
        const skip = message.skipPreviouslySaved !== false;
        const stats = message.type === "SAVE_ALL_VISIBLE_IMAGES"
            ? await saveAllVisibleImages(message.tabId, tabUrl, false, message.scrollSettings, skip)
            : await saveCurrentTweetImages(message.tabId, tabUrl, true, skip);
        return { ok: true, stats };
    };
    void run().then((response) => { operationRunning = false; sendResponse(response); }, (error) => { operationRunning = false; sendResponse({ ok: false, error: String(error) }); });
    return true;
});
export {};
