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
import { extension, test } from "./setup.js";

export const nativeSidePanel = test(
  {
    id: "extension-side-panel-opens-and-closes",
    name: "The toolbar action opens and closes the extension side panel",
    tags: ["browser", "extension", "sidepanel"],
  },
  async (ctx) => {
    await ctx.page.goto("/sidepanel-fixture");

    const panel = await ctx.page.extension.sidePanel.open({
      extension: { path: extension.path },
    });
    await panel.page.waitForSelector("[data-testid=sidepanel-root]");

    ctx.expect(await panel.page.title()).toBe(
      "Extension Side Panel",
      "the toolbar action opens the declared side-panel document",
    );

    await panel.close();
  },
);
```

`open()` defaults to the selected extension's manifest-declared
`side_panel.default_path`. Use `pagePath` to override it. When one extension is
loaded, omit `extension`; when several are loaded, select one by id, name, or
unpacked-directory path. Calling `open()` while the matching panel is already
active throws a targeted error; use `current()` to recover that handle instead.
The optional `timeout` is one total budget for extension discovery and panel
opening, rather than a separate budget for each stage.

The returned `panel.page` is the raw Puppeteer page for the extension-owned
document. It is intentionally outside the host page's single-page evidence
window; use imperative assertions inside the step action. Declarative
multi-page `contract.browser expect[]` support is a separate concern.

The same capability is inferred for extension-backed browser contracts — the
scoped client fixes the page type, so `page.extension` is available inside a step
action with no explicit generics:

```ts
import { contract } from "@glubean/sdk";
import { browserCase } from "@glubean/browser";
import { chrome } from "./setup.js";

const extensionUI = contract.browser.with("extensionUI", { client: chrome });

export const nativeSidePanelLifecycle = extensionUI("native-side-panel-lifecycle", {
  cases: {
    // `browserCase()` — the zero-argument form, for a journey with no logical
    // input. A journey that takes input declares its schema once, in that call:
    // `browserCase(schema)({ ... })`.
    openCloseReopen: browserCase()({
      description: "The toolbar action opens, closes, and reopens the native side panel.",
      steps: [{
        id: "open-close-reopen",
        intent: "open the side panel, close it, and open it again",
        action: async (page) => {
          const first = await page.extension.sidePanel.open();
          await first.close();
          const second = await page.extension.sidePanel.open();
          await second.close();
        },
      }],
      expect: [],
    }),
  },
});
```

The extension must declare the `sidePanel` permission and configure its action
to open the panel, for example with
`chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })`.

`sidePanel.open()` relies on Puppeteer's `Extension.triggerAction()` and
therefore requires `puppeteer-core >= 24.41.0`. The handle's `close()` method
evaluates `chrome.sidePanel.close({ windowId })` in the extension worker and
therefore requires Chrome 141 or newer. Pass an explicit `{ windowId }` when
the test owns multiple Chrome windows.

To isolate panel rendering from browser action behavior, navigate directly to
the declared document in a separate test:

```ts
import {
  extensionPageUrl,
  getInstalledExtension,
  resolveExtensionPagePath,
} from "@glubean/browser/chrome-extension";
import { extension, test } from "./setup.js";

export const sidePanelDocument = test(
  {
    id: "side-panel-document",
    name: "The declared Side Panel document renders in isolation",
    tags: ["browser", "extension", "sidepanel"],
  },
  async (ctx) => {
    const loaded = await getInstalledExtension(ctx.page.raw.browser());
    const sidePanelPath = resolveExtensionPagePath(extension, "sidepanel");
    await ctx.page.goto(extensionPageUrl(loaded.id, sidePanelPath));
    ctx.expect(await ctx.page.title()).toBe(
      "Extension Side Panel",
      "the declared Side Panel document renders",
    );
  },
);
```

That is useful component-level proof, but it does not prove the toolbar action
or native panel container.
