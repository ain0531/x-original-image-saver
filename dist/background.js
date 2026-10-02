import { SaveJobs, PostSaveQueue } from './jobs.js';
import { errorText, isXPage } from './media.js';
const saves = new SaveJobs();
const localSaves = new PostSaveQueue();
void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (['LOCAL_SAVE_POST', 'GET_LOCAL_SAVE_STATUS'].includes(message?.type)) {
        const trustedPost = sender.id === chrome.runtime.id && sender.frameId === 0 && Number.isInteger(sender.tab?.id) && isXPage(sender.url ?? '') && isXPage(sender.tab?.url ?? '');
        if (!trustedPost || typeof message.postId !== 'string' || !/^\d+$/.test(message.postId)) {
            sendResponse({ ok: false, error: 'この投稿からの保存要求は受け付けられません。' });
            return false;
        }
        const operation = message.type === 'LOCAL_SAVE_POST'
            ? localSaves.accept(sender.tab.id, message.postId)
            : localSaves.status(sender.tab.id, message.postId, message.jobId);
        void operation.then(result => sendResponse({ ok: true, ...result }), error => sendResponse({ ok: false, error: errorText(error) }));
        return true;
    }
    const types = ['SAVE_ALL_VISIBLE_IMAGES', 'SAVE_CURRENT_TWEET_IMAGES', 'CLEAR_SAVED_HISTORY', 'GET_SAVE_STATUS', 'PAUSE_SAVE', 'RESUME_SAVE'];
    if (!types.includes(message?.type))
        return false;
    const trustedPanel = sender.id === chrome.runtime.id && sender.url === chrome.runtime.getURL('sidepanel.html');
    if (!trustedPanel) {
        sendResponse({ ok: false, error: 'この画面からの要求は受け付けられません。' });
        return false;
    }
    const operation = (async () => {
        if (message.type === 'GET_SAVE_STATUS')
            return { ...await saves.status(), localQueue: await localSaves.summary() };
        if (message.type === 'CLEAR_SAVED_HISTORY' && (await localSaves.summary()).pending)
            throw new Error('ローカル保存の予約が完了してから履歴を消去してください。');
        return saves.command(message);
    })();
    void operation.then(result => sendResponse({ ok: true, ...result }), error => sendResponse({ ok: false, error: errorText(error) }));
    return true;
});
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === 'image-save-recovery') {
    saves.kick();
    localSaves.kick();
} });
void chrome.alarms.create('image-save-recovery', { periodInMinutes: 1 });
saves.kick();
localSaves.kick();
