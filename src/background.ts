import { SaveJobs, PostSaveQueue } from './jobs.js';
import { errorText, isXPage } from './media.js';
import { ReadPosts } from './read-posts.js';
import { BookmarkFolders } from './bookmark-folders.js';
const saves = new SaveJobs();
const localSaves = new PostSaveQueue();
const readPosts = new ReadPosts();
const bookmarkFolders = new BookmarkFolders();
void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);
async function broadcastToXTabs(message: unknown, exceptTabId?: number): Promise<void> {
  const tabs = await chrome.tabs.query({ url: ['https://x.com/*', 'https://twitter.com/*'] });
  await Promise.all(tabs.filter(tab => tab.id !== undefined && tab.id !== exceptTabId)
    .map(tab => chrome.tabs.sendMessage(tab.id!, message, { frameId: 0 }).catch(() => {})));
}
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const trustedPost = sender.id === chrome.runtime.id && sender.frameId === 0 && Number.isInteger(sender.tab?.id) && isXPage(sender.url ?? '') && isXPage(sender.tab?.url ?? '');
  const trustedPanel = sender.id === chrome.runtime.id && sender.url === chrome.runtime.getURL('sidepanel.html');
  const trustedOptions = sender.id === chrome.runtime.id && sender.url === chrome.runtime.getURL('options.html');
  if (['LIST_BOOKMARK_FOLDERS', 'SET_BOOKMARK_FOLDER', 'CLEAR_BOOKMARK_FOLDERS', 'SPECIAL_SAVE_FOLDER'].includes(message?.type)) {
    const post = message.type === 'SPECIAL_SAVE_FOLDER';
    const allowed = post ? trustedPost && typeof message.postId === 'string' && /^\d+$/.test(message.postId)
      : trustedOptions && (message.type === 'CLEAR_BOOKMARK_FOLDERS' || Number.isInteger(message.tabId) && message.tabId >= 0 && (message.type !== 'SET_BOOKMARK_FOLDER' || typeof message.account === 'string' && typeof message.folderId === 'string' && /^(?:\d+)?$/.test(message.folderId)));
    if (!allowed) { sendResponse({ ok: false, error: 'この画面からの要求は受け付けられません。' }); return false; }
    const operation = message.type === 'CLEAR_BOOKMARK_FOLDERS' ? bookmarkFolders.clear() : post ? bookmarkFolders.add(sender.tab!.id!, message.postId)
      : message.type === 'LIST_BOOKMARK_FOLDERS' ? bookmarkFolders.list(message.tabId)
      : bookmarkFolders.select(message.tabId, message.account, message.folderId);
    void operation.then(result => sendResponse({ ok: true, ...result }), error => sendResponse({ ok: false, error: errorText(error) }));
    return true;
  }
  if (['GET_UNREAD_FILTER', 'SET_UNREAD_FILTER', 'MARK_POSTS_READ'].includes(message?.type)) {
    const allowed = message.type === 'SET_UNREAD_FILTER' ? trustedPanel && typeof message.enabled === 'boolean'
      : message.type === 'GET_UNREAD_FILTER' ? trustedPanel || trustedPost
      : trustedPost && Array.isArray(message.postIds) && message.postIds.length <= 1000 && message.postIds.every((id: unknown) => typeof id === 'string' && /^\d+$/.test(id));
    if (!allowed) { sendResponse({ ok: false, error: 'この画面からの要求は受け付けられません。' }); return false; }
    const operation = (async () => {
      if (message.type === 'GET_UNREAD_FILTER') return readPosts.state();
      if (message.type === 'SET_UNREAD_FILTER') {
        const { enabled } = await readPosts.setEnabled(message.enabled);
        await broadcastToXTabs({ type: 'UNREAD_FILTER_STATE', enabled });
        return { enabled };
      }
      const added = await readPosts.mark(message.postIds);
      if (added.length) await broadcastToXTabs({ type: 'UNREAD_FILTER_READ', postIds: added }, sender.tab!.id!);
      return { added: added.length };
    })();
    void operation.then(result => sendResponse({ ok: true, ...result }), error => sendResponse({ ok: false, error: errorText(error) }));
    return true;
  }
  if (['LOCAL_SAVE_POST', 'GET_LOCAL_SAVE_STATUS'].includes(message?.type)) {
    if (!trustedPost || typeof message.postId !== 'string' || !/^\d+$/.test(message.postId)) {
      sendResponse({ ok: false, error: 'この投稿からの保存要求は受け付けられません。' }); return false;
    }
    const operation = message.type === 'LOCAL_SAVE_POST'
      ? localSaves.accept(sender.tab!.id!, message.postId)
      : localSaves.status(sender.tab!.id!, message.postId, message.jobId);
    void operation.then(result => sendResponse({ ok: true, ...result }), error => sendResponse({ ok: false, error: errorText(error) }));
    return true;
  }
  const types = ['SAVE_ALL_VISIBLE_IMAGES', 'SAVE_ACCOUNT_MEDIA', 'SAVE_CURRENT_TWEET_IMAGES', 'CLEAR_SAVED_HISTORY', 'GET_SAVE_STATUS', 'PAUSE_SAVE', 'RESUME_SAVE'];
  if (!types.includes(message?.type)) return false;
  if (!trustedPanel) {
    sendResponse({ ok: false, error: 'この画面からの要求は受け付けられません。' }); return false;
  }
  const operation = (async () => {
    if (message.type === 'GET_SAVE_STATUS') return { ...await saves.status(), localQueue: await localSaves.summary() };
    if (message.type === 'CLEAR_SAVED_HISTORY' && (await localSaves.summary()).pending) throw new Error('ローカル保存の予約が完了してから履歴を消去してください。');
    return saves.command(message);
  })();
  void operation.then(result => sendResponse({ ok: true, ...result }), error => sendResponse({ ok: false, error: errorText(error) }));
  return true;
});
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === 'image-save-recovery') { saves.kick(); localSaves.kick(); } });
void chrome.alarms.create('image-save-recovery', { periodInMinutes: 1 });
saves.kick();
localSaves.kick();
