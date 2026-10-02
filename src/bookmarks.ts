import { Media, tweetMedia, mediaKey } from './media.js';
export type BookmarkPage = { media: Media[]; cursor?: string; ended: boolean; issues: string[]; posts: number; verifiedPostIds: string[] };
export function parseBookmarkPage(body: any): BookmarkPage {
  if (body?.errors?.length) throw new Error('Xが投稿データ取得エラーを返しました。取得位置は保持しています。');
  const data = body?.data;
  // Accept a timeline only underneath a bookmark result, never a recommendation.
  const roots = data && Object.entries(data).filter(([key]) => /bookmark/i.test(key)).map(([, value]) => value);
  let instructions: any[] | undefined;
  const visit = (value: any, depth: number) => {
    if (!value || depth > 5 || instructions) return;
    if (Array.isArray(value.instructions)) { instructions = value.instructions; return; }
    if (typeof value === 'object') for (const child of Object.values(value)) visit(child, depth + 1);
  };
  roots?.forEach((root: unknown) => visit(root, 0));
  if (!instructions) throw new Error('ブックマークの応答形式を認識できません。完了とは判定せず取得位置を保持します。');
  const media = new Map<string, Media>();
  const issues: string[] = [];
  let cursor: string | undefined;
  let ended = false;
  let posts = 0;
  const verifiedPostIds: string[] = [];
  const tweet = (raw: any, quoted = false) => {
    const result = raw?.__typename === 'TweetWithVisibilityResults' ? raw.tweet : raw;
    const id = result?.rest_id ?? result?.legacy?.id_str ?? '不明';
    if (!result?.legacy) { issues.push(`投稿 ${id}: 非公開・削除・取得不能のため画像の有無を確認できません。`); return; }
    if (!quoted) posts++;
    const full = [result.legacy.extended_entities?.media, result.legacy.extended_tweet?.extended_entities?.media].filter(Array.isArray);
    const list = full.length ? full.flat() : result.legacy.entities?.media ?? [];
    if (full.length || !list.length) verifiedPostIds.push(id);
    if (!full.length && list.length) issues.push(`投稿 ${id}: 全画像・動画の一覧がなく、複数ファイルの確認ができません。`);
    for (const item of list) {
      const parsed = tweetMedia(item);
      if (parsed.media) media.set(mediaKey(parsed.media), parsed.media);
      if (parsed.issue) issues.push(`投稿 ${id}: ${parsed.issue}`);
    }
    if (!quoted && result.quoted_status_result?.result) tweet(result.quoted_status_result.result, true);
    if (result.legacy.quoted_status_id_str && !result.quoted_status_result?.result) issues.push(`投稿 ${id}: 引用投稿の画像を確認できません。`);
  };
  const entry = (value: any) => {
    const content = value?.content ?? value;
    if (content?.cursorType === 'Bottom' || String(value?.entryId ?? '').startsWith('cursor-bottom')) {
      if (typeof content.value === 'string' && content.value) cursor = content.value;
      else ended = true;
      return;
    }
    if (content?.cursorType) return;
    const item = content?.itemContent ?? content?.item?.itemContent;
    if (item?.tweet_results) { tweet(item.tweet_results.result); return; }
    if (Array.isArray(content?.items)) { content.items.forEach(entry); return; }
    // Do not count unsupported entries as successful empty posts.
    if (value?.entryId && !/^(cursor-|label-|header-|message-)/.test(value.entryId)) issues.push(`未対応の投稿項目: ${value.entryId}`);
  };
  for (const instruction of instructions as any[]) {
    if (instruction.type === 'TimelineTerminateTimeline' && instruction.direction === 'Bottom') ended = true;
    else if (instruction.type === 'TimelineAddEntries') (instruction.entries ?? []).forEach(entry);
    else if (instruction.type === 'TimelineReplaceEntry') entry(instruction.entry);
    else if (instruction.type === 'TimelineAddToModule') (instruction.moduleItems ?? []).forEach(entry);
    else if (!['TimelineClearCache', 'TimelinePinEntry', 'TimelineShowAlert', 'TimelineTerminateTimeline'].includes(instruction.type)) issues.push(`未対応のタイムライン命令: ${instruction.type}`);
  }
  // Missing cursor is only an end for a recognized, otherwise valid response.
  if (!cursor && !issues.length) ended = true;
  return { media: [...media.values()], cursor, ended, issues, posts, verifiedPostIds };
}
