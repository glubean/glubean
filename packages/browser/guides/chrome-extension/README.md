# Chrome extension surface guides

One `@glubean/browser` client can load an unpacked extension and test each of
its runtime surfaces. The proof is different for each surface:

| Surface | Entry point | Primary proof |
| --- | --- | --- |
| Options page | Declared `chrome-extension://` document | UI, controls, and storage behavior |
| Side panel | Toolbar action or declared document | Native open/close state and rendered panel UI |
| Content script | A web URL matching `content_scripts.matches` | Ready message, DOM change, or page/extension bridge |

## Shared setup

```ts
import path from "node:path";
import {
  createExtensionTest,
  resolveUnpackedExtension,
} from "@glubean/browser/chrome-extension";

export const extension = resolveUnpackedExtension(
  path.resolve(process.env.CHROME_EXTENSION_PATH ?? "apps/extension/dist"),
);

export const { test, chrome } = createExtensionTest({
  extensions: extension.path,
  baseUrl: "APP_URL",
  launchOptions: {
    userDataDir: ".glubean/chrome-profile",
  },
});
```

Use a unique `userDataDir` per concurrently running worker, or omit it and let
Puppeteer create an isolated temporary profile. Chrome rejects two processes
that try to own the same profile directory.

Extension mode defaults to visible Chrome. On a display-less CI runner, either
use Xvfb or set `launchOptions.headless: true` after verifying the tested
extension surfaces work in Chrome's current headless mode.

Because extension launch uses pipe transport, it has no CDP WebSocket URL and
cannot be reused by `glubean qa attach`. Use a separate launch without
`extensions` for attachable QA sessions.

`ctx.page.goto()` accepts both application-relative paths and absolute
`chrome-extension://` URLs even when `baseUrl` is configured.
The `extensions` option also accepts literal paths, `"{{EXTENSION_PATH}}"`
templates, or a bare runtime variable key such as `"EXTENSION_PATH"`.

Pages created by `createExtensionTest()` expose extension-only operations under
`ctx.page.extension`. The same typed capability is inferred in
`contract.browser` step actions when the scoped client comes from
`browser({ launch: true, extensions })`.

Run a guide as a normal Glubean test:

```sh
glubean run tests/chrome-extension/options.test.ts
```

When only one extension is loaded, `getInstalledExtension()` discovers its
runtime ID directly from Puppeteer:

```ts
import { getInstalledExtension } from "@glubean/browser/chrome-extension";

const loaded = await getInstalledExtension(ctx.page.raw.browser());
console.log(loaded.id, loaded.name, loaded.version);
```

If multiple extensions are loaded, select one by `{ id }`, `{ name }`, or
`{ path }`.
