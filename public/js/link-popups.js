(function () {
  "use strict";

  var isHoverCapable = !!(
    window.matchMedia && window.matchMedia("(hover: hover) and (pointer: fine)").matches
  );

  var OPEN_DELAY_MS = 1000;
  var CLOSE_DELAY_MS = 400;
  var MARGIN_PX = 12;
  var SPAWN_OFFSET_PX = 32;
  var SVG_NS = "http://www.w3.org/2000/svg";

  var wikipediaCache = null;
  var contentCache = {};
  var popupsEnabled = localStorage.getItem("popups-enabled") !== "0";

  function escapeHtml(str) {
    var div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  function renderWikipedia(entry) {
    var html = "";
    if (entry.thumbnail) {
      html += '<img src="' + entry.thumbnail + '" alt="">';
    }
    html += '<div class="wikipedia-popup-body">';
    html += '<p class="wikipedia-popup-title">' + escapeHtml(entry.title) + "</p>";
    html += '<p class="wikipedia-popup-extract">' + escapeHtml(entry.extract) + "</p>";
    html += '<p class="wikipedia-popup-source">Wikipedia</p>';
    html += "</div>";
    return html;
  }

  // Pulls the markup that the target page renders into <main>, leaving out the
  // nav/footer and any scripts.
  function rewriteFragmentLinks(root, baseUrl) {
    root.querySelectorAll('a[href^="#"]').forEach(function (a) {
      a.setAttribute("href", baseUrl + a.getAttribute("href"));
    });
  }

  function extractPreviewContent(doc, baseUrl) {
    var main = doc.querySelector("main");
    if (!main) return null;

    // Skip toc and nav for <article> page templates
    var article = main.querySelector(":scope > article");
    if (article) {
      var wrap = document.createElement("div");
      wrap.appendChild(article.cloneNode(true));
      rewriteFragmentLinks(wrap, baseUrl);
      return wrap;
    }

    // Templates with no <article> take all elements
    var skipIds = { navbar: true, footer: true, "page-toc": true };
    var container = document.createElement("div");
    Array.prototype.forEach.call(main.children, function (el) {
      if (skipIds[el.id]) return;
      var tag = el.tagName;
      if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT" || tag === "SVG") return;
      container.appendChild(el.cloneNode(true));
    });

    if (!container.children.length) return null;
    rewriteFragmentLinks(container, baseUrl);
    return container;
  }

  function fetchPreviewContent(url) {
    if (contentCache[url]) return contentCache[url];

    var promise = fetch(url)
      .then(function (resp) {
        if (!resp.ok) throw new Error("preview fetch failed");
        return resp.text();
      })
      .then(function (html) {
        var doc = new DOMParser().parseFromString(html, "text/html");
        return extractPreviewContent(doc, url);
      })
      .catch(function () {
        return null;
      });

    contentCache[url] = promise;
    return promise;
  }

  function makeIcon(symbolId, viewBox) {
    var icon = document.createElementNS(SVG_NS, "svg");
    icon.setAttribute("class", "link-popup-icon");
    icon.setAttribute("viewBox", viewBox);
    icon.setAttribute("aria-hidden", "true");
    var use = document.createElementNS(SVG_NS, "use");
    use.setAttribute("href", "#" + symbolId);
    icon.appendChild(use);
    return icon;
  }

  // These elements get NO popup
  function isFullySkipped(link) {
    if (link.classList.contains("blog-more-label")) return true;
    if (link.closest("h1, h2, h3, h4, h5, h6, .curio-tile")) return true;
    return false;
  }

  // These elements get the popup without the underline + icon decor
  function isDecorationSuppressed(link) {
    return !!(
      link.closest("#navbar, #footer, #page-toc, .bento-title, .button-tile, .tag-pyramid, .page-tags") ||
      link.classList.contains("blog-post-title") ||
      link.classList.contains("tags-link")
    );
  }

  // Fix nav links
  function normalizedPathname(pathname) {
    return pathname.length > 1 ? pathname.replace(/\/$/, "") : pathname;
  }

  function resolveInternalUrl(link) {
    var href = link.getAttribute("href");
    if (!href || href.indexOf("#") === 0) return null;

    var url;
    try {
      url = new URL(href, window.location.href);
    } catch (e) {
      return null;
    }

    if (url.origin !== window.location.origin) return null;
    if (
      normalizedPathname(url.pathname) === normalizedPathname(window.location.pathname) &&
      url.search === window.location.search
    ) {
      return null;
    }

    return url.href;
  }

  // Nested popups functionality
  function createPopupController(parent) {
    var popup = null;
    var openTimer = null;
    var closeTimer = null;
    var activeLink = null;
    var childController = null;

    function ensurePopup() {
      if (popup) return popup;
      popup = document.createElement("div");
      popup.className = "link-popup";
      popup.addEventListener("mouseenter", cancelClose);
      popup.addEventListener("mouseleave", scheduleClose);
      document.body.appendChild(popup);
      return popup;
    }

    function position(spawnPoint) {
      var popupRect = popup.getBoundingClientRect();

      var left = spawnPoint.x - popupRect.width / 2;
      left = Math.max(MARGIN_PX, Math.min(left, window.innerWidth - popupRect.width - MARGIN_PX));

      var top = spawnPoint.y + SPAWN_OFFSET_PX;
      if (top + popupRect.height > window.innerHeight - MARGIN_PX) {
        top = spawnPoint.y - popupRect.height - SPAWN_OFFSET_PX;
      }

      popup.style.left = left + window.scrollX + "px";
      popup.style.top = top + window.scrollY + "px";
    }

    function open(link, payload, spawnPoint) {
      ensurePopup();
      activeLink = link;
      if (childController) {
        childController.closeAll();
        childController = null;
      }
      popup.classList.remove("wikipedia-variant", "preview-variant", "loading");

      if (payload.kind === "preview") {
        popup.classList.add("preview-variant", "loading");
        popup.innerHTML = "";
        popup.classList.add("open");
        position(spawnPoint);

        fetchPreviewContent(payload.url).then(function (content) {
          if (activeLink !== link) return; // link changed or popup closed while fetching
          popup.classList.remove("loading");
          popup.innerHTML = "";
          if (content) {
            var cloned = content.cloneNode(true);
            popup.appendChild(cloned);
            childController = createPopupController(controller);
            childController.wireAll(popup);
          } else {
            popup.innerHTML = '<p class="link-popup-error">Preview unavailable.</p>';
          }
        });
      } else {
        popup.classList.add("wikipedia-variant");
        popup.innerHTML = renderWikipedia(payload.entry);
        popup.classList.add("open");
        position(spawnPoint);
      }
    }

    function close() {
      if (childController) {
        childController.closeAll();
        childController = null;
      }
      if (!popup) return;
      popup.classList.remove("open", "loading");
      popup.innerHTML = "";
      activeLink = null;
    }

    // Closing cascades to any nested popup spawned from this one's content
    function closeAll() {
      close();
    }

    // Entering any popup in the chain must keep every ancestor open too
    function cancelClose() {
      if (closeTimer) {
        clearTimeout(closeTimer);
        closeTimer = null;
      }
      if (parent) parent.cancelClose();
    }

    // Leaving any popup in the chain schedules that popup unless a fresh hover
    // cancels it again
    function scheduleClose() {
      cancelClose();
      closeTimer = setTimeout(close, CLOSE_DELAY_MS);
      if (parent) parent.scheduleClose();
    }

    function scheduleOpen(link, payload, spawnPoint) {
      if (!popupsEnabled) return;
      cancelClose();
      if (openTimer) clearTimeout(openTimer);
      openTimer = setTimeout(function () {
        open(link, payload, spawnPoint);
      }, OPEN_DELAY_MS);
    }

    function cancelOpen() {
      if (openTimer) {
        clearTimeout(openTimer);
        openTimer = null;
      }
    }

    function wireWikipediaLinks(root) {
      if (!wikipediaCache) return;
      var links = root.querySelectorAll('a[href*="wikipedia.org/wiki/"]');
      links.forEach(function (link) {
        if (link.dataset.popupWired) return;
        var entry = wikipediaCache[link.href];
        if (!entry) return;
        if (isFullySkipped(link)) return;

        link.dataset.popupWired = "1";
        if (!isDecorationSuppressed(link)) {
          link.classList.add("link-popup-ready");
          link.appendChild(makeIcon("wikipedia-icon", "0 0 1700 1700"));
        }

        if (!isHoverCapable) return;

        link.addEventListener("mouseenter", function (event) {
          scheduleOpen(link, { kind: "wikipedia", entry: entry }, { x: event.clientX, y: event.clientY });
        });
        link.addEventListener("mouseleave", function () {
          cancelOpen();
          if (activeLink === link) scheduleClose();
        });
      });
    }

    function wireInternalLinks(root) {
      var links = root.querySelectorAll("a[href]");
      links.forEach(function (link) {
        if (link.dataset.popupWired) return;
        if (isFullySkipped(link)) return;

        var url = resolveInternalUrl(link);
        if (!url) return;

        link.dataset.popupWired = "1";
        if (!isDecorationSuppressed(link)) {
          link.classList.add("link-popup-ready");
          link.appendChild(makeIcon("site-logo-icon", "0 0 57 56"));
        }

        if (!isHoverCapable) return;

        link.addEventListener("mouseenter", function (event) {
          scheduleOpen(link, { kind: "preview", url: url }, { x: event.clientX, y: event.clientY });
        });
        link.addEventListener("mouseleave", function () {
          cancelOpen();
          if (activeLink === link) scheduleClose();
        });
      });
    }

    function wireAll(root) {
      wireInternalLinks(root);
      wireWikipediaLinks(root);
    }

    var controller = {
      wireAll: wireAll,
      wireWikipediaLinks: wireWikipediaLinks,
      closeAll: closeAll,
      cancelClose: cancelClose,
      scheduleClose: scheduleClose,
    };
    return controller;
  }

  var rootController = createPopupController(null);

  if (isHoverCapable) {
    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape") rootController.closeAll();
    });

    // Fallback behavior for popup closing
    document.addEventListener("click", function (event) {
      if (event.target.closest && event.target.closest(".link-popup.open")) return;
      rootController.closeAll();
    });

    window.addEventListener("blur", function () {
      rootController.closeAll();
    });

    var popupToggle = document.getElementById("popup-toggle");
    var popupToggleIcon = document.getElementById("popup-toggle-icon");
    if (popupToggle && popupToggleIcon) {
      popupToggle.hidden = false;
      var syncPopupToggle = function () {
        var state = popupsEnabled ? "on" : "off";
        popupToggleIcon.setAttribute("href", "#popup-icon-" + state);
        popupToggle.setAttribute("title", "Link popups: " + state);
        popupToggle.setAttribute("aria-label", "Toggle link popups (currently " + state + ")");
      };
      syncPopupToggle();
      popupToggle.addEventListener("click", function () {
        popupsEnabled = !popupsEnabled;
        localStorage.setItem("popups-enabled", popupsEnabled ? "1" : "0");
        if (!popupsEnabled) rootController.closeAll();
        syncPopupToggle();
      });
    }
  }

  rootController.wireAll(document);

  fetch("/wikipedia_cache.json")
    .then(function (resp) {
      if (!resp.ok) throw new Error("wikipedia cache not available");
      return resp.json();
    })
    .then(function (data) {
      wikipediaCache = data;
      rootController.wireWikipediaLinks(document);
    })
    .catch(function () {
      // Links just behave as normal links.
    });
})();
