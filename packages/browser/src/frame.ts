/**
 * GlubeanFrame — locator ergonomics scoped to an `<iframe>`'s content frame.
 *
 * Per the proposal's "iframe is a hybrid" note (browser-testing-cloud-rollout.md
 * M5): CDP already does the execution-context switch — that's Puppeteer's own
 * `Frame` object, wired up via `Page.frameAttached` / `Runtime.executionContextCreated`
 * before this module ever runs. The only thing missing was the encapsulation
 * layer's locator ergonomics (byTestId/byText/byRole/byLabel, auto-tracing
 * click/fill/type/hover, auto-retrying expect*) scoped to a frame instead of
 * the top-level page — that's what this module adds. Created via
 * `GlubeanPage.frame(selector)`.
 *
 * @module frame
 */

import type { Frame } from "puppeteer-core";
import { createWrappedLocator, type LocatorContext, type WrappedLocator } from "./locator.js";

/** Options accepted by GlubeanFrame's interaction methods. */
export interface FrameActionOptions {
  /** Timeout in ms (overrides the frame's configured default). */
  timeout?: number;
}

/**
 * A Puppeteer `Frame` wrapped with the same locator/assertion ergonomics as
 * `GlubeanPage`, scoped to that frame's content. Returned by `page.frame()`.
 */
export class GlubeanFrame {
  /** The underlying Puppeteer Frame for advanced use cases. */
  readonly raw: Frame;

  private readonly _ctx: LocatorContext;
  private readonly _actionTimeout: number;

  /** @internal — created by `GlubeanPage.frame()`. */
  constructor(frame: Frame, ctx: LocatorContext, actionTimeout: number) {
    this.raw = frame;
    this._ctx = ctx;
    this._actionTimeout = actionTimeout;
  }

  /** Current frame URL. */
  url(): string {
    return this.raw.url();
  }

  /**
   * Create a WrappedLocator scoped to this frame — same auto-tracing/
   * screenshot behavior as `GlubeanPage.locator()`.
   */
  locator(selector: string): WrappedLocator {
    const inner = this.raw.locator(selector);
    return createWrappedLocator(inner, this._ctx, selector, this.raw);
  }

  /** Locate an element by its `data-testid` attribute, scoped to this frame. */
  byTestId(id: string): WrappedLocator {
    return this.locator(`[data-testid="${id}"]`);
  }

  /** Locate an element by its visible text content, scoped to this frame. */
  byText(text: string): WrappedLocator {
    return this.locator(`::-p-text(${text})`);
  }

  /** Locate an element by its ARIA role (and optionally accessible name), scoped to this frame. */
  byRole(role: string, options?: { name?: string }): WrappedLocator {
    if (options?.name) {
      return this.locator(`::-p-aria(${options.name}[role="${role}"])`);
    }
    return this.locator(`[role="${role}"]`);
  }

  /** Locate an element by its accessible name (ARIA label), scoped to this frame. */
  byLabel(label: string): WrappedLocator {
    return this.locator(`::-p-aria(${label})`);
  }

  /** Click an element matching the selector, scoped to this frame. */
  async click(selector: string, options?: FrameActionOptions): Promise<void> {
    await this.locator(selector)
      .setTimeout(options?.timeout ?? this._actionTimeout)
      .click();
  }

  /** Clear an input and type a new value, scoped to this frame. */
  async fill(selector: string, value: string, options?: FrameActionOptions): Promise<void> {
    await this.locator(selector)
      .setTimeout(options?.timeout ?? this._actionTimeout)
      .fill(value);
  }

  /** Type text into an element (appends — does not clear), scoped to this frame. */
  async type(selector: string, text: string, options?: FrameActionOptions): Promise<void> {
    await (this.locator(selector)
      .setTimeout(options?.timeout ?? this._actionTimeout) as WrappedLocator)
      .type(text);
  }

  /** Hover over an element matching the selector, scoped to this frame. */
  async hover(selector: string, options?: FrameActionOptions): Promise<void> {
    await this.locator(selector)
      .setTimeout(options?.timeout ?? this._actionTimeout)
      .hover();
  }

