export function mediaKey(media) { return media.kind === 'video' ? `video:${media.mediaId}` : media.mediaId; }
export function historyKey(media) { return `${media.kind === 'video' ? 'savedVideo:' : 'savedImage:'}${media.mediaId}`; }
export function isVideoUrl(raw) {
    try {
        const url = new URL(raw);
        return url.protocol === 'https:' && url.hostname === 'video.twimg.com' && /^\/(ext_tw_video|amplify_video|tweet_video)\/.+\.mp4$/.test(url.pathname) && !url.username && !url.password;
    }
    catch {
        return false;
    }
}
export function tweetMedia(item) {
    if (item?.type === 'photo') {
        const media = parseMediaUrl(item.media_url_https ?? item.media_url ?? '');
        return media ? { media } : { issue: '画像URLを認識できません。' };
    }
    if (!['video', 'animated_gif'].includes(item?.type))
        return { issue: '未対応のメディア種別。' };
    const id = typeof item.id_str === 'string' && /^\d+$/.test(item.id_str) ? item.id_str : typeof item.media_key === 'string' ? item.media_key.match(/^\d+_(\d+)$/)?.[1] : undefined;
    if (!id)
        return { issue: '動画のメディアIDを確認できません。' };
    const variants = Array.isArray(item.video_info?.variants) ? item.video_info.variants : [];
    const mp4 = variants.filter((variant) => variant?.content_type === 'video/mp4' && typeof variant.url === 'string' && isVideoUrl(variant.url));
    if (!mp4.length)
        return { issue: '保存可能なMP4を確認できません（HLSのみの動画は未対応）。' };
    const knownRate = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
    if (mp4.length > 1 && mp4.some((variant) => !knownRate(variant.bitrate)))
        return { issue: '動画の最高ビットレートを確認できません。' };
    const area = (raw) => { const size = new URL(raw).pathname.match(/\/(\d+)x(\d+)\//); return size ? Number(size[1]) * Number(size[2]) : 0; };
    mp4.sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0) || area(b.url) - area(a.url) || a.url.localeCompare(b.url));
    const best = mp4[0];
    if (best.bitrate != null && !knownRate(best.bitrate))
        return { issue: '動画のビットレートを認識できません。' };
    return { media: { kind: 'video', mediaId: id, format: 'mp4', origUrl: best.url, bitrate: best.bitrate ?? 0 } };
}
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
export function isMediaDownload(item, media) {
    if (media.kind !== 'video')
        return isOriginalDownload(item, media.mediaId);
    if (!item || item.state !== 'complete' || item.exists !== true || item.mime?.split(';')[0].trim().toLowerCase() !== 'video/mp4' || !isVideoUrl(media.origUrl))
        return false;
    const path = new URL(media.origUrl).pathname;
    return [item.url, item.finalUrl || item.url].every(raw => isVideoUrl(raw) && new URL(raw).pathname === path);
}
export function errorText(error) { return error instanceof Error ? error.message : String(error); }
