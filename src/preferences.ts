import { Media } from './media.js';
export const OPTIONS_KEY = 'imageSaverOptions';
export type SaveOptions = { maxPages: number; maxSeconds: number; folder: string; fileName: string };
export const DEFAULT_OPTIONS: SaveOptions = { maxPages: 20, maxSeconds: 30, folder: '', fileName: '{mediaId}_orig.{format}' };
function validSegment(segment: string): boolean {
  return !!segment && !/[<>:"/\\|?*\u0000-\u001f]/.test(segment) && !/[. ]$/.test(segment) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment);
}
export function validateOptions(value: SaveOptions): SaveOptions {
  if (!Number.isInteger(value.maxPages) || value.maxPages < 1 || value.maxPages > 1000) throw new Error('最大取得ページ数は1～1000の整数で指定してください。');
  if (!Number.isFinite(value.maxSeconds) || value.maxSeconds < 1 || value.maxSeconds > 300) throw new Error('取得時間の上限は1～300秒で指定してください。');
  const folder = value.folder.trim().replace(/\\/g, '/');
  if (folder.length > 200 || (folder && folder.split('/').some(part => !validSegment(part)))) throw new Error('保存先はダウンロード先からのサブフォルダ名で指定してください。絶対パスや「..」は使用できません。');
  const fileName = value.fileName.trim();
  const sample = fileName.split('{mediaId}').join('IMAGE').split('{format}').join('jpg');
  if (fileName.length > 150 || !fileName.includes('{mediaId}') || !fileName.endsWith('.{format}') || /[{}]/.test(sample) || !validSegment(sample)) {
    throw new Error('ファイル名には{mediaId}を含め、末尾を.{format}にしてください。フォルダ区切りや使用できない文字は指定できません。');
  }
  return { maxPages: value.maxPages, maxSeconds: value.maxSeconds, folder, fileName };
}
export async function getOptions(): Promise<SaveOptions> {
  const stored = await chrome.storage.local.get([OPTIONS_KEY, 'allVisibleScrollSettings']);
  const old = stored.allVisibleScrollSettings as any;
  const value = stored[OPTIONS_KEY] as Partial<SaveOptions> | undefined;
  const options = { ...DEFAULT_OPTIONS, ...(value ?? { maxPages: old?.maxRounds ?? DEFAULT_OPTIONS.maxPages, maxSeconds: old?.maxElapsedSeconds ?? DEFAULT_OPTIONS.maxSeconds }) };
  return validateOptions(options);
}
export function downloadFileName(media: Media, options: Pick<SaveOptions, 'folder' | 'fileName'>): string {
  const name = options.fileName.split('{mediaId}').join(media.mediaId).split('{format}').join(media.format);
  return options.folder ? `${options.folder}/${name}` : name;
}
