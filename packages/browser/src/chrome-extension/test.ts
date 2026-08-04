import { configure, test as baseTest, type ExtensionFn } from "@glubean/sdk";
import type { BrowserOptions, BrowserTestContext, InstrumentedPage } from "../page.js";
import { browser } from "../plugin.js";

export type ChromeExtensionTestOptions = Omit<
  Extract<BrowserOptions, { launch: true }>,
  "launch" | "extensions"
> & {
  extensions: string | readonly string[];
};

/** Create a Glubean test with a fresh instrumented page and loaded extensions. */
export function createExtensionTest(options: ChromeExtensionTestOptions) {
  const { chrome } = configure({
    plugins: {
      chrome: browser({ ...options, launch: true }),
    },
  });
  const pageFixture: ExtensionFn<InstrumentedPage> = async (ctx, use) => {
    const page = await chrome.newPage(ctx as unknown as BrowserTestContext);
    try {
      await use(page);
    } catch (error) {
      await page.screenshotOnFailure();
      throw error;
    } finally {
      await page.close();
    }
  };

  return {
    test: baseTest.extend({ page: pageFixture }),
    chrome,
  };
}
