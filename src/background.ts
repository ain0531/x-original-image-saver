type ParsedMediaUrl = {
  originalUrl: string;
  mediaId: string;
  format: string | null;
  quality: string | null;
  origUrl: string;
  largeUrl: string;
};

type DownloadCandidate = {
  url: string;
  quality: "orig" | "large";
  fileName: string;
};

type VisibleMediaScanResult = {
  mode: "all-visible";
  pageUrl: string;
  totalImages: number;
  matchedMediaUrls: string[];
};

type CurrentTweetScanResult = {
  mode: "current-tweet";
  pageUrl: string;
  matchedMediaUrls: string[];
  articleCandidates: {
    index: number;
    mediaUrls: string[];
    mediaCount: number;
  }[];
  selectedArticleIndex: number | null;
};

type AutoScrollCollectResult = {
  pageUrl: string;
  totalUniqueMediaUrls: string[];
  rounds: number;
  elapsedMs: number;
  endedBy:
    | "stable"
    | "max-rounds"
    | "max-time"
    | "near-bottom-and-stable"
    | "no-result";
};

type AutoScrollOptions = {
  scrollRatio?: number;
  waitMsPerRound?: number;
  stableRoundsNeeded?: number;
  maxRounds?: number;
  maxElapsedMs?: number;
};

type SaveStats = {
  total: number;
  skipped: number;
  success: number;
  failed: number;
};

type SavedMediaMap = Record<string, number>;

const STORAGE_KEY_SAVED_MEDIA_MAP = "savedMediaMap";
const LEGACY_STORAGE_KEY_SAVED_MEDIA = "savedMediaKeys";
const SAVED_MEDIA_KEEP_DAYS = 180;
const SAVED_MEDIA_KEEP_MS = SAVED_MEDIA_KEEP_DAYS * 24 * 60 * 60 * 1000;

function parseMediaUrl(rawUrl: string): ParsedMediaUrl | null {
  try {
    const url = new URL(rawUrl);

    const pathMatch = url.pathname.match(/\/media\/([^/?]+)/);
    const mediaId = pathMatch?.[1] ?? null;

    if (!mediaId) {
      console.warn("[parseMediaUrl] mediaId not found:", rawUrl);
      return null;
    }

    const format = url.searchParams.get("format");
    const quality = url.searchParams.get("name");

    const orig = new URL(url.toString());
    orig.searchParams.set("name", "orig");

    const large = new URL(url.toString());
    large.searchParams.set("name", "large");

    const parsed: ParsedMediaUrl = {
      originalUrl: rawUrl,
      mediaId,
      format,
      quality,
      origUrl: orig.toString(),
      largeUrl: large.toString(),
    };

    console.log("[parseMediaUrl] parsed:", parsed);

    return parsed;
  } catch (error) {
    console.error("Failed to parse media URL:", rawUrl, error);
    return null;
  }
}

function buildMediaIdentityKey(parsed: ParsedMediaUrl): string | null {
  if (!parsed.format) {
    console.warn("[buildMediaIdentityKey] format missing:", parsed);
    return null;
  }

  return `${parsed.mediaId}|${parsed.format}`;
}

function isSavedMediaMap(value: unknown): value is SavedMediaMap {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  return Object.values(value).every((v) => typeof v === "number");
}

async function getSavedMediaMap(): Promise<SavedMediaMap> {
  const result = await chrome.storage.local.get([
    STORAGE_KEY_SAVED_MEDIA_MAP,
    LEGACY_STORAGE_KEY_SAVED_MEDIA,
  ]);

  const current = result[STORAGE_KEY_SAVED_MEDIA_MAP];
  if (isSavedMediaMap(current)) {
    console.log(
      `[getSavedMediaMap] current map loaded: ${Object.keys(current).length} item(s)`
    );
    return current;
  }

  const legacy = result[LEGACY_STORAGE_KEY_SAVED_MEDIA];
  if (Array.isArray(legacy)) {
    const now = Date.now();
    const migrated: SavedMediaMap = {};

    for (const item of legacy) {
      if (typeof item === "string") {
        migrated[item] = now;
      }
    }

    await chrome.storage.local.set({
      [STORAGE_KEY_SAVED_MEDIA_MAP]: migrated,
    });
    await chrome.storage.local.remove(LEGACY_STORAGE_KEY_SAVED_MEDIA);

    console.log(
      `[migration] migrated legacy savedMediaKeys -> savedMediaMap (${Object.keys(migrated).length} items)`
    );

    return migrated;
  }

  console.log("[getSavedMediaMap] no saved map found, using empty map");
  return {};
}

