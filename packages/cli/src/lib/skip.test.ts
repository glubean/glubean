import { test, expect } from "vitest";
import { shouldSkipTest, type CapabilityProfile } from "./skip.js";

const none: CapabilityProfile = { browser: false, outOfBand: false, optIn: false };
const all: CapabilityProfile = { browser: true, outOfBand: true, optIn: true };

// deferred
test("deferred case always skips regardless of profile", () => {
  expect(shouldSkipTest({ deferred: "not wired yet" }, none)).toBe("deferred: not wired yet");
  expect(shouldSkipTest({ deferred: "not wired yet" }, all)).toBe("deferred: not wired yet");
});

test("deferred takes priority over requires:browser", () => {
  const reason = shouldSkipTest({ deferred: "todo", requires: "browser" }, all);
  expect(reason).toBe("deferred: todo");
});

// requires
test("requires:headless (default) always runs", () => {
  expect(shouldSkipTest({}, none)).toBeUndefined();
  expect(shouldSkipTest({ requires: "headless" }, none)).toBeUndefined();
});

test("requires:browser skips without --include-browser", () => {
  expect(shouldSkipTest({ requires: "browser" }, none)).toMatch(/include-browser/);
});

test("requires:browser runs with --include-browser", () => {
  expect(shouldSkipTest({ requires: "browser" }, { ...none, browser: true })).toBeUndefined();
});

test("requires:out-of-band skips without --include-out-of-band", () => {
  expect(shouldSkipTest({ requires: "out-of-band" }, none)).toMatch(/include-out-of-band/);
});

test("requires:out-of-band runs with --include-out-of-band", () => {
  expect(shouldSkipTest({ requires: "out-of-band" }, { ...none, outOfBand: true })).toBeUndefined();
});

// defaultRun
test("defaultRun:always (default) always runs", () => {
  expect(shouldSkipTest({ defaultRun: "always" }, none)).toBeUndefined();
});

test("defaultRun:opt-in + headless skips without --include-opt-in", () => {
  expect(shouldSkipTest({ defaultRun: "opt-in" }, none)).toMatch(/include-opt-in/);
});

test("defaultRun:opt-in + headless runs with --include-opt-in", () => {
  expect(shouldSkipTest({ defaultRun: "opt-in" }, { ...none, optIn: true })).toBeUndefined();
});

test("defaultRun:opt-in + requires:browser runs when browser included (non-headless opt-in)", () => {
  // Non-headless opt-in: gated by requires, not by --include-opt-in
  expect(
    shouldSkipTest({ requires: "browser", defaultRun: "opt-in" }, { ...none, browser: true }),
  ).toBeUndefined();
});
