# Testing an extension options page

Chrome extensions declare an options document with `options_ui.page` or the
legacy `options_page` key. Resolve that declaration from the built manifest,
then test the extension-origin document like a normal instrumented page.
See Chrome's [options page manifest documentation](https://developer.chrome.com/docs/extensions/develop/ui/options-page).

```ts
import {
  extensionPageUrl,
  getInstalledExtension,
  resolveExtensionPagePath,
} from "@glubean/browser/chrome-extension";
import { extension, test } from "./setup.js";

const optionsPath = resolveExtensionPagePath(extension, "options");

export const optionsPage = test(
  {
    id: "extension-options-page-renders-and-saves",
    name: "The extension options page renders and saves a setting",
    tags: ["browser", "extension", "options"],
  },
  async (ctx) => {
    const loaded = await getInstalledExtension(ctx.page.raw.browser(), {
      path: extension.path,
    });

    await ctx.page.goto(extensionPageUrl(loaded.id, optionsPath), {
      waitUntil: "domcontentloaded",
    });
    await ctx.page.raw.waitForSelector("[data-testid=options-root]");

    ctx.expect(await ctx.page.title()).toBe(
      "Extension Options",
      "the manifest-declared options document renders",
    );

    await ctx.page.click("#enabled");
    ctx.expect(await ctx.page.raw.$eval(
      "#enabled",
      (element) => (element as HTMLInputElement).checked,
    )).toBe(true, "the options control changes state");
  },
);
```

For persisted settings, reopen the document or evaluate `chrome.storage` from
the options page and assert the saved value. A reachability-only assertion is
too weak: it misses broken scripts, missing controls, and storage failures.

This test proves the options document itself. If the requirement is that users
can discover it through `chrome://extensions`, keep that Chrome-owned
navigation as a separate UI acceptance case.
