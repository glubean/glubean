document.querySelector("#enabled")?.addEventListener("change", (event) => {
  document.documentElement.dataset.enabled = String(event.target.checked);
});
