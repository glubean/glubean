/**
 * WrappedLocator — Proxy-based wrapper around Puppeteer's Locator that
 * auto-injects trace events and screenshot capture for action methods.
 *
 * @module locator
 */

import type { ElementHandle, Locator, Page } from "puppeteer-core";

/** Context required by the WrappedLocator for trace/screenshot injection. */
export interface LocatorContext {
  action(event: {
    category: string;
    target: string;
    duration: number;
    status: "ok" | "error" | "timeout";
    detail?: Record<string, unknown>;
  }): void;
  captureStep(label: string): Promise<void>;
  captureFailure(label: string): Promise<void>;
}

/**
 * An index-scoped locator returned by `WrappedLocator.nth()`.
 *
 * Puppeteer's own `Locator` resolves a CSS/text/ARIA selector to its
 * **first** DOM match only (`document.querySelector` semantics) — there is
 * no native way to act on the Nth match. `nth()` fills that gap with a
 * minimal, independently-polled action surface (not a full `Locator`).
 */
export interface IndexedLocator {
  click(): Promise<void>;
  /** Clears the field's existing value, then types `value`. */
  fill(value: string): Promise<void>;
  hover(): Promise<void>;
  /** Types `text` without clearing the existing value. */
  type(text: string): Promise<void>;
  /** Resolve (waiting up to the configured timeout) and return the raw handle. */
  waitHandle(): Promise<ElementHandle>;
}

/** A Puppeteer Locator enhanced with auto-tracing and screenshot capture. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type WrappedLocator = Locator<any> & {
  /**
   * Type text into the located element (appends — does not clear).
   *
   * Puppeteer's Locator has no `type()` method, so this is an extension
   * that calls `waitHandle()` + `handle.type()` under the hood.
   */
  type(text: string): Promise<void>;
  /**
   * Immediate count of elements currently matching the selector. Does **not**
   * wait/retry — for an auto-retrying count assertion, use `page.expectCount()`.
   *
   * @example
   * ```ts
   * const n = await page.locator('[data-testid="product-item"]').count();
   * ```
   */
  count(): Promise<number>;
  /**
   * Locate the Nth (0-based) element matching this locator's selector.
   *
   * Independently polled — see {@link IndexedLocator}. Puppeteer's Locator
   * always resolves to the first DOM match, so `nth()` is the only way to
   * act on e.g. "the 2nd product card" without a bespoke selector.
   *
   * @example
   * ```ts
   * await page.locator('[data-testid="add-to-cart"]').nth(1).click();
   * ```
   */
  nth(index: number, options?: { timeout?: number }): IndexedLocator;
};

/** @internal Default poll interval while waiting for an nth() match. */
const NTH_POLL_MS = 100;
/** @internal Default nth()/count() action timeout — mirrors `actionTimeout`. */
const NTH_DEFAULT_TIMEOUT_MS = 30_000;

/**
 * @internal Poll for the 0-based `index`-th element matching `selector`,
 * using `document.querySelectorAll` (unlike Puppeteer's Locator, which only
 * ever resolves the first match). Throws with a clear message on timeout.
 */
export async function resolveNthHandle(
  page: Page,
  selector: string,
  index: number,
  timeoutMs: number,
): Promise<ElementHandle> {
  const start = Date.now();
  for (;;) {
    const jsHandle = await page.evaluateHandle(
      (sel: string, i: number) =>
        (document.querySelectorAll(sel)[i] as Element | undefined) ?? null,
      selector,
      index,
    );
    const el = jsHandle.asElement() as ElementHandle | null;
    if (el) return el;
    await jsHandle.dispose();
    if (Date.now() - start >= timeoutMs) {
      throw new Error(
        `nth(${index}): no element matched "${selector}" at index ${index} after ${timeoutMs}ms`,
      );
    }
    await new Promise((r) => setTimeout(r, NTH_POLL_MS));
  }
}

