import { test, expect, vi, afterEach } from "vitest";
import type { Browser } from "puppeteer-core";
import { launchChrome, resolveEndpoint } from "./chrome.js";

afterEach(() => {
  vi.restoreAllMocks();
});

test("resolveEndpoint: ws:// passthrough", async () => {
  const ws = "ws://localhost:9222/devtools/browser/abc123";
  expect(await resolveEndpoint(ws)).toBe(ws);
});

test("resolveEndpoint: wss:// passthrough", async () => {
  const wss = "wss://chrome.example.com/devtools/browser/abc123";
  expect(await resolveEndpoint(wss)).toBe(wss);
});

test("resolveEndpoint: http:// auto-discovers WS URL", async () => {
  const expectedWs = "ws://127.0.0.1:9222/devtools/browser/fake-id";

  vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.toString()
      : (input as Request).url;
    expect(url).toBe("http://localhost:9222/json/version");
    return Promise.resolve(
      new Response(JSON.stringify({ webSocketDebuggerUrl: expectedWs }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  });

  const result = await resolveEndpoint("http://localhost:9222");
  expect(result).toBe(expectedWs);
});

test("resolveEndpoint: http:// strips trailing slash", async () => {
  let fetchedUrl = "";

  vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
    fetchedUrl = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.toString()
      : (input as Request).url;
    return Promise.resolve(
      new Response(JSON.stringify({ webSocketDebuggerUrl: "ws://x" }), {
        status: 200,
      }),
    );
  });

  await resolveEndpoint("http://localhost:9222/");
  expect(fetchedUrl).toBe("http://localhost:9222/json/version");
});

test("resolveEndpoint: http:// fetch failure gives clear error", async () => {
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Connection refused"));

  await expect(resolveEndpoint("http://localhost:9222")).rejects.toThrow(
    "Failed to connect to Chrome",
  );
});

test("resolveEndpoint: http:// non-200 response", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response("not found", { status: 404 }),
  );

  await expect(resolveEndpoint("http://localhost:9222")).rejects.toThrow("HTTP 404");
});

test("resolveEndpoint: http:// missing webSocketDebuggerUrl field", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify({ Browser: "Chrome/131" }), { status: 200 }),
  );

  await expect(resolveEndpoint("http://localhost:9222")).rejects.toThrow(
    "did not return a webSocketDebuggerUrl",
  );
});

test("resolveEndpoint: invalid protocol throws", async () => {
  await expect(resolveEndpoint("ftp://chrome.local")).rejects.toThrow(
    "Invalid Chrome endpoint",
  );
});

test("launchChrome awaits explicit unpacked extension installation", async () => {
  const installExtension = vi.fn(async () => "abc123");
  const fakeBrowser = {
    installExtension,
    close: vi.fn(async () => {}),
  } as unknown as Browser;
  const launch = vi.fn(async () => fakeBrowser);

  await expect(launchChrome(
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    { launch, connect: vi.fn(async () => fakeBrowser) },
    { pipe: true, enableExtensions: ["/tmp/extension"] },
  )).resolves.toBe(fakeBrowser);

  expect(launch).toHaveBeenCalledWith(expect.objectContaining({
    enableExtensions: true,
    pipe: true,
  }));
  expect(installExtension).toHaveBeenCalledWith("/tmp/extension");
});

test("launchChrome closes Chrome and reports an unpacked extension rejection", async () => {
  const close = vi.fn(async () => {});
  const fakeBrowser = {
    installExtension: vi.fn(async () => {
      throw new Error("manifest rejected");
    }),
    close,
  } as unknown as Browser;

  await expect(launchChrome(
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    {
      launch: vi.fn(async () => fakeBrowser),
      connect: vi.fn(async () => fakeBrowser),
    },
    { pipe: true, enableExtensions: ["/tmp/broken-extension"] },
  )).rejects.toThrow(
    "Failed to load unpacked Chrome extension at /tmp/broken-extension: manifest rejected",
  );
  expect(close).toHaveBeenCalledOnce();
});

test("launchChrome rejects extension arrays without pipe transport", async () => {
  const fakeBrowser = {} as Browser;
  const launch = vi.fn(async () => fakeBrowser);

  await expect(launchChrome(
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    { launch, connect: vi.fn(async () => fakeBrowser) },
    { enableExtensions: ["/tmp/extension"] },
  )).rejects.toThrow("requires launchOptions.pipe to be true");
  expect(launch).not.toHaveBeenCalled();
});

test("launchChrome rejects direct remote-debugging args with extension arrays", async () => {
  const fakeBrowser = {} as Browser;
  const launch = vi.fn(async () => fakeBrowser);

  await expect(launchChrome(
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    { launch, connect: vi.fn(async () => fakeBrowser) },
    {
      pipe: true,
      enableExtensions: ["/tmp/extension"],
      args: ["--remote-debugging-port=9222"],
    },
  )).rejects.toThrow("Puppeteer owns the required pipe transport");
  expect(launch).not.toHaveBeenCalled();
});

test("launchChrome rejects non-string extension array entries", async () => {
  const fakeBrowser = {} as Browser;
  const launch = vi.fn(async () => fakeBrowser);

  await expect(launchChrome(
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    { launch, connect: vi.fn(async () => fakeBrowser) },
    { pipe: true, enableExtensions: [42] as never },
  )).rejects.toThrow("must contain only extension directory paths");
  expect(launch).not.toHaveBeenCalled();
});
