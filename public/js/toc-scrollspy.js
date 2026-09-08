(function () {
  "use strict";

  var toc = document.getElementById("page-toc");
  if (!toc) return;

  var headings = document.querySelectorAll(".markdown-body h1[id], .markdown-body h2[id]");
  if (!headings.length) return;

  var topLink = toc.querySelector(".toc-list > li:first-child > a");
  var links = {};
  toc.querySelectorAll(".toc-list a[href*='#']").forEach(function (link) {
    var id = decodeURIComponent(link.hash.slice(1));
    if (id) links[id] = link;
  });

  var label = toc.querySelector(".toc-label");
  var STICK_OFFSET = 24;
  var alignedTop = null;

  function computeAlignedTop() {
    if (!label || getComputedStyle(toc).display === "none") return;
    var labelOffset = label.getBoundingClientRect().bottom - toc.getBoundingClientRect().top;
    alignedTop = headings[0].getBoundingClientRect().bottom + window.scrollY - labelOffset;
    updateStickyPosition();
  }

  function reveal() {
    toc.classList.add("toc-ready");
  }

  function updateStickyPosition() {
    if (alignedTop === null) return;
    toc.style.top = Math.max(STICK_OFFSET, alignedTop - window.scrollY) + "px";
  }

  var TRIGGER_LINE = 0;
  var active = null;

  function setActive(link) {
    if (link === active) return;
    if (active) active.classList.remove("toc-active");
    if (link) link.classList.add("toc-active");
    active = link;
  }

  function update() {
    var current = null;
    for (var i = 0; i < headings.length; i++) {
      if (headings[i].getBoundingClientRect().top <= TRIGGER_LINE) {
        current = headings[i];
      } else {
        break;
      }
    }
    setActive(current ? links[current.id] || null : topLink);
  }

  var ticking = false;
  function onScroll() {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(function () {
      update();
      updateStickyPosition();
      ticking = false;
    });
  }

  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", onScroll);
  window.addEventListener("resize", computeAlignedTop);
  computeAlignedTop();
  update();

  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(function () {
      computeAlignedTop();
      reveal();
    });
  } else {
    reveal();
  }
})();
