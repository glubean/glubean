# Testing a side panel

There are two useful levels of Side Panel proof:

1. open the manifest-declared HTML document directly to test its UI in
   isolation;
2. trigger the real extension toolbar action and verify Chrome opens and closes
   the native side panel.

The second level is supported by Puppeteer's `Extension` API. It avoids calling
`chrome.sidePanel.open()` from an arbitrary script, which Chrome rejects unless
the call follows a user action.
See Chrome's [Side Panel API reference](https://developer.chrome.com/docs/extensions/reference/api/sidePanel).

```ts
import {
  closeExtensionSidePanel,
  resolveExtensionPagePath,
  triggerExtensionAction,
  waitForExtensionOwnedPage,
  waitForExtensionPageClosed,
  waitForExtensionWorker,
} from "@glubean/browser/chrome-extension";
import { extension, test } from "./setup.js";

const sidePanelPath = resolveExtensionPagePath(extension, "sidepanel");

export const nativeSidePanel = test(
  {
    id: "extension-side-panel-opens-and-closes",
    name: "The toolbar action opens and closes the extension side panel",
    tags: ["browser", "extension", "sidepanel"],
  },
  async (ctx) => {
    await ctx.page.goto("/sidepanel-fixture");

    const loaded = await triggerExtensionAction(ctx.page.raw, {
      path: extension.path,
    });
    const panel = await waitForExtensionOwnedPage(loaded, sidePanelPath);
    await panel.waitForSelector("[data-testid=sidepanel-root]");

    ctx.expect(await panel.title()).toBe(
      "Extension Side Panel",
      "the toolbar action opens the declared side-panel document",
    );

    const worker = await waitForExtensionWorker(
      ctx.page.raw.browser(),
      loaded.id,
    );
    await closeExtensionSidePanel(worker.worker);
    await waitForExtensionPageClosed(loaded, panel);
  },
);
```

The extension must declare the `sidePanel` permission and configure its action
to open the panel, for example with
`chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })`.

`triggerExtensionAction()` requires `puppeteer-core >= 24.41.0`.
`closeExtensionSidePanel()` evaluates `chrome.sidePanel.close({ windowId })` in
the extension worker and therefore requires Chrome 141 or newer. Pass an
explicit `{ windowId }` when the test owns multiple Chrome windows.

To isolate panel rendering from browser action behavior, navigate directly to
`extensionPageUrl(loaded.id, sidePanelPath)` in a separate test. That is useful
component-level proof, but it does not prove the toolbar action or native panel
container.
