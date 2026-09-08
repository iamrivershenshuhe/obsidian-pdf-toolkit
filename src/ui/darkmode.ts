import { hexToRgb } from "../util";

/*
 * Dark mode for PDF pages by *recoloring* instead of inverting:
 * black → text color, white → background color, greys interpolated linearly.
 * Implemented as SVG feComponentTransfer filters referenced from CSS (filter: url(#id)).
 * Anti-aliased glyph edges map to in-between tones, so there is no fringing halo.
 */

const HOST_ID = "pdftk-filters";
export const FILTER_DARK = "pdftk-filter-dark";
export const FILTER_SOFT = "pdftk-filter-soft";

function clamp01(n: number) {
  return Math.min(1, Math.max(0, n));
}

function mix(a: number, b: number, k: number) {
  return a + (b - a) * k;
}

function table(text: number, bg: number) {
  return `${clamp01(text).toFixed(4)} ${clamp01(bg).toFixed(4)}`;
}

function filterDef(id: string, bg: { r: number; g: number; b: number }, text: { r: number; g: number; b: number }) {
  // input 0 (black ink) → text color, input 1 (white paper) → background
  return (
    `<filter id="${id}" color-interpolation-filters="sRGB">` +
    `<feComponentTransfer>` +
    `<feFuncR type="table" tableValues="${table(text.r, bg.r)}"/>` +
    `<feFuncG type="table" tableValues="${table(text.g, bg.g)}"/>` +
    `<feFuncB type="table" tableValues="${table(text.b, bg.b)}"/>` +
    `</feComponentTransfer>` +
    `</filter>`
  );
}

/** Create or update the filter definitions in the document. */
export function ensureDarkFilters(bgHex: string, textHex: string) {
  const bg = hexToRgb(bgHex || "#1f1f1f");
  const text = hexToRgb(textHex || "#c3c2b7");
  // soft: same background, text pulled ~18% toward the background for lower contrast
  const softText = { r: mix(text.r, bg.r, 0.18), g: mix(text.g, bg.g, 0.18), b: mix(text.b, bg.b, 0.18) };
  const softBg = { r: mix(bg.r, text.r, 0.03), g: mix(bg.g, text.g, 0.03), b: mix(bg.b, text.b, 0.03) };

  let host = document.getElementById(HOST_ID) as SVGSVGElement | null;
  if (!host) {
    host = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    host.id = HOST_ID;
    host.setAttribute("aria-hidden", "true");
    host.setAttribute("style", "position:absolute;width:0;height:0;overflow:hidden;pointer-events:none");
    document.body.appendChild(host);
  }
  host.innerHTML = `<defs>${filterDef(FILTER_DARK, bg, text)}${filterDef(FILTER_SOFT, softBg, softText)}</defs>`;
}

export function removeDarkFilters() {
  document.getElementById(HOST_ID)?.remove();
}
