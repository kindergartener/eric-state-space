(function () {
  "use strict";

  var DRAG_THRESHOLD_PX = 8;

  function initMarquee(container) {
    var track = container.querySelector(".marquee-track");
    if (!track || track.children.length === 0) return;

    var speed = parseFloat(container.dataset.speed);
    if (!isFinite(speed)) speed = 40;

    var originalChildren = Array.prototype.slice.call(track.children);
    var period = track.scrollWidth;
    if (period === 0) return;

    function ensureCoverage() {
      var needed = container.clientWidth + period;
      var guard = 0;
      while (track.scrollWidth < needed && guard < 50) {
        originalChildren.forEach(function (child) {
          var clone = child.cloneNode(true);
          clone.setAttribute("aria-hidden", "true");
          clone.setAttribute("tabindex", "-1");
          track.appendChild(clone);
        });
        guard++;
      }
    }

    ensureCoverage();
    window.addEventListener("resize", ensureCoverage);

    container.addEventListener("dragstart", function (e) {
      e.preventDefault();
    });

    var position = 0;
    var dragging = false;
    var dragMoved = false;
    var dragStartX = 0;
    var dragStartY = 0;
    var dragStartPosition = 0;
    var hoverPaused = false;
    var pressedLink = null;
    var lastTime = null;
    var reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    function wrap(value) {
      return ((value % period) + period) % period;
    }

    function frame(timestamp) {
      if (lastTime === null) lastTime = timestamp;
      var dt = (timestamp - lastTime) / 1000;
      lastTime = timestamp;

      if (!dragging && !hoverPaused && !reducedMotion) {
        position = wrap(position + speed * dt);
      }

      track.style.transform = "translateX(" + -position + "px)";
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);

    container.addEventListener("pointerenter", function (e) {
      if (e.pointerType === "mouse") hoverPaused = true;
    });
    container.addEventListener("pointerleave", function (e) {
      if (e.pointerType === "mouse") hoverPaused = false;
    });

    container.addEventListener("pointerdown", function (e) {
      if (e.button > 0) return;
      dragging = true;
      dragMoved = false;
      dragStartX = e.clientX;
      dragStartY = e.clientY;
      dragStartPosition = position;
      pressedLink = e.target.closest("a.button-tile");
      container.classList.add("is-dragging");
      container.setPointerCapture(e.pointerId);
    });

    container.addEventListener("pointermove", function (e) {
      if (!dragging) return;
      var dx = e.clientX - dragStartX;
      var dy = e.clientY - dragStartY;
      if (Math.hypot(dx, dy) > DRAG_THRESHOLD_PX) dragMoved = true;
      position = wrap(dragStartPosition - dx);
    });

    function endDrag(e) {
      if (!dragging) return;
      dragging = false;
      container.classList.remove("is-dragging");
      if (!dragMoved && pressedLink) {
        window.open(pressedLink.href, "_blank", "noopener,noreferrer");
      }
      pressedLink = null;
    }
    container.addEventListener("pointerup", endDrag);
    container.addEventListener("pointercancel", function () {
      dragging = false;
      container.classList.remove("is-dragging");
      pressedLink = null;
    });

    track.addEventListener(
      "click",
      function (e) {
        if (e.target.closest("a.button-tile")) e.preventDefault();
      },
      true
    );
  }

  function init() {
    document.querySelectorAll(".button-marquee").forEach(initMarquee);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
