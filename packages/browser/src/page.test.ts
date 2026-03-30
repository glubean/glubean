import { test, expect, vi } from "vitest";
import { GlubeanPage } from "./page.js";

/**
 * Semantic locator methods are thin wrappers over `locator(selector)`.
 * We spy on the prototype's `locator` to verify the selector strings
 * without needing to construct a full GlubeanPage instance.
 */

function spyLocator() {
  const fake = {} as any; // returned WrappedLocator (unused)
  const spy = vi
    .spyOn(GlubeanPage.prototype, "locator")
    .mockReturnValue(fake);
  // Create a minimal object that inherits GlubeanPage methods
  const page = Object.create(GlubeanPage.prototype);
  return { page, spy, fake };
}

test("byTestId returns locator with data-testid selector", () => {
  const { page, spy, fake } = spyLocator();
  const result = page.byTestId("submit-btn");
  expect(spy).toHaveBeenCalledWith('[data-testid="submit-btn"]');
  expect(result).toBe(fake);
});

test("byText returns locator with ::-p-text selector", () => {
  const { page, spy, fake } = spyLocator();
  const result = page.byText("Sign in");
  expect(spy).toHaveBeenCalledWith("::-p-text(Sign in)");
  expect(result).toBe(fake);
});

test("byRole with name returns locator with ::-p-aria selector", () => {
  const { page, spy, fake } = spyLocator();
  const result = page.byRole("button", { name: "Submit" });
  expect(spy).toHaveBeenCalledWith('::-p-aria(Submit[role="button"])');
  expect(result).toBe(fake);
});

test("byRole without name returns locator with role attribute selector", () => {
  const { page, spy, fake } = spyLocator();
  const result = page.byRole("navigation");
  expect(spy).toHaveBeenCalledWith('[role="navigation"]');
  expect(result).toBe(fake);
});

test("byLabel returns locator with ::-p-aria selector", () => {
  const { page, spy, fake } = spyLocator();
  const result = page.byLabel("Email address");
  expect(spy).toHaveBeenCalledWith("::-p-aria(Email address)");
  expect(result).toBe(fake);
});