async function saveSavedMediaMap(map: SavedMediaMap): Promise<void> {
  await chrome.storage.local.set({
    [STORAGE_KEY_SAVED_MEDIA_MAP]: map,
  });
}

function pruneExpiredSavedMediaMap(
  map: SavedMediaMap,
  now: number = Date.now()
): { prunedMap: SavedMediaMap; removedCount: number } {
  const cutoff = now - SAVED_MEDIA_KEEP_MS;
  const prunedMap: SavedMediaMap = {};
  let removedCount = 0;

  for (const [key, savedAt] of Object.entries(map)) {
    if (savedAt >= cutoff) {
      prunedMap[key] = savedAt;
    } else {
      removedCount += 1;
    }
  }

  return { prunedMap, removedCount };
}

function countSavedMediaMap(map: SavedMediaMap): number {
  return Object.keys(map).length;
}

function buildDownloadCandidates(parsed: ParsedMediaUrl): DownloadCandidate[] {
  if (!parsed.format) {
    console.warn("[buildDownloadCandidates] format missing:", parsed);
    return [];
  }

  const candidates = [
    {
      url: parsed.origUrl,
      quality: "orig" as const,
      fileName: `${parsed.mediaId}_orig.${parsed.format}`,
    },
    {
      url: parsed.largeUrl,
      quality: "large" as const,
      fileName: `${parsed.mediaId}_large.${parsed.format}`,
    },
  ];

  console.log("[buildDownloadCandidates] candidates:", candidates);

  return candidates;
}

function addSequenceToFileName(fileName: string, sequence: number): string {
  const lastDotIndex = fileName.lastIndexOf(".");

  if (lastDotIndex === -1) {
    return `${fileName}_${sequence}`;
  }

  const base = fileName.slice(0, lastDotIndex);
  const ext = fileName.slice(lastDotIndex);

  return `${base}_${sequence}${ext}`;
}

