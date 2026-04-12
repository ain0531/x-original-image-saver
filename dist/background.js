const STORAGE_KEY_SAVED_MEDIA = "savedMediaKeys";
function parseMediaUrl(rawUrl) {
    try {
        const url = new URL(rawUrl);
        const pathMatch = url.pathname.match(/\/media\/([^/?]+)/);
        const mediaId = pathMatch?.[1] ?? null;
        if (!mediaId) {
            return null;
        }
        const format = url.searchParams.get("format");
        const quality = url.searchParams.get("name");
        const orig = new URL(url.toString());
        orig.searchParams.set("name", "orig");
        const large = new URL(url.toString());
        large.searchParams.set("name", "large");
        return {
            originalUrl: rawUrl,
            mediaId,
            format,
            quality,
            origUrl: orig.toString(),
            largeUrl: large.toString(),
        };
    }
    catch (error) {
        console.error("Failed to parse media URL:", rawUrl, error);
        return null;
    }
}
function buildMediaIdentityKey(parsed) {
    if (!parsed.format) {
        return null;
    }
    return `${parsed.mediaId}|${parsed.format}`;
}
async function getSavedMediaKeys() {
    const result = await chrome.storage.local.get(STORAGE_KEY_SAVED_MEDIA);
    const raw = result[STORAGE_KEY_SAVED_MEDIA];
    if (!Array.isArray(raw)) {
        return new Set();
    }
    return new Set(raw.filter((item) => typeof item === "string"));
}
async function saveSavedMediaKeys(keys) {
    await chrome.storage.local.set({
        [STORAGE_KEY_SAVED_MEDIA]: Array.from(keys),
    });
}
function buildDownloadCandidates(parsed) {
    if (!parsed.format) {
        return [];
    }
    return [
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
async function tryDownloadSequentially(candidates, usedFileNames, saveAs) {
    for (const candidate of candidates) {
        const finalFileName = resolveUniqueFileName(candidate.fileName, usedFileNames);
        try {
            console.log(`Trying download: quality=${candidate.quality}, requested=${candidate.fileName}, final=${finalFileName}, saveAs=${saveAs}`, candidate.url);
            const downloadId = await chrome.downloads.download({
                url: candidate.url,
                filename: finalFileName,
                saveAs,
            });
            return {
                success: true,
                used: candidate,
                finalFileName,
                downloadId,
            };
        }
        catch (error) {
            console.warn(`Download failed with ${candidate.quality}:`, error);
        }
    }
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
    return injectionResults[0]?.result ?? null;
}
async function autoScrollAndCollectVisibleMediaUrls(tabId, options) {
    const scrollRatio = options?.scrollRatio ?? 0.8;
    const waitMsPerRound = options?.waitMsPerRound ?? 700;
    const stableRoundsNeeded = options?.stableRoundsNeeded ?? 3;
    const maxRounds = options?.maxRounds ?? 20;
    const maxElapsedMs = options?.maxElapsedMs ?? 30000;
    const startedAt = Date.now();
    const collected = new Set();
    let previousCount = -1;
    let stableRounds = 0;
    for (let round = 1; round <= maxRounds; round += 1) {
        const elapsedMs = Date.now() - startedAt;
        if (elapsedMs >= maxElapsedMs) {
            console.log(`[autoscroll] stop: max-time at round=${round}`);
            return {
                pageUrl: "",
                totalUniqueMediaUrls: Array.from(collected),
                rounds: round - 1,
                elapsedMs,
                endedBy: "max-time",
            };
        }
        const scanResult = await getAllVisibleMediaUrlsFromPage(tabId);
        const pageUrl = scanResult?.pageUrl ?? "";
        const currentUrls = scanResult?.matchedMediaUrls ?? [];
        for (const url of currentUrls) {
            collected.add(url);
        }
        const currentCount = collected.size;
        const scrollInfoResult = await chrome.scripting.executeScript({
            target: { tabId },
            args: [scrollRatio],
            func: (ratio) => {
                const beforeY = window.scrollY;
                const viewportHeight = window.innerHeight;
                const scrollAmount = Math.floor(viewportHeight * ratio);
                window.scrollBy(0, scrollAmount);
                const afterY = window.scrollY;
                const docHeight = document.documentElement.scrollHeight;
                const nearBottom = afterY + viewportHeight >= docHeight - 50;
                return {
                    beforeY,
                    afterY,
                    viewportHeight,
                    docHeight,
                    nearBottom,
                };
            },
        });
        const scrollInfo = scrollInfoResult[0]?.result;
        console.log(`[autoscroll] round=${round}, currentCount=${currentCount}, previousCount=${previousCount}, stableRounds=${stableRounds}, nearBottom=${scrollInfo?.nearBottom}`);
        if (currentCount === previousCount) {
            stableRounds += 1;
        }
        else {
            stableRounds = 0;
        }
        previousCount = currentCount;
        if (scrollInfo?.nearBottom && stableRounds >= 2) {
            console.log(`[autoscroll] stop: near-bottom-and-stable at round=${round}, count=${currentCount}`);
            return {
                pageUrl,
                totalUniqueMediaUrls: Array.from(collected),
                rounds: round,
                elapsedMs: Date.now() - startedAt,
                endedBy: "near-bottom-and-stable",
            };
        }
        if (stableRounds >= stableRoundsNeeded) {
            console.log(`[autoscroll] stop: stable at round=${round}, count=${currentCount}`);
            return {
                pageUrl,
                totalUniqueMediaUrls: Array.from(collected),
                rounds: round,
                elapsedMs: Date.now() - startedAt,
                endedBy: "stable",
            };
        }
        if (round < maxRounds) {
            await new Promise((resolve) => setTimeout(resolve, waitMsPerRound));
        }
    }
    console.log("[autoscroll] stop: max-rounds");
    return {
        pageUrl: "",
        totalUniqueMediaUrls: Array.from(collected),
        rounds: maxRounds,
        elapsedMs: Date.now() - startedAt,
        endedBy: "max-rounds",
    };
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
            articleCandidates.sort((a, b) => b.mediaCount - a.mediaCount);
            const selected = articleCandidates[0];
            return {
                mode: "current-tweet",
                pageUrl: location.href,
                matchedMediaUrls: selected.mediaUrls,
                articleCandidates,
                selectedArticleIndex: selected.index,
            };
        },
    });
    return injectionResults[0]?.result ?? null;
}
async function saveParsedMediaList(parsedList, saveAs, options) {
    const stats = {
        total: parsedList.length,
        skipped: 0,
        success: 0,
        failed: 0,
    };
    if (parsedList.length === 0) {
        console.log("No parsable media URLs found.");
        return stats;
    }
    console.log(`Found ${parsedList.length} media item(s).`);
    const usedFileNames = new Set();
    const skipPreviouslySaved = options?.skipPreviouslySaved ?? false;
    let savedKeySet = new Set();
    if (skipPreviouslySaved) {
        savedKeySet = await getSavedMediaKeys();
        console.log(`Loaded ${savedKeySet.size} saved media key(s) from storage.`);
    }
    const filteredList = [];
    for (const item of parsedList) {
        if (!skipPreviouslySaved) {
            filteredList.push(item);
            continue;
        }
        const key = buildMediaIdentityKey(item);
        if (!key) {
            filteredList.push(item);
            continue;
        }
        if (savedKeySet.has(key)) {
            stats.skipped += 1;
            console.log(`Skipping already saved media: ${key}`);
            continue;
        }
        filteredList.push(item);
    }
    console.log(`[saveParsedMediaList] total=${stats.total}, skipped=${stats.skipped}, toDownload=${filteredList.length}`);
    for (const [index, target] of filteredList.entries()) {
        console.log(`Processing item ${index + 1}/${filteredList.length}:`, target);
        if (!target.format) {
            console.log("No format found in URL. Skipping for now.", target);
            stats.failed += 1;
            continue;
        }
        const candidates = buildDownloadCandidates(target);
        const downloadResult = await tryDownloadSequentially(candidates, usedFileNames, saveAs);
        if (!downloadResult.success) {
            console.error(`Both orig and large download attempts failed for mediaId=${target.mediaId}`);
            stats.failed += 1;
            continue;
        }
        if (skipPreviouslySaved) {
            const key = buildMediaIdentityKey(target);
            if (key) {
                savedKeySet.add(key);
                await saveSavedMediaKeys(savedKeySet);
                console.log(`Saved media key recorded: ${key}`);
            }
        }
        stats.success += 1;
        console.log(`Download started successfully for mediaId=${target.mediaId}, quality=${downloadResult.used.quality}, finalFileName=${downloadResult.finalFileName}, downloadId=${downloadResult.downloadId}`);
    }
    console.log(`[saveParsedMediaList:done] total=${stats.total}, skipped=${stats.skipped}, success=${stats.success}, failed=${stats.failed}`);
    return stats;
}
function isTargetXPage(tabUrl) {
    return (tabUrl.startsWith("https://x.com/") ||
        tabUrl.startsWith("https://twitter.com/"));
}
async function saveAllVisibleImages(tabId, tabUrl, saveAs) {
    if (!isTargetXPage(tabUrl)) {
        console.log("Not an X/Twitter page:", tabUrl);
        return { total: 0, skipped: 0, success: 0, failed: 0 };
    }
    const collectResult = await autoScrollAndCollectVisibleMediaUrls(tabId, {
        scrollRatio: 0.8,
        waitMsPerRound: 700,
        stableRoundsNeeded: 3,
        maxRounds: 20,
        maxElapsedMs: 30000,
    });
    console.log("Step 24 all-visible collect result:", collectResult);
    if (!collectResult || collectResult.totalUniqueMediaUrls.length === 0) {
        console.log("No pbs.twimg.com/media/ image URLs collected.");
        return { total: 0, skipped: 0, success: 0, failed: 0 };
    }
    const parsedList = collectResult.totalUniqueMediaUrls
        .map((url) => parseMediaUrl(url))
        .filter((item) => item !== null);
    return await saveParsedMediaList(parsedList, saveAs, {
        skipPreviouslySaved: true,
    });
}
async function saveCurrentTweetImages(tabId, tabUrl, saveAs) {
    if (!isTargetXPage(tabUrl)) {
        console.log("Not an X/Twitter page:", tabUrl);
        return { total: 0, skipped: 0, success: 0, failed: 0 };
    }
    const result = await getCurrentTweetMediaUrlsFromPage(tabId);
    console.log("Step 24 current-tweet raw result:", result);
    if (!result || result.matchedMediaUrls.length === 0) {
        console.log("No media URLs found for current tweet candidate.");
        return { total: 0, skipped: 0, success: 0, failed: 0 };
    }
    const parsedList = result.matchedMediaUrls
        .map((url) => parseMediaUrl(url))
        .filter((item) => item !== null);
    return await saveParsedMediaList(parsedList, saveAs, {
        skipPreviouslySaved: false,
    });
}
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "SAVE_ALL_VISIBLE_IMAGES") {
        void saveAllVisibleImages(message.tabId, message.tabUrl, message.saveAs ?? false)
            .then((stats) => sendResponse({ ok: true, stats }))
            .catch((error) => {
            console.error("SAVE_ALL_VISIBLE_IMAGES failed:", error);
            sendResponse({ ok: false, error: String(error) });
        });
        return true;
    }
    if (message?.type === "SAVE_CURRENT_TWEET_IMAGES") {
        void saveCurrentTweetImages(message.tabId, message.tabUrl, message.saveAs ?? true)
            .then((stats) => sendResponse({ ok: true, stats }))
            .catch((error) => {
            console.error("SAVE_CURRENT_TWEET_IMAGES failed:", error);
            sendResponse({ ok: false, error: String(error) });
        });
        return true;
    }
    return false;
});
export {};
