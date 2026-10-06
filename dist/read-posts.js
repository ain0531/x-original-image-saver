// Unread-only filter state. Session storage is cleared when the extension or browser restarts.
export const READ_POSTS_KEY = 'unreadFilter';
const MAX_READ_POSTS = 100000;
export class ReadPosts {
    constructor() {
        this.chain = Promise.resolve();
    }
    run(task) {
        const next = this.chain.catch(() => { }).then(task);
        this.chain = next;
        return next;
    }
    async load() {
        const stored = (await chrome.storage.session.get(READ_POSTS_KEY))[READ_POSTS_KEY];
        return { enabled: stored?.enabled === true, ids: Array.isArray(stored?.ids) ? stored.ids.filter(id => typeof id === 'string') : [] };
    }
    state() { return this.run(() => this.load()); }
    setEnabled(enabled) {
        return this.run(async () => {
            const state = { ...await this.load(), enabled };
            await chrome.storage.session.set({ [READ_POSTS_KEY]: state });
            return state;
        });
    }
    // Records only while the filter is on. Returns the IDs that were newly added.
    mark(postIds) {
        return this.run(async () => {
            const state = await this.load();
            if (!state.enabled)
                return [];
            const known = new Set(state.ids);
            const added = [...new Set(postIds)].filter(id => !known.has(id));
            if (!added.length)
                return [];
            const ids = [...state.ids, ...added].slice(-MAX_READ_POSTS);
            await chrome.storage.session.set({ [READ_POSTS_KEY]: { enabled: true, ids } });
            return added;
        });
    }
}
