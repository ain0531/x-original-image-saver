import { errorText } from './media.js';
import { sharedHistory } from './history.js';
import { directBookmarks } from './direct-bookmarks.js';
export type MediaSearchJob = {
  id: string; query: string; tabId: number; status: 'running' | 'found' | 'not-found' | 'paused';
  storeId?: string; scope?: string; cursor?: string; pages: number; posts: number;
  postId?: string; via?: 'history' | 'bookmarks'; error?: string; startedAt: number;
};
const SEARCH_KEY = 'mediaSearchJob';
// Paced between pages; X has no server-side search of bookmarks by media.
const PAGE_DELAY_MS = 600;
const searchPause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
// Accepts an ID, a saved file name ({mediaId}_orig.jpg) or a media URL.
export function mediaIdFrom(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return;
  const text = raw.trim();
  const fromUrl = /\/media\/([A-Za-z0-9_-]+)/.exec(text)?.[1] ?? /\/(?:ext_tw_video|amplify_video)\/(\d+)\//.exec(text)?.[1];
  const name = fromUrl ?? (text.split(/[\\/]/).pop() ?? '').replace(/[?#].*$/, '').replace(/\.[A-Za-z0-9]{2,5}$/, '').replace(/[_:]orig$/, '');
  return /^[A-Za-z0-9_-]{5,40}$/.test(name) ? name : undefined;
}
export function postUrl(postId: string): string { return `https://x.com/i/status/${postId}`; }
export class MediaSearch {
  private job?: MediaSearchJob;
  private initialized?: Promise<void>;
  private running?: Promise<void>;
  private control: Promise<unknown> = Promise.resolve();
  private async init(): Promise<void> {
    if (!this.initialized) this.initialized = (async () => {
      this.job = (await chrome.storage.local.get(SEARCH_KEY))[SEARCH_KEY] as MediaSearchJob | undefined;
      // A worker restart ends the loop; keep the cursor so the search can continue.
      if (this.job?.status === 'running' && !this.running) {
        this.job.status = 'paused'; this.job.error = '拡張機能の再起動で検索が中断されました。もう一度「検索」で続きから再開します。';
        await this.persist();
      }
    })().catch(error => { this.initialized = undefined; throw error; });
    await this.initialized;
  }
  private persist(): Promise<void> { return chrome.storage.local.set({ [SEARCH_KEY]: this.job }); }
  searching(): boolean { return !!this.running; }
  async status(): Promise<{ job?: MediaSearchJob; busy: boolean }> {
    await this.init();
    return { job: this.job, busy: !!this.running };
  }
  command(message: any): Promise<any> {
    const result = this.control.then(() => this.perform(message));
    this.control = result.catch(() => {});
    return result;
  }
  private async perform(message: any): Promise<any> {
    await this.init();
    if (message.type === 'STOP_MEDIA_SEARCH') {
      if (this.job?.status === 'running') { this.job.status = 'paused'; this.job.error = '検索を中止しました。もう一度「検索」で続きから再開します。'; await this.persist(); }
      return this.status();
    }
    if (message.type === 'OPEN_MEDIA_SEARCH_RESULT') {
      if (!this.job?.postId) throw new Error('表示できる検索結果がありません。');
      await this.open(this.job.postId);
      return this.status();
    }
    if (this.running) throw new Error('検索中です。中止してから新しく検索してください。');
    const query = mediaIdFrom(message.query);
    if (!query) throw new Error('画像の固有ID（例: GxAbCdEf123）、保存ファイル名、または画像URLを入力してください。');
    const startedAt = Date.now();
    const id = String(startedAt) + '-' + Math.random().toString(36).slice(2);
    // A post recorded at save time needs no request to X.
    const saved = await sharedHistory.postOf(query);
    if (saved) {
      this.job = { id, query, tabId: message.tabId, status: 'found', pages: 0, posts: 0, postId: saved, via: 'history', startedAt };
      await this.persist();
      await this.open(saved);
      return this.status();
    }
    const target = await directBookmarks.prepare(message.tabId);
    const old = this.job;
    const resume = old?.status === 'paused' && old.query === query && old.scope === target.scope && old.storeId === target.storeId && !!old.cursor;
    if (resume) directBookmarks.discardInitial(target.scope);
    this.job = resume ? { ...old!, status: 'running', error: undefined, tabId: message.tabId }
      : { id, query, tabId: message.tabId, status: 'running', storeId: target.storeId, scope: target.scope, pages: 0, posts: 0, startedAt };
    await this.persist();
    const job = this.job;
    this.running = this.run(job).finally(() => { this.running = undefined; });
    return this.status();
  }
  private async run(job: MediaSearchJob): Promise<void> {
    try {
      while (job.status === 'running') {
        const page = await directBookmarks.page(job.storeId!, job.scope!, job.cursor);
        job.pages++; job.posts += page.posts;
        // Index every file on the page, so a later search for another ID needs no request.
        try { await sharedHistory.rememberPosts(page.media); } catch { /* Searching continues without the index. */ }
        const hit = page.media.find(media => media.mediaId === job.query && media.postId);
        if (hit) {
          job.status = 'found'; job.postId = hit.postId; job.via = 'bookmarks'; job.error = undefined;
          await this.persist();
          await this.open(hit.postId!);
          return;
        }
        if (page.cursor && page.cursor === job.cursor) throw new Error('同じ取得位置が返されました。末尾とは判定せず停止しました。');
        if (page.ended) { job.status = 'not-found'; job.cursor = undefined; await this.persist(); return; }
        if (!page.cursor) throw new Error('次の取得位置が不明です。取得位置を保持して停止しました。');
        job.cursor = page.cursor;
        await this.persist();
        await searchPause(PAGE_DELAY_MS);
      }
    } catch (error) {
      job.status = 'paused';
      const message = errorText(error);
      job.error = /HTTP 429/.test(message) ? 'Xの取得制限に達しました。しばらく待ってから「検索」で続きから再開してください。' : message;
      try { await this.persist(); } catch { /* Shown from memory until the next write. */ }
    }
  }
  private async open(postId: string): Promise<void> {
    await chrome.windows.create({ url: postUrl(postId), type: 'popup', width: 720, height: 900, focused: true });
  }
}
