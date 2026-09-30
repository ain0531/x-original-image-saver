# X Original Image Saver

Chrome Manifest V3 extension for saving images from X/Twitter.

## Build and load

```sh
npm ci
npm run build
npm test
```

In `chrome://extensions`, enable Developer mode and load this folder using
**Load unpacked**. After rebuilding, reload the extension there.

## Behavior

- **Save current tweet images** selects the post matching the status ID on a
  post detail page. On a timeline, it selects the first post intersecting the
  viewport, even if that post has no images. Each image uses a Save As dialog.
- **Save all visible images** collects loaded image elements, scrolls, waits,
  and collects again. It includes the final scroll destination. It stops at the
  configured round/time limit or after stability at a bottom where scrolling
  no longer moves. A text-only stretch does not stop the scan.
- Images are deduplicated by media ID and format. Original quality is attempted
  first; a transfer failure can fall back to large quality. User cancellation
  does not retry. A rejected Save As request also does not reopen the dialog.
- Download counts and history are updated only after completion. History is
  recorded even with duplicate checking disabled, and expires after 180 days.
- Saves and history deletion cannot run concurrently across popup windows.
- A transfer is canceled after two minutes if it has not finished.

## Verification

`npm test` builds the extension and runs mocked Chrome API and DOM regression
tests. It does not test against the live X website.

For a browser smoke test, check a post with fewer images than its replies,
repeat a save with history checking enabled, cancel a Save As dialog, and run
a batch scan through text-only posts. Confirm completed files in Chrome's
Downloads page and compare the counts shown by the extension.
