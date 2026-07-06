/**
 * Project setup — discovered by the runner's bootstrap (walk-up from the
 * package.json root). Installs the contract.browser adapter (Mode A) so
 * `glubean run` on the browser-mode-a/ journey can resolve `contract.browser`
 * (GLU-233 / P1-3). vitest does not run bootstrap, so the root test-project
 * fixtures are unaffected.
 */
import { installPlugin } from "@glubean/sdk";
import browserPlugin from "@glubean/browser";

await installPlugin(browserPlugin);
