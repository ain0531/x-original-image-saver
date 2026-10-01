export const KEEP_MS = 180 * 24 * 60 * 60 * 1000;
export function parseMediaUrl(raw) {
    try {
        const url = new URL(raw);
        const match = url.pathname.match(/^\/media\/([A-Za-z0-9_-]+)(?:\.([A-Za-z0-9]+)(?::[A-Za-z0-9]+)?)?$/);
        const format = (url.searchParams.get("format") ?? match?.[2] ?? "").toLowerCase();
        if (url.protocol !== "https:" || url.hostname !== "pbs.twimg.com" || !match ||
            !["jpg", "jpeg", "png", "webp", "gif"].includes(format))
            return null;
        return { mediaId: match[1], format,
            origUrl: `https://pbs.twimg.com/media/${match[1]}?format=${format}&name=orig` };
    }
    catch {
        return null;
    }
}
export function isXPage(raw) {
    try {
        const u = new URL(raw);
        return u.protocol === "https:" && ["x.com", "twitter.com"].includes(u.hostname);
    }
    catch {
        return false;
    }
}
export function isOriginalDownload(item, id) {
    if (!item || item.state !== "complete" || item.exists !== true || !item.mime?.startsWith("image/"))
        return false;
    return [item.url, item.finalUrl || item.url].every(raw => {
        const parsed = parseMediaUrl(raw);
        return parsed?.mediaId === id && new URL(raw).searchParams.get("name") === "orig";
    });
}
export function errorText(error) { return error instanceof Error ? error.message : String(error); }
