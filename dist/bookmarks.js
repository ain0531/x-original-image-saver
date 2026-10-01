import { parseMediaUrl } from './media.js';
export function parseBookmarkPage(body) {
    if (body?.errors?.length)
        throw new Error('Xが投稿データ取得エラーを返しました。取得位置は保持しています。');
    const data = body?.data;
    // Accept a timeline only underneath a bookmark result, never a recommendation.
    const roots = data && Object.entries(data).filter(([key]) => /bookmark/i.test(key)).map(([, value]) => value);
    let instructions;
    const visit = (value, depth) => {
        if (!value || depth > 5 || instructions)
            return;
        if (Array.isArray(value.instructions)) {
            instructions = value.instructions;
            return;
        }
        if (typeof value === 'object')
            for (const child of Object.values(value))
                visit(child, depth + 1);
    };
    roots?.forEach((root) => visit(root, 0));
    if (!instructions)
        throw new Error('ブックマークの応答形式を認識できません。完了とは判定せず取得位置を保持します。');
    const media = new Map();
    const issues = [];
    let cursor;
    let ended = false;
    let posts = 0;
    const verifiedPostIds = [];
    const tweet = (raw, quoted = false) => {
        const result = raw?.__typename === 'TweetWithVisibilityResults' ? raw.tweet : raw;
        const id = result?.rest_id ?? result?.legacy?.id_str ?? '不明';
        if (!result?.legacy) {
            issues.push(`投稿 ${id}: 非公開・削除・取得不能のため画像の有無を確認できません。`);
            return;
        }
        if (!quoted)
            posts++;
        const full = [result.legacy.extended_entities?.media, result.legacy.extended_tweet?.extended_entities?.media].filter(Array.isArray);
        const list = full.length ? full.flat() : result.legacy.entities?.media ?? [];
        if (full.length || !list.length)
            verifiedPostIds.push(id);
        if (!full.length && list.some((item) => item.type === 'photo'))
            issues.push(`投稿 ${id}: 全画像の一覧がなく、複数枚の確認ができません。`);
        for (const item of list) {
            if (item.type === 'video' || item.type === 'animated_gif')
                continue;
            if (item.type !== 'photo') {
                issues.push(`投稿 ${id}: 未対応のメディア種別。`);
                continue;
            }
            const parsed = parseMediaUrl(item.media_url_https ?? item.media_url ?? '');
            if (parsed)
                media.set(parsed.mediaId, parsed);
            else
                issues.push(`投稿 ${id}: 画像URLを認識できません。`);
        }
        if (!quoted && result.quoted_status_result?.result)
            tweet(result.quoted_status_result.result, true);
        if (result.legacy.quoted_status_id_str && !result.quoted_status_result?.result)
            issues.push(`投稿 ${id}: 引用投稿の画像を確認できません。`);
    };
    const entry = (value) => {
        const content = value?.content ?? value;
        if (content?.cursorType === 'Bottom' || String(value?.entryId ?? '').startsWith('cursor-bottom')) {
            if (typeof content.value === 'string' && content.value)
                cursor = content.value;
            else
                ended = true;
            return;
        }
        if (content?.cursorType)
            return;
        const item = content?.itemContent ?? content?.item?.itemContent;
        if (item?.tweet_results) {
            tweet(item.tweet_results.result);
            return;
        }
        if (Array.isArray(content?.items)) {
            content.items.forEach(entry);
            return;
        }
        // Do not count unsupported entries as successful empty posts.
        if (value?.entryId && !/^(cursor-|label-|header-|message-)/.test(value.entryId))
            issues.push(`未対応の投稿項目: ${value.entryId}`);
    };
    for (const instruction of instructions) {
        if (instruction.type === 'TimelineTerminateTimeline' && instruction.direction === 'Bottom')
            ended = true;
        else if (instruction.type === 'TimelineAddEntries')
            (instruction.entries ?? []).forEach(entry);
        else if (instruction.type === 'TimelineReplaceEntry')
            entry(instruction.entry);
        else if (instruction.type === 'TimelineAddToModule')
            (instruction.moduleItems ?? []).forEach(entry);
        else if (!['TimelineClearCache', 'TimelinePinEntry', 'TimelineShowAlert', 'TimelineTerminateTimeline'].includes(instruction.type))
            issues.push(`未対応のタイムライン命令: ${instruction.type}`);
    }
    // Missing cursor is only an end for a recognized, otherwise valid response.
    if (!cursor && !issues.length)
        ended = true;
    return { media: [...media.values()], cursor, ended, issues, posts, verifiedPostIds };
}
