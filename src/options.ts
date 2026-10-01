import { OPTIONS_KEY, getOptions, validateOptions, downloadFileName } from './preferences.js';
const form = document.getElementById('options-form') as HTMLFormElement;
const maxPages = document.getElementById('max-pages') as HTMLInputElement;
const maxSeconds = document.getElementById('max-seconds') as HTMLInputElement;
const folder = document.getElementById('save-folder') as HTMLInputElement;
const fileName = document.getElementById('file-name') as HTMLInputElement;
const saveButton = document.getElementById('save-options') as HTMLButtonElement;
const status = document.getElementById('status')!;
const preview = document.getElementById('preview')!;
function read() { return validateOptions({ maxPages: Number(maxPages.value), maxSeconds: Number(maxSeconds.value), folder: folder.value, fileName: fileName.value }); }
function showPreview() {
  try { const options = read(); preview.textContent = `保存例：ダウンロード先 / ${downloadFileName({ mediaId: 'IMAGE123', format: 'jpg', origUrl: '' }, options)}`; }
  catch (error) { preview.textContent = error instanceof Error ? error.message : String(error); }
}
form.addEventListener('input', showPreview);
form.addEventListener('submit', event => {
  event.preventDefault(); saveButton.disabled = true;
  void (async () => {
    const options = read();
    await chrome.storage.local.set({ [OPTIONS_KEY]: options });
    folder.value = options.folder; fileName.value = options.fileName;
    showPreview(); status.textContent = '設定を保存しました。次に開始する保存処理から反映されます。';
  })().catch(error => { status.textContent = `設定を保存できません: ${error instanceof Error ? error.message : String(error)}`; })
    .finally(() => { saveButton.disabled = false; });
});
document.getElementById('open-download-settings')!.addEventListener('click', () => {
  void chrome.tabs.create({ url: 'chrome://settings/downloads' }).catch(error => { status.textContent = `設定を開けません: ${error instanceof Error ? error.message : String(error)}`; });
});
void getOptions().then(options => {
  maxPages.value = String(options.maxPages); maxSeconds.value = String(options.maxSeconds);
  folder.value = options.folder; fileName.value = options.fileName;
  for (const input of [maxPages, maxSeconds, folder, fileName]) input.disabled = false;
  saveButton.disabled = false; showPreview(); status.textContent = '';
}).catch(error => { status.textContent = `設定を読み込めません: ${error instanceof Error ? error.message : String(error)}`; });
