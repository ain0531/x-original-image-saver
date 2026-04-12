"use strict";
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
async function getMediaUrlsFromPage(tabId) {
    const injectionResults = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
            const allImgSrcs = Array.from(document.querySelectorAll("img"))
                .map((img) => img.getAttribute("src"))
                .filter((src) => Boolean(src));
            const mediaUrls = Array.from(new Set(allImgSrcs.filter((src) => src.includes("pbs.twimg.com/media/"))));
            return {
                pageUrl: location.href,
                totalImages: allImgSrcs.length,
                matchedMediaUrls: mediaUrls,
            };
        },
    });
    return injectionResults[0]?.result ?? null;
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
async function tryDownloadSequentially(candidates) {
    for (const candidate of candidates) {
        try {
            console.log(`Trying download: ${candidate.quality}`, candidate.url);
            const downloadId = await chrome.downloads.download({
                url: candidate.url,
                filename: candidate.fileName,
                saveAs: true,
            });
            return {
                success: true,
                used: candidate,
                downloadId,
            };
        }
        catch (error) {
            console.warn(`Download failed with ${candidate.quality}:`, error);
        }
    }
    return { success: false };
}
chrome.action.onClicked.addListener(async (tab) => {
    try {
        if (!tab.id) {
            console.error("No active tab id.");
            return;
        }
        if (!tab.url) {
            console.error("No tab URL.");
            return;
        }
        const isTargetPage = tab.url.startsWith("https://x.com/") ||
            tab.url.startsWith("https://twitter.com/");
        if (!isTargetPage) {
            console.log("Not an X/Twitter page:", tab.url);
            return;
        }
        const result = await getMediaUrlsFromPage(tab.id);
        console.log("Step 14 raw result:", result);
        if (!result || result.matchedMediaUrls.length === 0) {
            console.log("No pbs.twimg.com/media/ image URLs found on this page.");
            return;
        }
        const parsedList = result.matchedMediaUrls
            .map((url) => parseMediaUrl(url))
            .filter((item) => item !== null);
        if (parsedList.length === 0) {
            console.log("No parsable media URLs found.");
            return;
        }
        console.log(`Found ${parsedList.length} media item(s).`);
        for (const [index, target] of parsedList.entries()) {
            console.log(`Processing item ${index + 1}/${parsedList.length}:`, target);
            if (!target.format) {
                console.log("No format found in URL. Skipping for now.", target);
                continue;
            }
            const candidates = buildDownloadCandidates(target);
            const downloadResult = await tryDownloadSequentially(candidates);
            if (!downloadResult.success) {
                console.error(`Both orig and large download attempts failed for mediaId=${target.mediaId}`);
                continue;
            }
            console.log(`Download started successfully for mediaId=${target.mediaId}, quality=${downloadResult.used.quality}, downloadId=${downloadResult.downloadId}`);
        }
    }
    catch (error) {
        console.error("Step 14 failed:", error);
    }
});
