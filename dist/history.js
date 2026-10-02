import { isOriginalDownload, isMediaDownload, parseMediaUrl, mediaKey, historyKey } from "./media.js";
const HISTORY_PREFIX = "savedImage:";
const MIGRATED = "imageHistoryMigratedV2";
const INDEXED = 'imageHistoryDownloadIndexV1';
export class ImageHistory {
    async migrate() {
        const stored = await chrome.storage.local.get([MIGRATED, "savedMediaMap", "savedMediaKeys"]);
        if (stored[MIGRATED])
            return;
        const records = {};
        // Preserve real timestamps. Legacy lists with no timestamp remain unknown,
        // rather than inventing a fresh 180-day confirmation period.
        const old = stored.savedMediaMap;
        if (old && typeof old === "object" && !Array.isArray(old))
            for (const [key, timestamp] of Object.entries(old)) {
                const id = key.split("|")[0];
                if (!/^[A-Za-z0-9_-]+$/.test(id) || typeof timestamp !== "number" || !Number.isFinite(timestamp))
                    continue;
                const recordKey = HISTORY_PREFIX + id;
                if (!records[recordKey] || records[recordKey].savedAt < timestamp)
                    records[recordKey] = { savedAt: timestamp, quality: "unknown" };
            }
        if (Array.isArray(stored.savedMediaKeys))
            for (const key of stored.savedMediaKeys) {
                if (typeof key !== "string")
                    continue;
                const id = key.split("|")[0];
                if (/^[A-Za-z0-9_-]+$/.test(id) && !records[HISTORY_PREFIX + id])
                    records[HISTORY_PREFIX + id] = { savedAt: 0, quality: "unknown" };
            }
        // Do not overwrite a newer per-image record if migration was interrupted.
        const current = Object.keys(records).length ? await chrome.storage.local.get(Object.keys(records)) : {};
        for (const key of Object.keys(records))
            if (current[key])
                delete records[key];
        await chrome.storage.local.set({ ...records, [MIGRATED]: true });
        await chrome.storage.local.remove(["savedMediaMap", "savedMediaKeys"]);
    }
    async ensure() {
        if (!this.ready)
            this.ready = (async () => {
                await this.migrate();
                const stored = await chrome.storage.local.get(null);
                if (stored[INDEXED])
                    return;
                // Import verifiable past original downloads once, even if Chrome's file
                // has since moved. The durable image ID records are authoritative after that.
                let items;
                try {
                    items = await chrome.downloads.search({ urlRegex: '^https://pbs\\.twimg\\.com/media/', state: 'complete', limit: 0 });
                }
                catch {
                    return;
                } // Known ID records remain usable if Chrome history is unavailable.
                const rows = {};
                for (const item of items) {
                    const media = parseMediaUrl(item.url);
                    if (!media || !isOriginalDownload({ ...item, exists: true }, media.mediaId))
                        continue;
                    const key = HISTORY_PREFIX + media.mediaId;
                    if (stored[key]?.quality === 'orig')
                        continue;
                    const date = Date.parse(item.startTime);
                    rows[key] = { savedAt: Number.isFinite(date) && date > 0 ? date : Date.now(), quality: 'orig', downloadId: item.id, url: item.url };
                }
                await chrome.storage.local.set({ ...rows, [INDEXED]: true });
            })().catch(error => { this.ready = undefined; throw error; });
        await this.ready;
    }
    async confirmedMany(media) {
        const result = new Map();
        let stored;
        try {
            await this.ensure();
            stored = await chrome.storage.local.get(media.map(historyKey));
        }
        catch {
            return new Map(media.map(m => [mediaKey(m), null]));
        }
        await Promise.all(media.map(async (m) => {
            let confirmed = null;
            const key = historyKey(m);
            const record = stored[key];
            try {
                if (record && Number.isFinite(record.savedAt) && record.savedAt > 0 && record.savedAt <= Date.now()) {
                    if (record.quality === (m.kind === 'video' ? 'best-mp4' : 'orig')) {
                        confirmed = record.downloadId ?? 0;
                    }
                    else if (record.quality === "unknown" && m.kind !== 'video') {
                        // Old records can contain large fallbacks. Verify an original;
                        // an unknown or unreadable record is never a reason to skip.
                        const items = await chrome.downloads.search({ urlRegex: `/media/${m.mediaId}(?:[?.:])`, limit: 0 });
                        const item = items.find(item => isOriginalDownload({ ...item, exists: true }, m.mediaId));
                        if (item) {
                            confirmed = item.id;
                            await chrome.storage.local.set({ [key]: { ...record, quality: "orig", downloadId: item.id, url: item.url } });
                        }
                    }
                }
            }
            catch {
                confirmed = null;
            }
            result.set(mediaKey(m), confirmed);
        }));
        return result;
    }
    async record(media, downloadId) {
        await this.ensure();
        const [item] = await chrome.downloads.search({ id: downloadId });
        if (!isMediaDownload(item, media))
            throw new Error("保存ファイルの完了・形式・存在を確認できません。");
        await chrome.storage.local.set({ [historyKey(media)]: {
                savedAt: Date.now(), quality: media.kind === 'video' ? 'best-mp4' : 'orig', downloadId, url: item.url, ...(media.kind === 'video' ? { bitrate: media.bitrate } : {}),
            } });
    }
    async clear() {
        await this.ensure();
        const stored = await chrome.storage.local.get(null);
        const keys = Object.keys(stored).filter(key => key.startsWith(HISTORY_PREFIX) || key.startsWith('savedVideo:'));
        if (keys.length)
            await chrome.storage.local.remove(keys);
        return keys.length;
    }
}
