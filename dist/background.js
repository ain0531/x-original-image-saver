import { SaveJobs } from './jobs.js';
import { errorText } from './media.js';
const saves = new SaveJobs();
void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const types = ['SAVE_ALL_VISIBLE_IMAGES', 'SAVE_CURRENT_TWEET_IMAGES', 'CLEAR_SAVED_HISTORY', 'GET_SAVE_STATUS', 'PAUSE_SAVE', 'RESUME_SAVE'];
    if (!types.includes(message?.type))
        return false;
    if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('sidepanel.html')) {
        sendResponse({ ok: false, error: 'この画面からの要求は受け付けられません。' });
        return false;
    }
    const operation = message.type === 'GET_SAVE_STATUS' ? saves.status() : saves.command(message);
    void operation.then(result => sendResponse({ ok: true, ...result }), error => sendResponse({ ok: false, error: errorText(error) }));
    return true;
});
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === 'image-save-recovery')
    saves.kick(); });
void chrome.alarms.create('image-save-recovery', { periodInMinutes: 1 });
saves.kick();
