(function () {
  var overlay, lightboxImg;

  function ensureOverlay() {
    if (overlay) return;
    overlay = document.createElement("div");
    overlay.id = "lightbox-overlay";
    lightboxImg = document.createElement("img");
    lightboxImg.id = "lightbox-img";
    overlay.appendChild(lightboxImg);
    document.body.appendChild(overlay);
    overlay.addEventListener("click", close);
  }

  function open(src, alt) {
    ensureOverlay();
    lightboxImg.src = src;
    lightboxImg.alt = alt || "";
    overlay.classList.add("open");
    document.body.classList.add("lightbox-locked");
  }

  function close() {
    if (!overlay) return;
    overlay.classList.remove("open");
    document.body.classList.remove("lightbox-locked");
  }

  document.addEventListener("click", function (e) {
    var target = e.target.closest && e.target.closest("img.zoomable");
    if (!target) return;
    open(target.currentSrc || target.src, target.alt);
  });

  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") close();
  });
})();
