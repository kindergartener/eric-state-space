(function () {
  "use strict";

  if (!window.matchMedia || !window.matchMedia("(hover: hover) and (pointer: fine)").matches) {
    return;
  }

  var hint = null;

  function ensureHint() {
    if (hint) return hint;
    hint = document.createElement("div");
    hint.className = "zoomable-hint";
    hint.textContent = "Click to enlarge";
    document.body.appendChild(hint);
    return hint;
  }

  function show(img) {
    var el = ensureHint();
    var rect = img.getBoundingClientRect();
    el.style.left = rect.left + window.scrollX + "px";
    el.style.top = rect.bottom + window.scrollY + "px";
    el.style.width = rect.width + "px";
    el.classList.add("visible");
  }

  function hide() {
    if (hint) hint.classList.remove("visible");
  }

  document.addEventListener("mouseenter", function (e) {
    if (e.target.matches && e.target.matches("img.zoomable")) show(e.target);
  }, true);

  document.addEventListener("mouseleave", function (e) {
    if (e.target.matches && e.target.matches("img.zoomable")) hide();
  }, true);
})();
