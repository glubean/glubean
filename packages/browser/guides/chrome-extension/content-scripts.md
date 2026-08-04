# Testing content scripts

Content scripts run inside web pages whose URLs match the manifest. They are
not opened as `chrome-extension://` documents, so test them through the same
observable boundary used by the application: DOM changes, messages, or
extension side effects.
See Chrome's [content script documentation](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts).

## Ready message at document start

Install the watcher before navigation. This prevents a `document_start` ready
message from racing past the test listener.

```ts
import {
  installExtensionReadyWatcher,
} from "@glubean/browser/chrome-extension";
import { test } from "./setup.js";

export const contentScriptInjection = test(
  {
    id: "extension-content-script-injects-on-matching-page",
    name: "The content script announces readiness on a matching page",
    tags: ["browser", "extension", "content-script"],
  },
  async (ctx) => {
    const ready = await installExtensionReadyWatcher(ctx.page.raw, {
      keys: ["__glubean"],
    });
    try {
      await ctx.page.goto("/content-script-fixture", {
        waitUntil: "domcontentloaded",
      });

      const event = await ready.wait();
      ctx.expect(event.key).toBe(
        "__glubean",
        "the matching content script announces its namespace",
      );
      ctx.expect(event.version).toBeDefined(
        "the ready envelope identifies the loaded extension version",
      );
    } finally {
      await ready.dispose();
    }
  },
);
```

The content script side of that contract is a normal top-level page message:

```ts
window.postMessage({
  __glubean: "ready",
  version: chrome.runtime.getManifest().version,
}, "*");
```

The object key must be one of the watcher's `keys`, and its value must be the
string `"ready"`. The optional `version` is returned to the test. The watcher
observes the top-level page; use an explicit iframe probe for content scripts
configured with `all_frames: true`.

The final URL must match `content_scripts.matches`, including scheme, host, and
path. Redirects can move a page out of scope. A deliberate non-matching URL is
a separate negative case.

## DOM and message-bridge behavior

When the script does not publish a ready envelope, wait for a stable DOM marker:

```ts
await ctx.page.goto("/content-script-fixture");
await ctx.page.raw.waitForFunction(
  () => document.documentElement.dataset.extensionReady === "true",
);

ctx.expect(await ctx.page.raw.$eval(
  "[data-testid=extension-banner]",
  (element) => element.textContent?.trim(),
)).toBe("Extension connected", "the content script renders its banner");
```

For a `window.postMessage` bridge, install the response listener before sending
the request and assert the correlation ID and payload that the web app receives.

Puppeteer 24.41+ also exposes `page.extensionRealms()` for direct isolated-world
evaluation. Prefer black-box page behavior for product tests; use extension
realms when the isolated-world state itself is the contract under test.
