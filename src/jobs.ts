import { Media, errorText, isOriginalDownload, isXPage } from './media.js';
import { ImageHistory } from './history.js';
import { snapshot, network, domPage, assertBookmarkScope } from './sources.js';
import { directBookmarks } from './direct-bookmarks.js';
import { DEFAULT_OPTIONS, getOptions, downloadFileName } from './preferences.js';
export type Settings = { scrollRatio: number; waitMsPerRound: number; stableRoundsNeeded: number; maxRounds: number; maxElapsedMs: number };
export type Task = { media: Media; state: 'pending' | 'starting' | 'downloading' | 'saved' | 'skipped' | 'failed'; downloadId?: number; startedAt?: number; error?: string };
export type Job = { id: string; tabId: number; url: string; scope: string; documentId: number; source: 'direct' | 'network' | 'loaded' | 'current'; status: 'running' | 'paused' | 'done' | 'review'; cursor?: string; rounds: number; sourceDone: boolean; endedBy: string; issues: string[]; skip: boolean; settings: Settings; domCheckpoint?: string; stable: number; folder?: string; fileName?: string; postId?: string; saveAs?: boolean; background?: boolean; cookieStoreId?: string };
const JOB_KEY = 'imageSaveJob';
const TASK_PREFIX = 'imageSaveTask:';
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
export function settings(raw: any): Settings {
  const positive = (n: unknown, fallback: number, max: number) => typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.min(n, max) : fallback;
  return { scrollRatio: positive(raw?.scrollRatio, .8, 1), waitMsPerRound: positive(raw?.waitMsPerRound, 700, 10000), stableRoundsNeeded: Math.floor(positive(raw?.stableRoundsNeeded, 3, 100)), maxRounds: Math.floor(positive(raw?.maxRounds, 20, 1000)), maxElapsedMs: positive(raw?.maxElapsedMs, 30000, 300000) };
}
export class SaveJobs {
  readonly history = new ImageHistory();
  private job?: Job;
  private tasks = new Map<string, Task>();
  private initialized?: Promise<void>;
  private running?: Promise<void>;
  private writes: Promise<void> = Promise.resolve();
  private control: Promise<unknown> = Promise.resolve();
  private async init(): Promise<void> {
    if (!this.initialized) this.initialized = (async () => {
      const stored = await chrome.storage.local.get(null);
      this.job = stored[JOB_KEY] as Job | undefined;
      if (this.job) for (const [key, task] of Object.entries(stored)) if (key.startsWith(TASK_PREFIX + this.job.id + ':')) this.tasks.set((task as Task).media.mediaId, task as Task);
    })().catch(error => { this.initialized = undefined; throw error; });
    await this.initialized;
  }
  private persist(): Promise<void> {
    const write = this.writes.then(() => chrome.storage.local.set({ [JOB_KEY]: this.job }));
    this.writes = write.catch(() => {});
    return write;
  }
  private key(id: string): string { return TASK_PREFIX + this.job!.id + ':' + id; }
  private async taskWrite(task: Task): Promise<void> { await chrome.storage.local.set({ [this.key(task.media.mediaId)]: task }); }
  async status(): Promise<any> {
    await this.init();
    const stats = { total: this.tasks.size, success: 0, skipped: 0, failed: 0, pending: 0 };
    const failures: string[] = [];
    for (const task of this.tasks.values()) {
      if (task.state === 'saved') stats.success++;
      else if (task.state === 'skipped') stats.skipped++;
      else if (task.state === 'failed') { stats.failed++; failures.push(`${task.media.mediaId}: ${task.error}`); }
      else stats.pending++;
    }
    return { job: this.job, stats, failures, busy: !!this.running };
  }
  // A single control queue covers multiple windows and prevents stale starts.
  command(message: any): Promise<any> {
    const result = this.control.then(() => this.perform(message));
    this.control = result.catch(() => {});
    return result;
  }
  private async perform(message: any): Promise<any> {
    await this.init();
    if (this.running && !this.job) await this.running;
    if (message.type === 'PAUSE_SAVE') {
      if (this.job?.status === 'running') { this.job.status = 'paused'; this.job.endedBy = 'user-paused'; await this.persist(); }
      return this.status();
    }
    if (message.type === 'RESUME_SAVE') {
      if (!this.job) throw new Error('再開できる処理がありません。');
      if (this.job.status === 'running' || this.running) throw new Error('処理中です。停止処理が完了してから再開してください。');
      this.job.skip = true;
      if (this.job.source === 'direct') await directBookmarks.check(this.job.cookieStoreId!, this.job.scope);
      else {
        const tab = await chrome.tabs.get(this.job.tabId);
        if (tab.url !== this.job.url) throw new Error('保存を開始したXのページを開いてください。');
        const snap = await snapshot(this.job.tabId, this.job.source === 'current', this.job.postId);
        if (this.job.source !== 'current') assertBookmarkScope(snap.pageUrl, snap.scope);
        if (snap.scope !== this.job.scope) throw new Error('ページ・選択タブ・アカウントが変わりました。元の対象に戻してください。');
      }
      for (const task of this.tasks.values()) if (task.state === 'failed') { task.state = task.downloadId ? 'downloading' : 'pending'; task.error = undefined; await this.taskWrite(task); }
      if (this.job.endedBy !== 'timeline-end' && ['network', 'direct'].includes(this.job.source)) this.job.sourceDone = false;
      this.job.rounds = 0; this.job.status = 'running'; this.job.endedBy = ''; await this.persist();
      this.kick(); return this.status();
    }
    if (message.type === 'CLEAR_SAVED_HISTORY') {
      if (this.running || this.job?.status === 'running') throw new Error('保存を停止してから履歴を消去してください。');
      return { removed: await this.history.clear() };
    }
    if (this.running || this.job?.status === 'running') throw new Error('保存処理中です。一時停止してから開始してください。');
    if (!Number.isInteger(message.tabId) || message.tabId < 0) throw new Error('無効なタブです。');
    const tab = await chrome.tabs.get(message.tabId);
    const current = message.type === 'SAVE_CURRENT_TWEET_IMAGES';
    if (current && !isXPage(tab.url ?? '')) throw new Error('Xのページを開いてください。');
    const preferences = await getOptions();
    const target = current ? undefined : await directBookmarks.prepare(message.tabId);
    const tabId = message.tabId;
    const snap = target ? { pageUrl: 'https://x.com/i/bookmarks', scope: target.scope, documentId: 0, urls: [], posts: [], issues: [], loading: false, bottom: false, y: 0 } : await snapshot(tabId, true);
    if (!current) assertBookmarkScope(snap.pageUrl, snap.scope);
    if (current && snap.pageUrl !== tab.url) throw new Error('ページが変わりました。もう一度開始してください。');
    // Never drop unfinished work when starting from a new head/current position.
    const pending = [...this.tasks.values()].filter(task => !['saved', 'skipped'].includes(task.state));
    if (!current && this.job?.source === 'current' && pending.length) throw new Error('個別保存の未処理画像があります。先にその保存処理を再開して完了してください。');
    if (this.job && this.job.scope !== snap.scope && pending.length) throw new Error('別の対象に未処理画像があります。元のページで再開して保存を終えてください。');
    const stored = await chrome.storage.local.get(null);
    const oldKeys = Object.keys(stored).filter(key => key.startsWith(TASK_PREFIX));
    const job: Job = { id: String(Date.now()) + '-' + Math.random().toString(36).slice(2), tabId, url: snap.pageUrl, scope: snap.scope, documentId: snap.documentId, background: !current, cookieStoreId: target?.storeId,
      source: current ? 'current' : 'direct', status: 'running', rounds: 0, sourceDone: false, endedBy: '', issues: this.job?.scope === snap.scope ? this.job.issues.filter(issue => !issue.startsWith('ブックマークの通信')) : [], skip: true, settings: settings(message.scrollSettings ?? { maxRounds: preferences.maxPages, maxElapsedMs: preferences.maxSeconds * 1000 }), stable: 0, folder: preferences.folder, fileName: preferences.fileName, saveAs: current };
    // Save the new job and carried queue before removing the old queue.
    const carried: Record<string, unknown> = { [JOB_KEY]: job };
    for (const task of pending) carried[TASK_PREFIX + job.id + ':' + task.media.mediaId] = { ...task, state: task.state === 'failed' ? (task.downloadId ? 'downloading' : 'pending') : task.state, error: undefined };
    await chrome.storage.local.set(carried);
    this.job = job; this.tasks = new Map(pending.map(task => [task.media.mediaId, carried[TASK_PREFIX + job.id + ':' + task.media.mediaId] as Task]));
    if (oldKeys.length) await chrome.storage.local.remove(oldKeys);
    // Native bookmark responses are authoritative; do not mix visible recommendations in.
    if (current) await this.enqueue(domPage(snap));
    if (current) { job.sourceDone = !snap.loading && !snap.issues.length; job.endedBy = 'current-post'; await this.persist(); }
    else if (job.source === 'loaded') { job.sourceDone = !snap.loading && !snap.issues.length; job.endedBy = 'loaded-only'; job.issues.push('ブックマークの通信を確認できないため、読み込み済みの画像のみが対象です。拡張機能を再読み込みし、Xのブックマーク画面も再読み込みして再試行してください。自動スクロールは行いません。'); await this.persist(); }
    this.kick(); return this.status();
  }
  private async enqueue(page: { media: Media[]; issues: string[]; verifiedPostIds?: string[] }): Promise<void> {
    const additions = page.media.filter(media => !this.tasks.has(media.mediaId));
    const confirmed = this.job!.skip ? await this.history.confirmedMany(additions) : new Map();
    const rows: Record<string, Task> = {};
    for (const media of additions) {
      const task: Task = { media, state: confirmed.get(media.mediaId) != null ? 'skipped' : 'pending' };
      rows[this.key(media.mediaId)] = task;
    }
    if (Object.keys(rows).length) await chrome.storage.local.set(rows);
    for (const task of Object.values(rows)) this.tasks.set(task.media.mediaId, task);
    this.job!.issues = this.job!.issues.filter(issue => !(page.verifiedPostIds ?? []).some(id => issue.startsWith(`投稿 ${id}:`) && /全画像|読み込まれていない画像|非表示の画像/.test(issue)));
    for (const issue of page.issues) if (!this.job!.issues.includes(issue)) this.job!.issues.push(issue);
    await this.persist();
  }
  kick(): void {
    if (this.running) return;
    this.running = this.run().catch(async error => {
      if (this.job) { this.job.status = 'paused'; this.job.endedBy = errorText(error); try { await this.persist(); } catch { /* Retry persistence on the next wake. */ } }
    }).finally(() => { this.running = undefined; });
  }
  private async run(): Promise<void> {
    await this.init();
    const job = this.job;
    if (!job || job.status !== 'running') return;
    if (job.source !== 'current') assertBookmarkScope(job.url, job.scope);
    if (job.source === 'direct') await directBookmarks.check(job.cookieStoreId!, job.scope);
    // Downloads are processed while the next page is collected, at most four.
    let collecting = true;
    const workers = Array.from({ length: job.source === 'current' ? 1 : 4 }, () => (async () => {
      while (job.status === 'running') {
        const task = [...this.tasks.values()].find(task => ['pending', 'starting', 'downloading'].includes(task.state) && !active.has(task.media.mediaId));
        if (!task) { if (!collecting) break; await delay(100); continue; }
        active.add(task.media.mediaId);
        try { await this.transfer(task); }
        catch (error) { job.status = 'paused'; job.endedBy = errorText(error); }
        finally { active.delete(task.media.mediaId); }
      }
    })());
    const startedAt = Date.now();
    let sourceError: unknown;
    try {
      while (job.status === 'running' && !job.sourceDone) {
        if (job.rounds >= job.settings.maxRounds || Date.now() - startedAt >= job.settings.maxElapsedMs) {
          job.sourceDone = true; job.endedBy = job.rounds >= job.settings.maxRounds ? 'max-rounds' : 'max-time'; await this.persist(); break;
        }
        // Bound the durable queue as well as the transfer concurrency.
        if ([...this.tasks.values()].filter(t => ['pending', 'starting', 'downloading'].includes(t.state)).length > 48) { await delay(100); continue; }
        if (job.source === 'network' || job.source === 'direct') {
          const page = job.source === 'direct' ? await directBookmarks.page(job.cookieStoreId!, job.scope, job.cursor) : await (async () => {
            const result = await network(job.tabId, 'page', job.cursor, job.scope);
            if (!result.available || !result.page) throw new Error('ブックマークの通信を確認できません。対象ページを再読み込みして再開してください。');
            return result.page;
          })();
          await this.enqueue(page); // Durable image queue first, cursor second.
          if (page.cursor && page.cursor === job.cursor) throw new Error('同じ取得位置が返されました。末尾とは判定せず停止しました。');
          job.cursor = page.cursor; job.rounds++;
          if (page.ended) { job.sourceDone = true; job.endedBy = 'timeline-end'; }
          else if (!page.cursor) throw new Error('次の取得位置が不明です。未処理画像を保持して停止しました。');
          await this.persist();
        } else {
          const started = Date.now();
          let missing = job.issues.filter(issue => issue.includes('読み込まれていない画像') || issue.includes('非表示の画像'));
          while (job.status === 'running') {
            const snap = await snapshot(job.tabId, job.source === 'current', job.postId);
            if (snap.scope !== job.scope || snap.documentId !== job.documentId) throw new Error('画像の読み込み中にページ・アカウントが変わりました。');
            await this.enqueue(domPage(snap));
            // A transient lazy-image warning disappears only after re-reading its slot.
            job.issues = job.issues.filter(issue => !missing.includes(issue) || snap.issues.includes(issue));
            missing = snap.issues;
            if (!snap.loading && !snap.issues.length) { job.sourceDone = true; break; }
            if (Date.now() - started >= Math.max(3000, job.settings.waitMsPerRound)) throw new Error('読み込み途中の画像があります。スクロールせずに未解決として停止しました。');
            await delay(100);
          }
          await this.persist();
        }
      }
    } catch (error) { sourceError = error; job.sourceDone = true; job.endedBy = errorText(error); }
    finally { collecting = false; }
    await Promise.all(workers);
    if (sourceError) { job.status = 'paused'; }
    else if (job.status === 'running') {
      job.status = job.endedBy === 'timeline-end' || job.source === 'current' ? (job.issues.length || [...this.tasks.values()].some(t => t.state === 'failed') ? 'review' : 'done') : 'review';
    }
    await this.persist();
  }
  private async transfer(task: Task): Promise<void> {
    if (!task.downloadId && ['pending', 'starting'].includes(task.state) && this.job!.skip) {
      const confirmed = await this.history.confirmedMany([task.media]);
      if (confirmed.get(task.media.mediaId) != null) { task.state = 'skipped'; await this.taskWrite(task); return; }
    }
    if (task.state === 'starting' && !task.downloadId) {
      // Recover the small download()/persist gap only when exactly one match is proven.
      const matches = await chrome.downloads.search({ url: task.media.origUrl, startedAfter: new Date(task.startedAt!).toISOString() });
      if (matches.length === 1) task.downloadId = matches[0].id;
    }
    if (!task.downloadId) {
      task.state = 'starting'; task.startedAt = Date.now(); await this.taskWrite(task);
      try { task.downloadId = await chrome.downloads.download({ url: task.media.origUrl, filename: downloadFileName(task.media, { folder: this.job!.folder ?? '', fileName: this.job!.fileName ?? DEFAULT_OPTIONS.fileName }), conflictAction: 'uniquify', saveAs: this.job!.saveAs ?? this.job!.source === 'current' }); }
      catch (error) { task.state = 'failed'; task.error = errorText(error); await this.taskWrite(task); return; }
      task.state = 'downloading'; await this.taskWrite(task);
    }
    const deadline = Date.now() + 120000;
    while (true) {
      // A monitoring failure retains the ID, rather than starting a second transfer.
      const [item] = await chrome.downloads.search({ id: task.downloadId });
      if (!item || item.state === 'interrupted') {
        task.state = 'failed'; task.error = item?.error ?? 'ダウンロードの状態を確認できません。'; task.downloadId = undefined; await this.taskWrite(task); return;
      }
      if (item.state === 'complete') {
        if (!isOriginalDownload(item, task.media.mediaId)) { task.state = 'failed'; task.error = '原寸画像・ファイル存在・画像形式を確認できません。'; task.downloadId = undefined; await this.taskWrite(task); return; }
        // History write failure keeps the complete ID, so retry only the record.
        await this.history.record(task.media, task.downloadId!);
        task.state = 'saved'; task.error = undefined; await this.taskWrite(task); return;
      }
      if (Date.now() >= deadline) {
        await chrome.downloads.cancel(task.downloadId!);
        const [after] = await chrome.downloads.search({ id: task.downloadId });
        if (after?.state === 'complete') continue;
        if (after?.state !== 'interrupted') throw new Error('転送の停止を確認できません。ダウンロードIDを保持しました。');
        task.state = 'failed'; task.error = '原寸画像の転送が時間切れになりました。'; task.downloadId = undefined; await this.taskWrite(task); return;
      }
      await delay(1000);
    }
  }
}
// Shared by the four workers, reserved before the first asynchronous call.
const active = new Set<string>();