function resolveUniqueFileName(
  requestedFileName: string,
  usedFileNames: Set<string>
): string {
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

async function tryDownloadSequentially(
  candidates: DownloadCandidate[],
  usedFileNames: Set<string>,
  saveAs: boolean
): Promise<
  | { success: true; used: DownloadCandidate; finalFileName: string; downloadId: number }
  | { success: false }
> {
  console.log(
    `[tryDownloadSequentially] start: candidates=${candidates.length}, saveAs=${saveAs}`
  );

  for (const candidate of candidates) {
    const finalFileName = resolveUniqueFileName(candidate.fileName, usedFileNames);

    try {
      console.log(
        `Trying download: quality=${candidate.quality}, requested=${candidate.fileName}, final=${finalFileName}, saveAs=${saveAs}`,
        candidate.url
      );

      const downloadId = await chrome.downloads.download({
        url: candidate.url,
        filename: finalFileName,
        saveAs,
      });

      console.log(
        `[tryDownloadSequentially] accepted: quality=${candidate.quality}, finalFileName=${finalFileName}, downloadId=${downloadId}`
      );

      return {
        success: true,
        used: candidate,
        finalFileName,
        downloadId,
      };
    } catch (error) {
      console.warn(`Download failed with ${candidate.quality}:`, error);
    }
  }

  console.warn("[tryDownloadSequentially] all candidates failed");
  return { success: false };
}

async function getAllVisibleMediaUrlsFromPage(
  tabId: number
): Promise<VisibleMediaScanResult | null> {
  const injectionResults = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const allImgSrcs = Array.from(document.querySelectorAll("img"))
        .map((img) => img.getAttribute("src"))
        .filter((src): src is string => Boolean(src));

      const mediaUrls = Array.from(
        new Set(
          allImgSrcs.filter((src) => src.includes("pbs.twimg.com/media/"))
        )
      );

      return {
        mode: "all-visible" as const,
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

async function autoScrollAndCollectVisibleMediaUrls(
  tabId: number,
  options?: AutoScrollOptions
): Promise<AutoScrollCollectResult> {
  const scrollRatio = options?.scrollRatio ?? 0.8;
  const waitMsPerRound = options?.waitMsPerRound ?? 700;
  const stableRoundsNeeded = options?.stableRoundsNeeded ?? 3;
  const maxRounds = options?.maxRounds ?? 20;
  const maxElapsedMs = options?.maxElapsedMs ?? 30000;

  console.log("[autoScrollAndCollectVisibleMediaUrls] options:", {
    scrollRatio,
    waitMsPerRound,
    stableRoundsNeeded,
    maxRounds,
    maxElapsedMs,
  });

  const startedAt = Date.now();
  const collected = new Set<string>();

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
      func: (ratio: number) => {
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

    const scrollInfo = scrollInfoResult[0]?.result as
      | {
          beforeY: number;
          afterY: number;
          viewportHeight: number;
          docHeight: number;
          nearBottom: boolean;
        }
      | undefined;

    console.log(
      `[autoscroll] round=${round}, currentCount=${currentCount}, previousCount=${previousCount}, stableRounds=${stableRounds}, nearBottom=${scrollInfo?.nearBottom}`
    );

    if (currentCount === previousCount) {
      stableRounds += 1;
    } else {
      stableRounds = 0;
    }

    previousCount = currentCount;

    if (scrollInfo?.nearBottom && stableRounds >= 2) {
      console.log(
        `[autoscroll] stop: near-bottom-and-stable at round=${round}, count=${currentCount}`
      );
      return {
        pageUrl,
        totalUniqueMediaUrls: Array.from(collected),
        rounds: round,
        elapsedMs: Date.now() - startedAt,
        endedBy: "near-bottom-and-stable",
      };
    }

    if (stableRounds >= stableRoundsNeeded) {
      console.log(
        `[autoscroll] stop: stable at round=${round}, count=${currentCount}`
      );
      return {
        pageUrl,
        totalUniqueMediaUrls: Array.from(collected),
        rounds: round,
        elapsedMs: Date.now() - startedAt,
        endedBy: "stable",
      };
    }

    if (round < maxRounds) {
      await new Promise<void>((resolve) => setTimeout(resolve, waitMsPerRound));
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

async function getCurrentTweetMediaUrlsFromPage(
  tabId: number
): Promise<CurrentTweetScanResult | null> {
  const injectionResults = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const articles = Array.from(document.querySelectorAll("article"));

      const articleCandidates = articles
        .map((article, index) => {
          const imgSrcs = Array.from(article.querySelectorAll("img"))
            .map((img) => img.getAttribute("src"))
            .filter((src): src is string => Boolean(src));

          const mediaUrls = Array.from(
            new Set(
              imgSrcs.filter((src) => src.includes("pbs.twimg.com/media/"))
            )
          );

          return {
            index,
            mediaUrls,
            mediaCount: mediaUrls.length,
          };
        })
        .filter((item) => item.mediaCount > 0);

      if (articleCandidates.length === 0) {
        return {
          mode: "current-tweet" as const,
          pageUrl: location.href,
          matchedMediaUrls: [],
          articleCandidates: [],
          selectedArticleIndex: null,
        };
      }

      articleCandidates.sort((a, b) => b.mediaCount - a.mediaCount);

      const selected = articleCandidates[0];

      return {
        mode: "current-tweet" as const,
        pageUrl: location.href,
        matchedMediaUrls: selected.mediaUrls,
        articleCandidates,
        selectedArticleIndex: selected.index,
      };
    },
  });

  const result = injectionResults[0]?.result ?? null;
  console.log("[getCurrentTweetMediaUrlsFromPage] result:", result);
  return result;
}

async function saveParsedMediaList(
  parsedList: ParsedMediaUrl[],
  saveAs: boolean,
  options?: {
    skipPreviouslySaved?: boolean;
  }
): Promise<SaveStats> {
  const stats: SaveStats = {
    total: parsedList.length,
    skipped: 0,
    success: 0,
    failed: 0,
  };

  console.log("[saveParsedMediaList] start:", {
    parsedListLength: parsedList.length,
    saveAs,
    skipPreviouslySaved: options?.skipPreviouslySaved ?? false,
    parsedList,
  });

  if (parsedList.length === 0) {
    console.log("No parsable media URLs found.");
    return stats;
  }

  console.log(`Found ${parsedList.length} media item(s).`);

  const usedFileNames = new Set<string>();
  const skipPreviouslySaved = options?.skipPreviouslySaved ?? false;

  let savedMediaMap: SavedMediaMap = {};
  let savedMediaMapDirty = false;

  if (skipPreviouslySaved) {
    const loadedMap = await getSavedMediaMap();
    const { prunedMap, removedCount } = pruneExpiredSavedMediaMap(loadedMap);

    savedMediaMap = prunedMap;
    if (removedCount > 0) {
      savedMediaMapDirty = true;
      console.log(
        `[savedMediaMap] removed expired records: ${removedCount}, remaining=${countSavedMediaMap(savedMediaMap)}`
      );
    } else {
      console.log(
        `[savedMediaMap] loaded records: ${countSavedMediaMap(savedMediaMap)}`
      );
    }
  }

  const filteredList: ParsedMediaUrl[] = [];

  for (const item of parsedList) {
    if (!skipPreviouslySaved) {
      filteredList.push(item);
      continue;
    }

    const key = buildMediaIdentityKey(item);

    if (!key) {
      console.log("[saveParsedMediaList] no identity key, keep target:", item);
      filteredList.push(item);
      continue;
    }

    if (savedMediaMap[key] !== undefined) {
      stats.skipped += 1;
      console.log(`Skipping already saved media: ${key}`);
      continue;
    }

    console.log(`[saveParsedMediaList] not found in saved map, keep: ${key}`);
    filteredList.push(item);
  }

  console.log(
    `[saveParsedMediaList] total=${stats.total}, skipped=${stats.skipped}, toDownload=${filteredList.length}`
  );
  console.log("[saveParsedMediaList] filteredList:", filteredList);

  for (const [index, target] of filteredList.entries()) {
    console.log(`Processing item ${index + 1}/${filteredList.length}:`, target);

    if (!target.format) {
      console.log("No format found in URL. Skipping for now.", target);
      stats.failed += 1;
      continue;
    }

    const candidates = buildDownloadCandidates(target);
    const downloadResult = await tryDownloadSequentially(
      candidates,
      usedFileNames,
      saveAs
    );

    if (!downloadResult.success) {
      console.error(
        `Both orig and large download attempts failed for mediaId=${target.mediaId}`
      );
      stats.failed += 1;
      continue;
    }

    if (skipPreviouslySaved) {
      const key = buildMediaIdentityKey(target);
      if (key) {
        savedMediaMap[key] = Date.now();
        savedMediaMapDirty = true;
        console.log(`Saved media key recorded/updated: ${key}`);
      }
    }

    stats.success += 1;

    console.log(
      `Download started successfully for mediaId=${target.mediaId}, quality=${downloadResult.used.quality}, finalFileName=${downloadResult.finalFileName}, downloadId=${downloadResult.downloadId}`
    );
  }

  if (skipPreviouslySaved && savedMediaMapDirty) {
    await saveSavedMediaMap(savedMediaMap);
    console.log(
      `[savedMediaMap] persisted records: ${countSavedMediaMap(savedMediaMap)}`
    );
  }

  console.log(
    `[saveParsedMediaList:done] total=${stats.total}, skipped=${stats.skipped}, success=${stats.success}, failed=${stats.failed}`
  );

  return stats;
}

function isTargetXPage(tabUrl: string): boolean {
  return (
    tabUrl.startsWith("https://x.com/") ||
    tabUrl.startsWith("https://twitter.com/")
  );
}

async function saveAllVisibleImages(
  tabId: number,
  tabUrl: string,
  saveAs: boolean,
  scrollSettings?: AutoScrollOptions,
  skipPreviouslySaved: boolean = true
): Promise<SaveStats> {
  console.log("[saveAllVisibleImages] start:", {
    tabId,
    tabUrl,
    saveAs,
    scrollSettings,
    skipPreviouslySaved,
  });

  if (!isTargetXPage(tabUrl)) {
    console.log("Not an X/Twitter page:", tabUrl);
    return { total: 0, skipped: 0, success: 0, failed: 0 };
  }

  const collectResult = await autoScrollAndCollectVisibleMediaUrls(
    tabId,
    scrollSettings
  );

  console.log("[saveAllVisibleImages] collectResult:", collectResult);

  if (!collectResult || collectResult.totalUniqueMediaUrls.length === 0) {
    console.log("No pbs.twimg.com/media/ image URLs collected.");
    return { total: 0, skipped: 0, success: 0, failed: 0 };
  }

  const parsedCandidates = collectResult.totalUniqueMediaUrls.map((url: string) =>
    parseMediaUrl(url)
  );
  console.log("[saveAllVisibleImages] parsedCandidates:", parsedCandidates);

  const parsedList = parsedCandidates.filter(
    (item): item is ParsedMediaUrl => item !== null
  );

  console.log("[saveAllVisibleImages] parsedList length:", parsedList.length);

  return await saveParsedMediaList(parsedList, saveAs, {
    skipPreviouslySaved,
  });
}

async function saveCurrentTweetImages(
  tabId: number,
  tabUrl: string,
  saveAs: boolean,
  skipPreviouslySaved: boolean = true
): Promise<SaveStats> {
  console.log("[saveCurrentTweetImages] start:", {
    tabId,
    tabUrl,
    saveAs,
    skipPreviouslySaved,
  });

  if (!isTargetXPage(tabUrl)) {
    console.log("Not an X/Twitter page:", tabUrl);
    return { total: 0, skipped: 0, success: 0, failed: 0 };
  }

  const result = await getCurrentTweetMediaUrlsFromPage(tabId);

  console.log("[saveCurrentTweetImages] raw result:", result);

  if (!result || result.matchedMediaUrls.length === 0) {
    console.log("No media URLs found for current tweet candidate.");
    return { total: 0, skipped: 0, success: 0, failed: 0 };
  }

  const parsedCandidates = result.matchedMediaUrls.map((url: string) =>
    parseMediaUrl(url)
  );
  console.log("[saveCurrentTweetImages] parsedCandidates:", parsedCandidates);

  const parsedList = parsedCandidates.filter(
    (item): item is ParsedMediaUrl => item !== null
  );

  console.log("[saveCurrentTweetImages] parsedList length:", parsedList.length);

  return await saveParsedMediaList(parsedList, saveAs, {
    skipPreviouslySaved,
  });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  console.log("[onMessage] received:", message);

  if (message?.type === "SAVE_ALL_VISIBLE_IMAGES") {
    void saveAllVisibleImages(
      message.tabId,
      message.tabUrl,
      message.saveAs ?? false,
      message.scrollSettings,
      message.skipPreviouslySaved ?? true
    )
      .then((stats) => {
        console.log("[onMessage] SAVE_ALL_VISIBLE_IMAGES stats:", stats);
        sendResponse({ ok: true, stats });
      })
      .catch((error) => {
        console.error("SAVE_ALL_VISIBLE_IMAGES failed:", error);
        sendResponse({ ok: false, error: String(error) });
      });

    return true;
  }

  if (message?.type === "SAVE_CURRENT_TWEET_IMAGES") {
    void saveCurrentTweetImages(
      message.tabId,
      message.tabUrl,
      message.saveAs ?? true,
      message.skipPreviouslySaved ?? true
    )
      .then((stats) => {
        console.log("[onMessage] SAVE_CURRENT_TWEET_IMAGES stats:", stats);
        sendResponse({ ok: true, stats });
      })
      .catch((error) => {
        console.error("SAVE_CURRENT_TWEET_IMAGES failed:", error);
        sendResponse({ ok: false, error: String(error) });
      });

    return true;
  }

  return false;
});

export {};