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
  return parseTimelineMedia(instructions, true);
}
export class AccountMediaResponseError extends Error {}
export function parseAccountMediaPage(body: any, userId: string, photoOnly: boolean, requestedUserId?: string, videoOnly = false): BookmarkPage {
  if (body?.errors?.length) throw new AccountMediaResponseError('Xがメディア一覧の取得エラーを返しました。取得位置は保持しています。');
  const user = body?.data?.user?.result;
  if (!user || typeof user !== 'object' || (user.__typename && user.__typename !== 'User')) throw new AccountMediaResponseError('アカウントのメディア一覧を取得できませんでした。ユーザー応答が空または取得不能です。');
  if (typeof userId !== 'string' || !/^\d+$/.test(userId)) throw new AccountMediaResponseError('保存対象のアカウントIDを確認できません。');
  if (user.rest_id !== undefined && user.rest_id !== userId) throw new AccountMediaResponseError(`取得したメディア一覧のアカウントIDが一致しません（対象: ${userId}、応答: ${String(user.rest_id).slice(0, 30)}）。`);
  // UserMedia may return only a timeline, without repeating the user identity.
  // Only our own request to the already-resolved user ID can establish it then.
  if (user.rest_id === undefined && requestedUserId !== userId) throw new AccountMediaResponseError('メディア応答にアカウントIDがなく、取得要求の対象も確認できません。');
  const instructions = user.timeline_v2?.timeline?.instructions ?? user.timeline?.timeline?.instructions;
  if (!Array.isArray(instructions)) throw new AccountMediaResponseError('アカウントのメディア一覧の応答形式を認識できません。');
  return parseTimelineMedia(instructions, false, photoOnly, videoOnly);
}
function parseTimelineMedia(instructions: any[], includeQuotes: boolean, photoOnly = false, videoOnly = false): BookmarkPage {
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
      if (photoOnly && ['video', 'animated_gif'].includes(item.type)) continue;
      if (videoOnly && item.type === 'photo') continue;
      const parsed = tweetMedia(item);
      if (parsed.media) media.set(mediaKey(parsed.media), parsed.media);
      if (parsed.issue) issues.push(`投稿 ${id}: ${parsed.issue}`);
    }
    if (includeQuotes && !quoted && result.quoted_status_result?.result) tweet(result.quoted_status_result.result, true);
    if (includeQuotes && result.legacy.quoted_status_id_str && !result.quoted_status_result?.result) issues.push(`投稿 ${id}: 引用投稿の画像を確認できません。`);
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
