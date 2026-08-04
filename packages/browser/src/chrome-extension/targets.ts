import type { Browser, Page, Target, WebWorker } from "puppeteer-core";

const EXTENSION_URL_PREFIX = "chrome-extension://";

export type ExtensionTargetType =
  | "page"
  | "background_page"
  | "service_worker"
  | "shared_worker"
  | "webview"
  | "other";

export interface ExtensionTargetSelector {
  id?: string;
  path?: string;
  type?: ExtensionTargetType;
}

export interface ExtensionTargetInfo {
  id: string;
  path: string;
  url: string;
  type: ExtensionTargetType;
  target: Target;
}

export interface ExtensionWorkerInfo extends ExtensionTargetInfo {
  type: "service_worker" | "shared_worker";
  worker: WebWorker;
}

export interface ExtensionPageInfo extends ExtensionTargetInfo {
  type: "page" | "background_page" | "webview";
  page: Page;
}

export function extensionPageUrl(id: string, path = ""): string {
  const normalizedId = id.trim();
  if (!normalizedId) throw new Error("Chrome extension id must not be empty.");
  const normalizedPath = path.replace(/^\/+/, "");
  return `${EXTENSION_URL_PREFIX}${normalizedId}/${normalizedPath}`;
}

export function parseExtensionUrl(url: string): { id: string; path: string } | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "chrome-extension:" || !parsed.hostname) return null;
    return {
      id: parsed.hostname,
      path: decodePath(parsed.pathname.replace(/^\/+/, "")),
    };
  } catch {
    return null;
  }
}

export function listExtensionTargets(browser: Browser): ExtensionTargetInfo[] {
  return browser.targets().flatMap((target) => {
    const info = toExtensionTargetInfo(target);
    return info ? [info] : [];
  });
}

export function findExtensionTarget(
  browser: Browser,
  selector: string | ExtensionTargetSelector,
): ExtensionTargetInfo | undefined {
  const normalized = normalizeSelector(selector);
  return listExtensionTargets(browser).find((info) => matches(info, normalized));
}

export async function waitForExtensionTarget(
  browser: Browser,
  selector: string | ExtensionTargetSelector,
  options: { timeout?: number } = {},
): Promise<ExtensionTargetInfo> {
  const normalized = normalizeSelector(selector);
  const existing = findExtensionTarget(browser, normalized);
  if (existing) return existing;

  const target = await browser.waitForTarget((candidate) => {
    const info = toExtensionTargetInfo(candidate);
    return info ? matches(info, normalized) : false;
  }, options);

  const info = toExtensionTargetInfo(target);
  if (!info) {
    throw new Error("Puppeteer returned a non-extension target while waiting for an extension target.");
  }
  return info;
}

export async function waitForExtensionWorker(
  browser: Browser,
  selector: string | Omit<ExtensionTargetSelector, "type">,
  options: { timeout?: number } = {},
): Promise<ExtensionWorkerInfo> {
  const normalized = normalizeSelector(selector);
  const existing = listExtensionTargets(browser).find(
    (info) => isWorkerType(info.type) && matches(info, normalized),
  );
  const target = existing?.target ?? await browser.waitForTarget((candidate) => {
    const info = toExtensionTargetInfo(candidate);
    return info ? isWorkerType(info.type) && matches(info, normalized) : false;
  }, options);
  const info = toExtensionTargetInfo(target);
  if (!info || !isWorkerType(info.type)) {
    throw new Error("Puppeteer returned a non-worker target while waiting for an extension worker.");
  }
  const worker = await target.worker();
  if (!worker) {
    throw new Error(`Extension worker target is no longer available: ${target.url()}`);
  }
  return { ...info, type: info.type, worker };
}

export async function waitForExtensionPage(
  browser: Browser,
  selector: string | Omit<ExtensionTargetSelector, "type">,
  options: { timeout?: number } = {},
): Promise<ExtensionPageInfo> {
  const normalized = normalizeSelector(selector);
  const existing = listExtensionTargets(browser).find(
    (info) => isPageType(info.type) && matches(info, normalized),
  );
  const target = existing?.target ?? await browser.waitForTarget((candidate) => {
    const info = toExtensionTargetInfo(candidate);
    return info ? isPageType(info.type) && matches(info, normalized) : false;
  }, options);
  const info = toExtensionTargetInfo(target);
  if (!info || !isPageType(info.type)) {
    throw new Error("Puppeteer returned a non-page target while waiting for an extension page.");
  }
  const page = await target.page();
  if (!page) throw new Error(`Extension page target is no longer available: ${info.url}`);
  return { ...info, type: info.type, page };
}

function normalizeSelector(
  selector: string | ExtensionTargetSelector,
): ExtensionTargetSelector {
  return typeof selector === "string" ? { id: selector } : selector;
}

function matches(info: ExtensionTargetInfo, selector: ExtensionTargetSelector): boolean {
  return (
    (selector.id === undefined || selector.id === info.id) &&
    (selector.path === undefined || normalizePath(selector.path) === info.path) &&
    (selector.type === undefined || selector.type === info.type)
  );
}

function normalizePath(path: string): string {
  return decodePath(path.replace(/^\/+/, "").split(/[?#]/, 1)[0]!);
}

function decodePath(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

function isExtensionTargetType(type: string): type is ExtensionTargetType {
  return [
    "page",
    "background_page",
    "service_worker",
    "shared_worker",
    "webview",
    "other",
  ].includes(type);
}

function isWorkerType(type: ExtensionTargetType): type is "service_worker" | "shared_worker" {
  return type === "service_worker" || type === "shared_worker";
}

function isPageType(type: ExtensionTargetType): type is "page" | "background_page" | "webview" {
  return type === "page" || type === "background_page" || type === "webview";
}

function toExtensionTargetInfo(target: Target): ExtensionTargetInfo | null {
  const url = target.url();
  const parsed = parseExtensionUrl(url);
  const type = target.type() as string;
  if (!parsed || !isExtensionTargetType(type)) return null;
  return { id: parsed.id, path: parsed.path, url, type, target };
}
