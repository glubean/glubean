# @glubean/browser

Glubean's Puppeteer plugin launches or connects to Chrome and wraps pages with
test evidence, tracing, metrics, screenshots, request mocking, and browser
lifecycle management.

## Browser tests

```ts
import { configure, test } from "@glubean/sdk";
import { browser } from "@glubean/browser";

const { chrome } = configure({
  plugins: {
    chrome: browser({ launch: true, baseUrl: "APP_URL" }),
  },
});

const browserTest = test.extend({
  page: async (ctx, use) => {
    const page = await chrome.newPage(ctx);
    try {
      await use(page);
    } finally {
      await page.close();
    }
  },
});
```

## Chrome extension tests

Load unpacked extension directories through the same browser client:

```ts
const { chrome } = configure({
  plugins: {
    chrome: browser({
      launch: true,
      extensions: ["apps/extension/dist"],
    }),
  },
});
```

`extensions` accepts runtime templates such as `"{{EXTENSION_PATH}}"`, bare
runtime variable keys, and literal paths. The directories are validated before
Chrome starts. Extension launch mode requires Puppeteer's pipe transport and
defaults to visible Chrome; set
`launchOptions.headless` explicitly if the tested surfaces support headless
execution.

Pipe transport has no CDP WebSocket URL, so an extension-enabled session cannot
be handed to `glubean qa attach`. Launch a separate browser client without
`extensions` when an attachable QA session is required.

Chrome-specific helpers are exported from `@glubean/browser/chrome-extension`:

- manifest and unpacked-directory validation;
- extension ID, worker, page, and target discovery;
- content-script ready-message watchers;
- toolbar-action triggering through Puppeteer's `Extension` API;
- native side-panel open/close verification;
- typed `page.extension.sidePanel` capabilities for tests and browser contracts;
- a `createExtensionTest()` convenience fixture.

See Puppeteer's [Chrome extension guide](https://pptr.dev/guides/chrome-extensions)
for the underlying extension runtime model.

See the separate guides for [options pages](guides/chrome-extension/options.md),
[side panels](guides/chrome-extension/sidepanel.md), and
[content scripts](guides/chrome-extension/content-scripts.md).

Run the package's real-Chrome acceptance test with:

```sh
pnpm --filter @glubean/browser test:chrome-extension:smoke
```

The high-level extension helpers require `puppeteer-core >= 24.41.0`. Closing a
native side panel requires Chrome 141 or newer because it uses
`chrome.sidePanel.close()` inside the extension service worker.
