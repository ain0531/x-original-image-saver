const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { harness, page, flush } = require('./harness.cjs');
const defaults = { maxPages: 20, maxSeconds: 30, folder: '', fileName: '{mediaId}_orig.{format}' };
test('options preserve old limits and reject absolute paths and traversal', async () => {
  const h = harness({ allVisibleScrollSettings: { maxRounds: 7, maxElapsedSeconds: 40 } });
  const options = await h.context.getOptions();
  assert.equal(options.maxPages, 7); assert.equal(options.maxSeconds, 40);
  assert.equal(h.context.validateOptions({ ...defaults, folder: 'X画像\\ブックマーク' }).folder, 'X画像/ブックマーク');
  for (const folder of ['C:\\Users\\user', '../画像', '/画像', '画像/../外', '画像//投稿', 'CON']) assert.throws(() => h.context.validateOptions({ ...defaults, folder }));
  for (const fileName of ['../{mediaId}.{format}', '画像.jpg', '{unknown}_{mediaId}.{format}', '{mediaId}:orig.{format}']) assert.throws(() => h.context.validateOptions({ ...defaults, fileName }));
});
test('saved options control batch page limits and real download filenames', async () => {
  const h = harness({ imageSaverOptions: { ...defaults, maxPages: 1, folder: 'X画像/ブックマーク', fileName: 'X_{mediaId}.{format}' } });
  h.available = true; h.pages.push(page(['A'], 'next'));
  await h.request({ type: 'SAVE_ALL_VISIBLE_IMAGES', tabId: 1 });
  const result = await h.done();
  assert.equal(result.job.endedBy, 'max-rounds'); assert.equal(result.job.settings.maxRounds, 1);
  assert.equal(h.calls[0].filename, 'X画像/ブックマーク/X_A.jpg');
  h.store.imageSaverOptions = { ...defaults, folder: '変更後' };
  h.pages.push(page(['B']));
  await h.request({ type: 'RESUME_SAVE' }); await h.done();
  assert.equal(h.calls[1].filename, 'X画像/ブックマーク/X_B.jpg');
});
test('current post uses configured files and shows Save As only when explicitly requested', async () => {
  for (const saveAs of [undefined, false, true]) {
    const h = harness({ imageSaverOptions: { ...defaults, folder: 'X画像', fileName: '{mediaId}_保存.{format}' } });
    h.snap.urls = ['https://pbs.twimg.com/media/A.jpg'];
    await h.request({ type: 'SAVE_CURRENT_TWEET_IMAGES', tabId: 1, saveAs }); await h.done();
    assert.equal(h.calls[0].filename, 'X画像/A_保存.jpg'); assert.equal(h.calls[0].saveAs, saveAs === true);
    assert.equal(h.store.imageSaveJob.saveAs, saveAs === true);
  }
});
test('options form loads, validates and persists the settings', async () => {
  const h = harness(); const elements = new Map();
  h.context.document = { getElementById: id => {
    if (!elements.has(id)) elements.set(id, { value: '', disabled: true, textContent: '', listeners: {}, addEventListener(type, listener) { this.listeners[type] = listener; } });
    return elements.get(id);
  } };
  vm.runInContext(fs.readFileSync('dist/options.js', 'utf8').replace(/^import .*;\s*$/mg, ''), h.context);
  await flush(); assert.equal(elements.get('max-pages').value, '20'); assert.equal(elements.get('save-options').disabled, false);
  elements.get('max-pages').value = '3'; elements.get('save-folder').value = '画像';
  elements.get('options-form').listeners.submit({ preventDefault() {} }); await flush();
  assert.equal(h.store.imageSaverOptions.folder, '画像'); assert.equal(h.store.imageSaverOptions.maxPages, 3);
  assert.match(elements.get('status').textContent, /設定を保存しました/);
  elements.get('save-folder').value = '../外';
  elements.get('options-form').listeners.submit({ preventDefault() {} }); await flush();
  assert.match(elements.get('status').textContent, /設定を保存できません/); assert.equal(h.store.imageSaverOptions.folder, '画像');
});
