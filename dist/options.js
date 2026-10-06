import { OPTIONS_KEY, getOptions, validateOptions, downloadFileName } from './preferences.js';
const versionElement = document.getElementById('version');
if (versionElement)
    versionElement.textContent = `バージョン ${chrome.runtime.getManifest?.()?.version ?? ''}`;
const form = document.getElementById('options-form');
const maxPages = document.getElementById('max-pages');
const maxSeconds = document.getElementById('max-seconds');
const folder = document.getElementById('save-folder');
const fileName = document.getElementById('file-name');
const saveButton = document.getElementById('save-options');
const status = document.getElementById('status');
const preview = document.getElementById('preview');
function read() { return validateOptions({ maxPages: Number(maxPages.value), maxSeconds: Number(maxSeconds.value), folder: folder.value, fileName: fileName.value }); }
function showPreview() {
    try {
        const options = read();
        preview.textContent = `画像：ダウンロード先 / ${downloadFileName({ mediaId: 'IMAGE123', format: 'jpg', origUrl: '' }, options)}\n動画：ダウンロード先 / ${downloadFileName({ kind: 'video', mediaId: '1234567890', format: 'mp4', origUrl: '' }, options)}`;
    }
    catch (error) {
        preview.textContent = error instanceof Error ? error.message : String(error);
    }
}
form.addEventListener('input', showPreview);
form.addEventListener('submit', event => {
    event.preventDefault();
    saveButton.disabled = true;
    void (async () => {
        const options = read();
        await chrome.storage.local.set({ [OPTIONS_KEY]: options });
        folder.value = options.folder;
        fileName.value = options.fileName;
        showPreview();
        status.textContent = '設定を保存しました。次に開始する保存処理から反映されます。';
    })().catch(error => { status.textContent = `設定を保存できません: ${error instanceof Error ? error.message : String(error)}`; })
        .finally(() => { saveButton.disabled = false; });
});
document.getElementById('open-download-settings').addEventListener('click', () => {
    void chrome.tabs.create({ url: 'chrome://settings/downloads' }).catch(error => { status.textContent = `設定を開けません: ${error instanceof Error ? error.message : String(error)}`; });
});
void getOptions().then(options => {
    maxPages.value = String(options.maxPages);
    maxSeconds.value = String(options.maxSeconds);
    folder.value = options.folder;
    fileName.value = options.fileName;
    for (const input of [maxPages, maxSeconds, folder, fileName])
        input.disabled = false;
    saveButton.disabled = false;
    showPreview();
    status.textContent = '';
}).catch(error => { status.textContent = `設定を読み込めません: ${error instanceof Error ? error.message : String(error)}`; });
