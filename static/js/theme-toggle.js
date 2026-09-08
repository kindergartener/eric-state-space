(function () {
  "use strict";

  var STORAGE_KEY = "theme-mode";

  var button = document.getElementById("theme-toggle");
  var icon = document.getElementById("theme-toggle-icon");
  var gialloLight = document.getElementById("giallo-light");
  var gialloDark = document.getElementById("giallo-dark");
  if (!button || !icon) return;

  function getMode() {
    return localStorage.getItem(STORAGE_KEY) === "dark" ? "dark" : "light";
  }

  function apply(mode) {
    document.documentElement.setAttribute("data-theme", mode);
    if (gialloLight) gialloLight.disabled = mode !== "light";
    if (gialloDark) gialloDark.disabled = mode !== "dark";
    icon.setAttribute("href", "#theme-icon-" + mode);
    button.setAttribute("title", "Theme: " + mode);
    button.setAttribute("aria-label", "Toggle color theme (currently " + mode + ")");
  }

  apply(getMode());

  button.addEventListener("click", function () {
    var next = getMode() === "dark" ? "light" : "dark";
    localStorage.setItem(STORAGE_KEY, next);
    apply(next);
  });
})();
