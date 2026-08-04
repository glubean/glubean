window.addEventListener("message", (event) => {
  if (event.source !== window || event.data?.__fixture !== "ping") return;
  window.postMessage({ __fixture: "response", id: event.data.id }, "*");
});

document.documentElement.dataset.extensionReady = "true";
window.postMessage({ __fixture: "ready", version: "1.0.0" }, "*");
