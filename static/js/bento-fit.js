// Blog "more" link: CSS handles the actual height-matching (#bento-box has
// a fixed max-height, #bento-blog spans all three rows of the right column
// and stretches to fill that span by default via grid item align-self:
// stretch, and min-height: 0 down the #bento-blog -> .bento-content ->
// .blog-list chain stops each level's own intrinsic content size from
// inflating its container instead of accepting the stretched height). This
// only needs to reveal the "more" link when that clipping actually happened.
(function () {
  "use strict";

  var blogCell = document.getElementById("bento-blog");
  var blogList = blogCell ? blogCell.querySelector(".blog-list") : null;
  var moreFooter = blogCell ? blogCell.querySelector(".bento-more-footer") : null;
  if (!blogList || !moreFooter) return;

  function fitBlog() {
    moreFooter.hidden = blogList.scrollHeight <= blogList.clientHeight;
  }

  fitBlog();
  window.addEventListener("resize", fitBlog);
})();

// Links vs. curios, phone/tablet layout only: curios and links share one
// grid row there (not a multi-row span like blog), and CSS Grid always
// sizes an "auto" row to fit its tallest participant -- there's no native
// way to make the row shrink to the shorter sibling instead. Clip links to
// curios's natural height explicitly.
(function () {
  "use strict";

  var linksCell = document.getElementById("bento-links");
  var curiosCell = document.getElementById("bento-curios");
  if (!linksCell || !curiosCell) return;

  var TABLET_ROW_QUERY = "(min-width: 600px) and (max-width: 899px)";

  function fitLinks() {
    if (window.matchMedia(TABLET_ROW_QUERY).matches) {
      linksCell.style.height = curiosCell.offsetHeight + "px";
    } else {
      linksCell.style.height = "";
    }
  }

  fitLinks();
  window.addEventListener("resize", fitLinks);
})();