/** @internal Build the {@link IndexedLocator} returned by `WrappedLocator.nth()`. */
function createIndexedLocator(
  page: Page,
  ctx: LocatorContext,
  selector: string,
  index: number,
  timeoutMs: number,
): IndexedLocator {
  const label = `${selector} >> nth=${index}`;

  const act = async (
    category: string,
    detail: Record<string, unknown> | undefined,
    fn: (handle: ElementHandle) => Promise<void>,
  ): Promise<void> => {
    const start = Date.now();
    try {
      const handle = await resolveNthHandle(page, selector, index, timeoutMs);
      try {
        await fn(handle);
      } finally {
        await handle.dispose();
      }
      ctx.action({
        category: `browser:${category}`,
        target: label,
        duration: Date.now() - start,
        status: "ok",
        detail,
      });
      await ctx.captureStep(`${category}-${label}`);
    } catch (err) {
      ctx.action({
        category: `browser:${category}`,
        target: label,
        duration: Date.now() - start,
        status: "timeout",
        detail: { ...detail, error: String(err) },
      });
      await ctx.captureFailure(`${category}-${label}`);
      throw err;
    }
  };

  return {
    click: () => act("click", undefined, (h) => h.click()),
    fill: (value: string) =>
      act("fill", { textLength: value.length }, async (h) => {
        await h.evaluate((el: unknown) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const input = el as any;
          input.value = "";
          input.dispatchEvent(new Event("input", { bubbles: true }));
        });
        await h.type(value);
      }),
    hover: () => act("hover", undefined, (h) => h.hover()),
    type: (text: string) =>
      act("type", { textLength: text.length }, (h) => h.type(text)),
    waitHandle: () => resolveNthHandle(page, selector, index, timeoutMs),
  };
}

/** Methods that return a new Locator — we re-wrap the result. */
const CHAIN_METHODS = new Set([
  "setTimeout",
  "setVisibility",
  "setEnsureElementIsInTheViewport",
  "setWaitForEnabled",
  "setWaitForStableBoundingBox",
  "clone",
  "filter",
  "map",
]);

/** Action methods that get trace/screenshot injection. */
const ACTION_METHODS = new Set([
  "click",
  "fill",
  "hover",
  "scroll",
]);

/**
 * Create a WrappedLocator that proxies a Puppeteer Locator with auto-tracing.
 *
 * - **Chain methods** (setTimeout, setVisibility, etc.) return a new WrappedLocator.
 * - **Action methods** (click, fill, hover, scroll) inject trace + screenshot.
 * - **type()** is a custom extension (Locator has no type method).
 * - **count() / nth()** are custom extensions (see {@link IndexedLocator}) —
 *   Puppeteer's Locator only ever resolves the first DOM match.
 * - Everything else is transparently forwarded.
 */
export function createWrappedLocator(
  inner: Locator<unknown>,
  ctx: LocatorContext,
  selector: string,
  page: Page,
): WrappedLocator {
  const proxy = new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === "count") {
        return async (): Promise<number> => (await page.$$(selector)).length;
      }

      if (prop === "nth") {
        return (index: number, options?: { timeout?: number }): IndexedLocator =>
          createIndexedLocator(
            page,
            ctx,
            selector,
            index,
            options?.timeout ?? NTH_DEFAULT_TIMEOUT_MS,
          );
      }

      if (prop === "type") {
        return async (text: string) => {
          const start = Date.now();
          try {
            const handle = await target.waitHandle() as ElementHandle;
            await handle.type(text);
            await handle.dispose();
            const duration = Date.now() - start;
            ctx.action({
              category: "browser:type",
              target: selector,
              duration,
              status: "ok",
              detail: { textLength: text.length },
            });
            await ctx.captureStep(`type-${selector}`);
          } catch (err) {
            const duration = Date.now() - start;
            ctx.action({
              category: "browser:type",
              target: selector,
              duration,
              status: "timeout",
              detail: { textLength: text.length, error: String(err) },
            });
            await ctx.captureFailure(`type-${selector}`);
            throw err;
          }
        };
      }

      if (typeof prop === "string" && CHAIN_METHODS.has(prop)) {
        const origFn = Reflect.get(target, prop, receiver);
        if (typeof origFn === "function") {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return (...args: any[]) => {
            const newLocator = origFn.apply(target, args);
            return createWrappedLocator(newLocator, ctx, selector, page);
          };
        }
      }

      if (typeof prop === "string" && ACTION_METHODS.has(prop)) {
        const origFn = Reflect.get(target, prop, receiver);
        if (typeof origFn === "function") {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return async (...args: any[]) => {
            const start = Date.now();
            try {
              const result = await origFn.apply(target, args);
              const duration = Date.now() - start;
              ctx.action({
                category: `browser:${prop}`,
                target: selector,
                duration,
                status: "ok",
              });
              await ctx.captureStep(`${prop}-${selector}`);
              return result;
            } catch (err) {
              const duration = Date.now() - start;
              ctx.action({
                category: `browser:${prop}`,
                target: selector,
                duration,
                status: "timeout",
                detail: { error: String(err) },
              });
              await ctx.captureFailure(`${prop}-${selector}`);
              throw err;
            }
          };
        }
      }

      // Everything else — transparent passthrough
      return Reflect.get(target, prop, receiver);
    },
  });

  return proxy as unknown as WrappedLocator;
}