  /** Check whether an element is currently visible. Returns immediately — does not wait. */
  async isVisible(selector: string): Promise<boolean> {
    const handle = await this.raw.$(selector);
    if (!handle) return false;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return await handle.evaluate((el: any) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const style = (globalThis as any).getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden") return false;
        const box = el.getBoundingClientRect();
        return box.width > 0 && box.height > 0;
      });
    } finally {
      await handle.dispose();
    }
  }

  /** Assert that an element is visible, scoped to this frame. Retries until visible or timeout. */
  async expectVisible(selector: string, options?: { timeout?: number }): Promise<void> {
    await this._retryUntil(
      () => this.isVisible(selector),
      (visible) => visible === true,
      "browser:assert",
      `expectVisible("${selector}")`,
      () => `expectVisible("${selector}"): element was not visible after ${options?.timeout ?? 5_000}ms`,
      options,
    );
  }

  /** Assert that an element is hidden or absent, scoped to this frame. Retries until hidden or timeout. */
  async expectHidden(selector: string, options?: { timeout?: number }): Promise<void> {
    await this._retryUntil(
      () => this.isVisible(selector),
      (visible) => visible === false,
      "browser:assert",
      `expectHidden("${selector}")`,
      () => `expectHidden("${selector}"): element was still visible after ${options?.timeout ?? 5_000}ms`,
      options,
    );
  }

  /**
   * Assert that an element's text content matches `expected`, scoped to this
   * frame. Retries until match or timeout. Same normalize/match rules as
   * `GlubeanPage.expectText()`.
   */
  async expectText(
    selector: string,
    expected: string | RegExp,
    options?: { timeout?: number; exact?: boolean; ignoreCase?: boolean },
  ): Promise<void> {
    const normalize = (s: string) => s.replace(/\s+/g, " ").trim();
    const matches = (text: string | null) => {
      if (text === null) return false;
      if (expected instanceof RegExp) return expected.test(text);
      const norm = normalize(text);
      const exp = normalize(expected);
      if (options?.exact) {
        return options?.ignoreCase ? norm.toLowerCase() === exp.toLowerCase() : norm === exp;
      }
      return options?.ignoreCase ? norm.toLowerCase().includes(exp.toLowerCase()) : norm.includes(exp);
    };

    await this._retryUntil(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      () => this.raw.$eval(selector, (el: any) => el.textContent as string | null).catch(() => null),
      matches,
      "browser:assert",
      `expectText("${selector}")`,
      (lastVal) =>
        `expectText("${selector}"): expected ${JSON.stringify(expected)} but received ` +
        `${JSON.stringify(lastVal)} after ${options?.timeout ?? 5_000}ms`,
      options,
    );
  }

  // ── Retry utility (mirrors GlubeanPage._retryUntil) ─────────────────

  private static readonly _POLL_MS = 100;

  private async _retryUntil<T>(
    fn: () => Promise<T>,
    check: (val: T) => boolean,
    category: string,
    target: string,
    errorMsg: (lastVal: T) => string,
    options?: { timeout?: number },
  ): Promise<T> {
    const timeout = options?.timeout ?? 5_000;
    const start = Date.now();
    let lastVal: T | undefined;

    while (Date.now() - start < timeout) {
      try {
        lastVal = await fn();
        if (check(lastVal)) {
          this._ctx.action({ category, target, duration: Date.now() - start, status: "ok" });
          return lastVal;
        }
      } catch {
        // element may not exist yet — retry
      }
      await new Promise((r) => setTimeout(r, GlubeanFrame._POLL_MS));
    }

    try {
      lastVal = await fn();
      if (check(lastVal!)) {
        this._ctx.action({ category, target, duration: Date.now() - start, status: "ok" });
        return lastVal!;
      }
    } catch {
      // fall through to error
    }

    const msg = errorMsg(lastVal as T);
    this._ctx.action({
      category,
      target,
      duration: Date.now() - start,
      status: "timeout",
      detail: { error: msg },
    });
    await this._ctx.captureFailure(target);
    throw new Error(msg);
  }
}

/** @internal Build a {@link GlubeanFrame} — called by `GlubeanPage.frame()`. */
export function createFrame(
  frame: Frame,
  ctx: LocatorContext,
  actionTimeout: number,
): GlubeanFrame {
  return new GlubeanFrame(frame, ctx, actionTimeout);
}
