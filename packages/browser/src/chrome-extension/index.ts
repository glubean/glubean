export {
  resolveExtensionPagePath,
  resolveUnpackedExtension,
  resolveUnpackedExtensions,
} from "./manifest.js";
export type {
  ChromeExtensionManifest,
  ExtensionPageKind,
  UnpackedExtension,
} from "./manifest.js";

export { extensionLaunchOptions } from "./launch.js";
export type { ExtensionLaunchOverrides } from "./launch.js";

export { createExtensionTest } from "./test.js";
export type { ChromeExtensionTestOptions } from "./test.js";

export {
  extensionPageUrl,
  findExtensionTarget,
  listExtensionTargets,
  parseExtensionUrl,
  waitForExtensionPage,
  waitForExtensionTarget,
  waitForExtensionWorker,
} from "./targets.js";
export type {
  ExtensionPageInfo,
  ExtensionTargetInfo,
  ExtensionTargetSelector,
  ExtensionTargetType,
  ExtensionWorkerInfo,
} from "./targets.js";

export { installExtensionReadyWatcher } from "./ready.js";
export type { ExtensionReadyEvent, ExtensionReadyWatcher } from "./ready.js";

export {
  closeExtensionSidePanel,
  getInstalledExtension,
  triggerExtensionAction,
  waitForExtensionOwnedPage,
  waitForExtensionPageClosed,
} from "./actions.js";
export type {
  InstalledExtensionSelector,
  InstalledExtensionWaitOptions,
} from "./actions.js";
