// Minimal browser polyfill for node:async_hooks AsyncLocalStorage. The SDK is
// switched to the globalThis carrier at runtime, so this only needs to satisfy
// the module-load `new AsyncLocalStorage()` without throwing.
export class AsyncLocalStorage {
  constructor() {
    this._store = undefined;
  }
  getStore() {
    return this._store;
  }
  run(store, fn, ...args) {
    const prev = this._store;
    this._store = store;
    try {
      const r = fn(...args);
      if (r && typeof r.then === "function") {
        return Promise.resolve(r).finally(() => {
          this._store = prev;
        });
      }
      this._store = prev;
      return r;
    } catch (e) {
      this._store = prev;
      throw e;
    }
  }
  enterWith(store) {
    this._store = store;
  }
  exit(fn, ...args) {
    const prev = this._store;
    this._store = undefined;
    try {
      return fn(...args);
    } finally {
      this._store = prev;
    }
  }
}
export default { AsyncLocalStorage };
