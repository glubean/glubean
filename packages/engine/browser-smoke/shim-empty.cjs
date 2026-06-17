// Stub for node builtins the browser test path must never call (fs/path/url/
// http/crypto). A Proxy satisfies any named import; calling one throws loudly.
module.exports = new Proxy(
  {},
  {
    get(_t, prop) {
      if (prop === "__esModule") return true;
      if (prop === "default") return module.exports;
      return () => {
        throw new Error(`[glubean-harness] node builtin "${String(prop)}" is not available in the browser`);
      };
    },
  },
);
