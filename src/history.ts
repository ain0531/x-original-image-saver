import { KEEP_MS, Media, isOriginalDownload } from "./media.js";
export type SavedImage = { savedAt: number; quality: "orig" | "unknown"; downloadId?: number; url?: string };
const HISTORY_PREFIX = "savedImage:";
const MIGRATED = "imageHistoryMigratedV2";
export class ImageHistory {
  private ready: Promise<void> | undefined;
  private async migrate(): Promise<void> {
    const stored = await chrome.storage.local.get([MIGRATED, "savedMediaMap", "savedMediaKeys"]);
    if (stored[MIGRATED]) return;
    const records: Record<string, SavedImage> = {};
    // Preserve real timestamps. Legacy lists with no timestamp remain unknown,
    // rather than inventing a fresh 180-day confirmation period.
    const old = stored.savedMediaMap;
    if (old && typeof old === "object" && !Array.isArray(old)) for (const [key, timestamp] of Object.entries(old)) {
      const id = key.split("|")[0];
      if (!/^[A-Za-z0-9_-]+$/.test(id) || typeof timestamp !== "number" || !Number.isFinite(timestamp)) continue;
      const recordKey = HISTORY_PREFIX + id;
      if (!records[recordKey] || records[recordKey].savedAt < timestamp) records[recordKey] = { savedAt: timestamp, quality: "unknown" };
    }
    if (Array.isArray(stored.savedMediaKeys)) for (const key of stored.savedMediaKeys) {
      if (typeof key !== "string") continue;
      const id = key.split("|")[0];
      if (/^[A-Za-z0-9_-]+$/.test(id) && !records[HISTORY_PREFIX + id]) records[HISTORY_PREFIX + id] = { savedAt: 0, quality: "unknown" };
    }
    // Do not overwrite a newer per-image record if migration was interrupted.
    const current = Object.keys(records).length ? await chrome.storage.local.get(Object.keys(records)) : {};
    for (const key of Object.keys(records)) if (current[key]) delete records[key];
    await chrome.storage.local.set({ ...records, [MIGRATED]: true });
    await chrome.storage.local.remove(["savedMediaMap", "savedMediaKeys"]);
  }
  private async ensure(): Promise<void> {
    if (!this.ready) this.ready = this.migrate().catch(error => { this.ready = undefined; throw error; });
    await this.ready;
  }
  async confirmedMany(media: Media[]): Promise<Map<string, number | null>> {
    const result = new Map<string, number | null>();
    let stored: Record<string, any>;
    try { await this.ensure(); stored = await chrome.storage.local.get(media.map(m => HISTORY_PREFIX + m.mediaId)); }
    catch { return new Map(media.map(m => [m.mediaId, null])); }
    await Promise.all(media.map(async m => {
      let confirmed: number | null = null;
      const key = HISTORY_PREFIX + m.mediaId;
      const record = stored[key] as SavedImage | undefined;
      try {
        if (record && Number.isFinite(record.savedAt) && record.savedAt > 0 && record.savedAt <= Date.now() && Date.now() - record.savedAt <= KEEP_MS) {
          if (record.quality === "orig" && Number.isInteger(record.downloadId)) {
            const [item] = await chrome.downloads.search({ id: record.downloadId });
            if (isOriginalDownload(item, m.mediaId)) confirmed = item.id;
          } else if (record.quality === "unknown") {
            // Old records can contain large fallbacks. Verify an original;
            // an unknown or unreadable record is never a reason to skip.
            const items = await chrome.downloads.search({ urlRegex: `/media/${m.mediaId}(?:[?.:])`, limit: 100 });
            const item = items.find(item => isOriginalDownload(item, m.mediaId));
            if (item) {
              confirmed = item.id;
              await chrome.storage.local.set({ [key]: { ...record, quality: "orig", downloadId: item.id, url: item.url } });
            }
          }
        } else if (record && Number.isFinite(record.savedAt) && Date.now() - record.savedAt > KEEP_MS) {
          await chrome.storage.local.remove(key);
        }
      } catch { confirmed = null; }
      result.set(m.mediaId, confirmed);
    }));
    return result;
  }
  async record(media: Media, downloadId: number): Promise<void> {
    await this.ensure();
    const [item] = await chrome.downloads.search({ id: downloadId });
    if (!isOriginalDownload(item, media.mediaId)) throw new Error("原寸画像の完了・ファイル存在を確認できません。");
    await chrome.storage.local.set({ [HISTORY_PREFIX + media.mediaId]: {
      savedAt: Date.now(), quality: "orig", downloadId, url: item.url,
    } satisfies SavedImage });
  }
  async clear(): Promise<number> {
    await this.ensure();
    const stored = await chrome.storage.local.get(null);
    const keys = Object.keys(stored).filter(key => key.startsWith(HISTORY_PREFIX));
    if (keys.length) await chrome.storage.local.remove(keys);
    return keys.length;
  }
}
