// Below the phone breakpoint, #bento-box is a plain stacked flex column.
// Between phone and tablet, curios and links share one grid row. At or above
// tablet, blog spans three rows beside a curios row, a guestbook row, and a
// links row stacked in the same column.

(function () {
  "use strict";

  var bentoBox = document.getElementById("bento-box");
  var linksCell = document.getElementById("bento-links");
  var curiosCell = document.getElementById("bento-curios");
  var guestbookCell = document.getElementById("bento-guestbook");
  var blogCell = document.getElementById("bento-blog");
  if (!linksCell || !curiosCell) return;

  var MOBILE_QUERY = "(max-width: 599px)";
  var DESKTOP_QUERY = "(min-width: 900px)";

  function naturalCellHeight(cell, contentEl) {
    if (!cell) return 0;
    if (!contentEl) return cell.offsetHeight;
    var titlebar = cell.querySelector(".bento-titlebar");
    var borders = cell.offsetHeight - cell.clientHeight;
    return (titlebar ? titlebar.offsetHeight : 0) + contentEl.offsetHeight + borders;
  }

  function fit() {
    if (window.matchMedia(MOBILE_QUERY).matches) {
      linksCell.style.height = "";
    } else {
      linksCell.style.height = "0px";

      var isDesktop = window.matchMedia(DESKTOP_QUERY).matches;
      var height;

      if (isDesktop && blogCell) {
        var gap = bentoBox ? parseFloat(getComputedStyle(bentoBox).rowGap) || 0 : 0;
        var blogHeight = naturalCellHeight(blogCell, blogCell.querySelector(".blog-list"));
        var guestbookHeight = guestbookCell ? guestbookCell.offsetHeight : 0;
        height = blogHeight - curiosCell.offsetHeight - guestbookHeight - gap * 2;
      } else {
        height = curiosCell.offsetHeight;
      }

      linksCell.style.height = height > 0 ? height + "px" : "";
    }
  }

  fit();
  window.addEventListener("resize", fit);
})();
