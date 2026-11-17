// The red dot on the browser tab's favicon (doctor queue notifications). The dot is drawn once on a
// canvas over the page's own favicon (the office logo stays recognizable), swapped in only while
// asked for, and the original favicon href is put back afterwards. The favicon file and the
// <link rel="icon"> in pages/_document.js are never changed permanently.
//
// Every browser API may be missing or fail (no canvas, image error, an older browser): the dot is
// then simply not shown, and the bell, toast and tab title keep working.

export const FAVICON_DOT_COLOR = "#dc2626";
export const FAVICON_SIZE = 64; // pages/_document.js declares the favicon as 64x64
const DOT_RADIUS = 13; // about 6-7px across in Chrome's 16px tab icon
const DOT_GAP = 3; // a transparent ring keeps the dot readable on light and dark tab strips

const ICON_SELECTOR = 'link[rel~="icon"]';

// Draws the favicon with the dot in its top-right corner.
export function drawFaviconDot(ctx, image, size = FAVICON_SIZE) {
  const scale = size / FAVICON_SIZE;
  const radius = DOT_RADIUS * scale;
  const cx = size - radius - scale;
  const cy = radius + scale;
  ctx.clearRect(0, 0, size, size);
  ctx.drawImage(image, 0, 0, size, size);
  ctx.globalCompositeOperation = "destination-out";
  ctx.beginPath();
  ctx.arc(cx, cy, radius + DOT_GAP * scale, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalCompositeOperation = "source-over";
  ctx.fillStyle = FAVICON_DOT_COLOR;
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.fill();
}

// One controller per page that shows the dot. show(true/false) only touches the <link> when the
// state actually changes; the dotted image is generated once and reused. dispose() restores the
// original favicon (on unmount, page navigation or sign-out).
export function createFaviconBadge(doc) {
  let originals = null; // [link, original href] pairs while the dot is shown
  let dotUrl = null;
  let state = "idle"; // idle | loading | ready | failed
  let wanted = false;
  let disposed = false;

  const iconLinks = () => {
    try { return Array.from(doc?.querySelectorAll?.(ICON_SELECTOR) || []); } catch { return []; }
  };

  function apply() {
    if (disposed) return;
    try {
      if (wanted && dotUrl && !originals) {
        const links = iconLinks();
        if (!links.length) return;
        originals = links.map((link) => [link, link.getAttribute("href")]);
        links.forEach((link) => link.setAttribute("href", dotUrl));
      } else if (!wanted && originals) {
        const saved = originals;
        originals = null;
        saved.forEach(([link, href]) => (href == null ? link.removeAttribute("href") : link.setAttribute("href", href)));
      }
    } catch { /* the favicon stays as it is */ }
  }

  function generate() {
    state = "loading";
    try {
      // The original favicon (same origin, so the canvas can be read back). Read before any swap.
      const source = iconLinks()[0]?.href;
      if (!source) { state = "failed"; return; }
      const image = doc.createElement("img");
      image.onload = () => {
        try {
          const canvas = doc.createElement("canvas");
          canvas.width = FAVICON_SIZE;
          canvas.height = FAVICON_SIZE;
          drawFaviconDot(canvas.getContext("2d"), image);
          dotUrl = canvas.toDataURL("image/png");
          state = "ready";
        } catch {
          state = "failed";
        }
        apply();
      };
      image.onerror = () => { state = "failed"; };
      image.src = source;
    } catch {
      state = "failed";
    }
  }

  return {
    show(on) {
      if (disposed) return;
      wanted = Boolean(on);
      if (wanted && state === "idle") generate();
      apply();
    },
    dispose() {
      wanted = false;
      apply();
      disposed = true;
    }
  };
}
