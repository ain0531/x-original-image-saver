# X Original Image Saver

Chrome Manifest V3 extension. Requires Chrome 116 or later.
Click the toolbar icon to open the side panel.

## Build and update

```sh
npm ci
npm test
```

Load this folder with **Load unpacked** in `chrome://extensions`.
After an update, **reload the extension, reload the X bookmarks page, and reopen
the side panel**. The page reload installs the new request observer before X
makes its own bookmark requests.

## Saving without scrolling

While the extension is enabled, posts in the main X timeline receive a
**特別保存** button in each post's bottom action row. Clicking it adds a like and
a bookmark through X's own controls, preserving either if already active. It
does not download images. The button shows **特別保存済み** only after both states
are confirmed; failures appear beside it and can be retried. Clicking again does
not remove likes or bookmarks. Newly loaded posts receive buttons too. Reload X after
installing, updating or enabling the extension to install the content script.

Open **オプション** in the side panel to configure acquisition limits, a subfolder
under Chrome's Downloads directory, and a filename pattern. Defaults remain 20
pages, 30 seconds, no subfolder, and `{mediaId}_orig.{format}`. Saved settings
apply to new jobs; resumed jobs retain their initial settings. Existing limit
settings are read during migration. The options page also opens Chrome's download
settings to change the base folder. Absolute paths are not accepted by the
extension. Saving to a different folder does not reset duplicate history.

**画像をまとめて保存** never scrolls the page or resets its scroll position.
The panel explicitly reports which of these two routes ran:

- **Bookmark post data**: reuses the bookmark GET request observed from the
  logged-in X page. Fetches subsequent pages with the cursor returned by X,
  without rendering posts or waiting for image pixels to load. Native operation
  IDs, variables and features are retained; authentication headers stay in page
  memory and are never stored in extension storage or returned to the panel.
- **Loaded images only**: if no valid bookmark request was observed, saves only
  images in the main post column plus complete attachment lists observed in X's
  own GraphQL responses for those post IDs. It reports a limited
  range, rather than claiming the entire bookmark collection was saved. It does
  not silently switch to a scrolling scan.

The native bookmark endpoint and response format can change. Unrecognized
responses, HTTP errors and repeated cursors stop acquisition explicitly; the
already discovered images and last acknowledged cursor remain available.
Switching the selected history tab, account or page invalidates the request.

At most four original images download concurrently, while acquisition continues.
The batch save has no confirmation popup and uses `saveAs: false`. Chrome's
own "Ask where to save each file" preference may still cause save dialogs.
**現在の投稿の画像を保存** keeps its Save As behavior and selects the actual
post by timestamp permalink, or the first post intersecting the viewport.
Full attachment lists from native post data also supply photos not rendered by
a carousel. A partial single-photo entity list is flagged as unverified.
Only post images (`currentSrc`, with `src` fallback) are collected from the main
column; avatars, navigation and recommendation images are excluded.

## History, limits and recovery

- Only `name=orig` is downloaded. A failed original is reported as failed;
  resized `large` images are never substituted or marked as saved originals.
- The media ID is the identity across URL sizes/formats. There is one saved
  history, with individual records written after Chrome confirms an original
  image transfer is complete and the file exists.
- Saved history **still expires after 180 days**. Existing timestamps are
  preserved during migration. Older records of uncertain quality are checked
  against Chrome Downloads; missing, deleted, ambiguous or unreadable evidence
  causes a download, following the fail-safe rule.
- Acquisition stops at the configured page/time limit. This is a partial result,
  with a cursor retained for **Resume**. **画像をまとめて保存** starts at the
  current head of the bookmark data for recent additions. It does not
  automatically launch an unbounded scan of years of posts or assume that older
  posts are saved merely because one image is already known.
- Discovered but unfinished image tasks are persisted separately from saved
  history. A worker restart reconciles known Chrome download IDs. Failed tasks
  are retained and retried on Resume; starting again carries unfinished tasks.
  Known active transfers are never replaced just because monitoring failed.
- Pause stops new acquisition/transfers; transfers already started may finish.
  Resume continues from the stored cursor and retries failed images. The panel
  shows acquisition route, transfer counts, stop reason and unresolved items.
- Download timeout is two minutes. Cancellation and monitoring failures do not
  cause a lower-quality fallback. Clearing saved history is blocked during saves
  and keeps its own confirmation dialog.

Private/deleted/unavailable posts and unrecognized media entries are reported as
unresolved. A complete acquisition response is not a guarantee that X exposed
every historical post. The configured range and unresolved items remain visible.

## Verification


pm test` builds and tests mocked Chrome APIs, page request interception,
pagination, no-scroll execution, bounded concurrency, original-only transfers,
history migration/expiration, fail-safe deduplication, and restart recovery.
These tests do not establish live X connectivity or a real-world speedup.

To check the native route, reload both the extension and X page, select the
bookmark list, start saving, and confirm the panel says **ブックマークの投稿データを
直接取得（スクロールなし）**. If it says **読み込み済み画像のみ**, the native route
was not established. Verify actual completed files in Chrome Downloads.
