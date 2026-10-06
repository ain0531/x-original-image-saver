// Unread-only filter state. Session storage is cleared when the extension or browser restarts.
export const READ_POSTS_KEY = 'unreadFilter';
const MAX_READ_POSTS = 100000;
type ReadPostsState = { enabled: boolean; ids: string[] };
export class ReadPosts {
  private chain: Promise<unknown> = Promise.resolve();
  private run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.chain.catch(() => {}).then(task);
    this.chain = next;
    return next;
  }
  private async load(): Promise<ReadPostsState> {
    const stored = (await chrome.storage.session.get(READ_POSTS_KEY))[READ_POSTS_KEY] as Partial<ReadPostsState> | undefined;
    return { enabled: stored?.enabled === true, ids: Array.isArray(stored?.ids) ? stored!.ids.filter(id => typeof id === 'string') : [] };
  }
  state(): Promise<ReadPostsState> { return this.run(() => this.load()); }
  setEnabled(enabled: boolean): Promise<ReadPostsState> {
    return this.run(async () => {
      const state = { ...await this.load(), enabled };
      await chrome.storage.session.set({ [READ_POSTS_KEY]: state });
      return state;
    });
  }
  // Records only while the filter is on. Returns the IDs that were newly added.
  mark(postIds: string[]): Promise<string[]> {
    return this.run(async () => {
      const state = await this.load();
      if (!state.enabled) return [];
      const known = new Set(state.ids);
      const added = [...new Set(postIds)].filter(id => !known.has(id));
      if (!added.length) return [];
      const ids = [...state.ids, ...added].slice(-MAX_READ_POSTS);
      await chrome.storage.session.set({ [READ_POSTS_KEY]: { enabled: true, ids } });
      return added;
    });
  }
}
