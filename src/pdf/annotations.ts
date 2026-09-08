import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFRef, PDFString } from "@cantoo/pdf-lib";
import { FontProvider, pickFont } from "./ops";

/*
 * Write real PDF annotations (with appearance streams so every viewer,
 * including Obsidian's pdf.js, renders them) into a pdf-lib document.
 * Coordinates are PDF user-space points (origin bottom-left).
 */

export interface RGB {
  r: number;
  g: number;
  b: number;
}

/** Upper-left, upper-right, lower-left, lower-right — PDF QuadPoints order. */
export interface Quad {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  x3: number;
  y3: number;
  x4: number;
  y4: number;
}

export interface AnnotMeta {
  author: string;
  contents?: string;
}

export type MarkupKind = "Highlight" | "Underline" | "StrikeOut";
export type ShapeKind = "Square" | "Circle";

const f = (n: number) => String(Math.round(n * 1000) / 1000);
const col = (c: RGB) => `${f(c.r)} ${f(c.g)} ${f(c.b)}`;

function pdfDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `D:${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function newId(): string {
  return `pdftk-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function bbox(points: number[]): [number, number, number, number] {
  let x1 = Infinity,
    y1 = Infinity,
    x2 = -Infinity,
    y2 = -Infinity;
  for (let i = 0; i < points.length; i += 2) {
    x1 = Math.min(x1, points[i]);
    x2 = Math.max(x2, points[i]);
    y1 = Math.min(y1, points[i + 1]);
    y2 = Math.max(y2, points[i + 1]);
  }
  return [x1, y1, x2, y2];
}

function pad(r: [number, number, number, number], p: number): [number, number, number, number] {
  return [r[0] - p, r[1] - p, r[2] + p, r[3] + p];
}

interface BuildOptions {
  subtype: string;
  rect: [number, number, number, number];
  color: RGB;
  opacity: number;
  meta: AnnotMeta;
  /** appearance stream content (page user space) */
  ap: string;
  resources?: Record<string, unknown>;
  extra?: Record<string, unknown>;
  flags?: number;
}

function build(doc: PDFDocument, pageIndex: number, o: BuildOptions): string {
  const nm = newId();
  const now = PDFString.of(pdfDate(new Date()));
  const rect = o.rect.map((n) => Math.round(n * 1000) / 1000);
  const apStream = doc.context.stream(o.ap, {
    Type: "XObject",
    Subtype: "Form",
    FormType: 1,
    BBox: rect,
    Matrix: [1, 0, 0, 1, 0, 0],
    Resources: (o.resources ?? {}) as never,
  });
  const apRef = doc.context.register(apStream);
  const dict: Record<string, unknown> = {
    Type: "Annot",
    Subtype: o.subtype,
    Rect: rect,
    C: [o.color.r, o.color.g, o.color.b],
    CA: o.opacity,
    F: o.flags ?? 4,
    NM: PDFString.of(nm),
    M: now,
    CreationDate: now,
    T: PDFHexString.fromText(o.meta.author || ""),
    AP: { N: apRef },
    ...(o.extra ?? {}),
  };
  if (o.meta.contents) dict.Contents = PDFHexString.fromText(o.meta.contents);
  const ref = doc.context.register(doc.context.obj(dict as never));
  doc.getPage(pageIndex).node.addAnnot(ref);
  return nm;
}

/* ------------------------------------------------------------------ */
/* Text markup                                                          */
/* ------------------------------------------------------------------ */

export function addTextMarkup(
  doc: PDFDocument,
  pageIndex: number,
  quads: Quad[],
  kind: MarkupKind,
  color: RGB,
  opacity: number,
  meta: AnnotMeta,
): string {
  const pts: number[] = [];
  for (const q of quads) pts.push(q.x1, q.y1, q.x2, q.y2, q.x3, q.y3, q.x4, q.y4);
  const rect = pad(bbox(pts), 1);
  let ap = "";
  const resources: Record<string, unknown> = {};
  if (kind === "Highlight") {
    resources.ExtGState = { GS: { Type: "ExtGState", BM: "Multiply", CA: opacity, ca: opacity } };
    ap = `/GS gs ${col(color)} rg ` + quads.map((q) => `${f(q.x3)} ${f(q.y3)} m ${f(q.x4)} ${f(q.y4)} l ${f(q.x2)} ${f(q.y2)} l ${f(q.x1)} ${f(q.y1)} l h f`).join(" ");
  } else {
    resources.ExtGState = { GS: { Type: "ExtGState", CA: opacity, ca: opacity } };
    ap =
      `/GS gs ${col(color)} RG ` +
      quads
        .map((q) => {
          const h = Math.abs(q.y1 - q.y3);
          const lw = Math.max(0.8, h * 0.07);
          const y = kind === "Underline" ? Math.min(q.y3, q.y1) + lw : (q.y1 + q.y3) / 2;
          return `${f(lw)} w ${f(q.x3)} ${f(y)} m ${f(q.x4)} ${f(y)} l S`;
        })
        .join(" ");
  }
  return build(doc, pageIndex, {
    subtype: kind,
    rect,
    color,
    opacity,
    meta,
    ap,
    resources,
    extra: { QuadPoints: pts.map((n) => Math.round(n * 1000) / 1000) },
  });
}

/* ------------------------------------------------------------------ */
/* Ink (freehand)                                                       */
/* ------------------------------------------------------------------ */

export function addInk(
  doc: PDFDocument,
  pageIndex: number,
  paths: number[][],
  color: RGB,
  width: number,
  opacity: number,
  meta: AnnotMeta,
): string {
  const all = paths.flat();
  const rect = pad(bbox(all), width + 1);
  const ap =
    `/GS gs ${f(width)} w 1 J 1 j ${col(color)} RG ` +
    paths
      .map((p) => {
        if (p.length < 4) return `${f(p[0])} ${f(p[1])} m ${f(p[0])} ${f(p[1])} l S`;
        let s = `${f(p[0])} ${f(p[1])} m`;
        for (let i = 2; i < p.length; i += 2) s += ` ${f(p[i])} ${f(p[i + 1])} l`;
        return s + " S";
      })
      .join(" ");
  return build(doc, pageIndex, {
    subtype: "Ink",
    rect,
    color,
    opacity,
    meta,
    ap,
    resources: { ExtGState: { GS: { Type: "ExtGState", CA: opacity, ca: opacity } } },
    extra: { InkList: paths.map((p) => p.map((n) => Math.round(n * 1000) / 1000)), BS: { W: width, S: "S" } },
  });
}

/* ------------------------------------------------------------------ */
/* Shapes                                                               */
/* ------------------------------------------------------------------ */

export function addShape(
  doc: PDFDocument,
  pageIndex: number,
  box: [number, number, number, number],
  kind: ShapeKind,
  color: RGB,
  width: number,
  opacity: number,
  meta: AnnotMeta,
): string {
  const [ax, ay, bx, by] = box;
  const x1 = Math.min(ax, bx),
    y1 = Math.min(ay, by),
    x2 = Math.max(ax, bx),
    y2 = Math.max(ay, by);
  const rect: [number, number, number, number] = [x1, y1, x2, y2];
  const hw = width / 2;
  let ap = `/GS gs ${f(width)} w ${col(color)} RG `;
  if (kind === "Square") {
    ap += `${f(x1 + hw)} ${f(y1 + hw)} ${f(x2 - x1 - width)} ${f(y2 - y1 - width)} re S`;
  } else {
    const k = 0.5523;
    const cx = (x1 + x2) / 2,
      cy = (y1 + y2) / 2,
      rx = (x2 - x1) / 2 - hw,
      ry = (y2 - y1) / 2 - hw;
    ap +=
      `${f(cx + rx)} ${f(cy)} m ` +
      `${f(cx + rx)} ${f(cy + ry * k)} ${f(cx + rx * k)} ${f(cy + ry)} ${f(cx)} ${f(cy + ry)} c ` +
      `${f(cx - rx * k)} ${f(cy + ry)} ${f(cx - rx)} ${f(cy + ry * k)} ${f(cx - rx)} ${f(cy)} c ` +
      `${f(cx - rx)} ${f(cy - ry * k)} ${f(cx - rx * k)} ${f(cy - ry)} ${f(cx)} ${f(cy - ry)} c ` +
      `${f(cx + rx * k)} ${f(cy - ry)} ${f(cx + rx)} ${f(cy - ry * k)} ${f(cx + rx)} ${f(cy)} c h S`;
  }
  return build(doc, pageIndex, {
    subtype: kind,
    rect,
    color,
    opacity,
    meta,
    ap,
    resources: { ExtGState: { GS: { Type: "ExtGState", CA: opacity, ca: opacity } } },
    extra: { BS: { W: width, S: "S" } },
  });
}

/* ------------------------------------------------------------------ */
/* Sticky note                                                          */
/* ------------------------------------------------------------------ */

export const NOTE_SIZE = 20;

/**
 * Speech-bubble note icon, 20×20 pt with its top-left corner at (x, y).
 * Returned as path segments (PDF user space) so the same shape can be drawn
 * into the appearance stream and into the SVG live layer.
 */
export type PathSeg = ["m" | "l", number, number] | ["c", number, number, number, number, number, number] | ["h"];

export function noteIconPaths(x: number, y: number): { bubble: PathSeg[]; tail: PathSeg[]; lines: [number, number, number, number][] } {
  const x1 = x + 1,
    x2 = x + 19,
    y1 = y - 14, // bottom of bubble
    y2 = y - 1.5; // top of bubble
  const r = 3;
  const k = r * 0.5523;
  const bubble: PathSeg[] = [
    ["m", x1 + r, y1],
    ["l", x2 - r, y1],
    ["c", x2 - r + k, y1, x2, y1 + r - k, x2, y1 + r],
    ["l", x2, y2 - r],
    ["c", x2, y2 - r + k, x2 - r + k, y2, x2 - r, y2],
    ["l", x1 + r, y2],
    ["c", x1 + r - k, y2, x1, y2 - r + k, x1, y2 - r],
    ["l", x1, y1 + r],
    ["c", x1, y1 + r - k, x1 + r - k, y1, x1 + r, y1],
    ["h"],
  ];
  const tail: PathSeg[] = [["m", x + 5, y1 + 0.5], ["l", x + 4, y - 18.5], ["l", x + 10, y1 + 0.5], ["h"]];
  const lines: [number, number, number, number][] = [
    [x + 5, y - 5.5, x + 15, y - 5.5],
    [x + 5, y - 8.5, x + 15, y - 8.5],
    [x + 5, y - 11.5, x + 11.5, y - 11.5],
  ];
  return { bubble, tail, lines };
}

function segsToPdf(segs: PathSeg[]): string {
  return segs
    .map((s) => {
      if (s[0] === "h") return "h";
      if (s[0] === "m" || s[0] === "l") return `${f(s[1])} ${f(s[2])} ${s[0]}`;
      const b = s as ["c", number, number, number, number, number, number];
      return `${f(b[1])} ${f(b[2])} ${f(b[3])} ${f(b[4])} ${f(b[5])} ${f(b[6])} c`;
    })
    .join(" ");
}

export function addNote(doc: PDFDocument, pageIndex: number, x: number, y: number, color: RGB, meta: AnnotMeta): string {
  const s = NOTE_SIZE;
  const rect: [number, number, number, number] = [x, y - s, x + s, y];
  const icon = noteIconPaths(x, y);
  const ap =
    `${col(color)} rg 0.22 0.22 0.22 RG 0.9 w 1 j 1 J ` +
    `${segsToPdf(icon.tail)} B ` +
    `${segsToPdf(icon.bubble)} B ` +
    `0.22 0.22 0.22 RG 1.1 w ` +
    icon.lines.map(([ax, ay, bx, by]) => `${f(ax)} ${f(ay)} m ${f(bx)} ${f(by)} l S`).join(" ");
  return build(doc, pageIndex, {
    subtype: "Text",
    rect,
    color,
    opacity: 1,
    meta,
    ap,
    flags: 4 | 8 | 16, // Print + NoZoom + NoRotate
    extra: { Name: "Comment", Open: false },
  });
}

/* ------------------------------------------------------------------ */
/* Free text                                                            */
/* ------------------------------------------------------------------ */

export async function addFreeText(
  doc: PDFDocument,
  pageIndex: number,
  box: [number, number, number, number],
  text: string,
  fontSize: number,
  color: RGB,
  fonts: FontProvider,
  meta: AnnotMeta,
): Promise<string> {
  const font = await pickFont(doc, [text], fonts);
  const [ax, ay, bx, by] = box;
  const x1 = Math.min(ax, bx),
    x2 = Math.max(ax, bx);
  let y1 = Math.min(ay, by);
  const y2 = Math.max(ay, by);
  const padX = 3;
  const maxW = Math.max(20, x2 - x1 - padX * 2);
  const lines: string[] = [];
  for (const para of text.split(/\r?\n/)) {
    const words = para.split(/(\s+)/);
    let cur = "";
    for (const w of words) {
      const trial = cur + w;
      if (font.widthOfTextAtSize(trial, fontSize) <= maxW || !cur) {
        cur = trial;
        // very long token without spaces (e.g. CJK): break by character
        while (font.widthOfTextAtSize(cur, fontSize) > maxW && cur.length > 1) {
          let i = cur.length - 1;
          while (i > 1 && font.widthOfTextAtSize(cur.slice(0, i), fontSize) > maxW) i--;
          lines.push(cur.slice(0, i));
          cur = cur.slice(i);
        }
      } else {
        lines.push(cur.trimEnd());
        cur = w.trimStart();
      }
    }
    lines.push(cur.trimEnd());
  }
  const lead = fontSize * 1.25;
  const needH = lines.length * lead + 6;
  if (y2 - y1 < needH) y1 = y2 - needH;
  const rect: [number, number, number, number] = [x1, y1, x2, y2];
  const ap =
    `BT /F1 ${f(fontSize)} Tf ${col(color)} rg ${f(lead)} TL ${f(x1 + padX)} ${f(y2 - 3 - fontSize)} Td ` +
    lines.map((l) => `${font.encodeText(l).toString()} Tj T*`).join(" ") +
    " ET";
  return build(doc, pageIndex, {
    subtype: "FreeText",
    rect,
    color,
    opacity: 1,
    meta: { ...meta, contents: text },
    ap,
    resources: { Font: { F1: font.ref } },
    extra: { DA: PDFString.of(`/F1 ${f(fontSize)} Tf ${col(color)} rg`), Q: 0 },
  });
}

/* ------------------------------------------------------------------ */
/* Query / remove                                                       */
/* ------------------------------------------------------------------ */

export interface AnnotInfo {
  ref: PDFRef;
  subtype: string;
  rect: [number, number, number, number];
  nm?: string;
  contents?: string;
}

export function listAnnotations(doc: PDFDocument, pageIndex: number): AnnotInfo[] {
  const annots = doc.getPage(pageIndex).node.Annots();
  if (!annots) return [];
  const out: AnnotInfo[] = [];
  for (let i = 0; i < annots.size(); i++) {
    const el = annots.get(i);
    if (!(el instanceof PDFRef)) continue;
    const d = doc.context.lookupMaybe(el, PDFDict);
    if (!d) continue;
    const st = d.get(PDFName.of("Subtype"));
    const subtype = st instanceof PDFName ? st.decodeText() : "";
    if (subtype === "Link" || subtype === "Widget" || subtype === "Popup") continue;
    const r = d.lookupMaybe(PDFName.of("Rect"), PDFArray);
    if (!r || r.size() < 4) continue;
    const nums = r.asArray().map((n) => Number((n as { asNumber?: () => number }).asNumber?.() ?? 0));
    const rect: [number, number, number, number] = [
      Math.min(nums[0], nums[2]),
      Math.min(nums[1], nums[3]),
      Math.max(nums[0], nums[2]),
      Math.max(nums[1], nums[3]),
    ];
    const nmObj = d.get(PDFName.of("NM"));
    const cObj = d.get(PDFName.of("Contents"));
    out.push({
      ref: el,
      subtype,
      rect,
      nm: nmObj instanceof PDFString || nmObj instanceof PDFHexString ? nmObj.decodeText() : undefined,
      contents: cObj instanceof PDFString || cObj instanceof PDFHexString ? cObj.decodeText() : undefined,
    });
  }
  return out;
}

/** Annotations whose Rect contains (x, y), smallest first. */
export function annotationsAt(doc: PDFDocument, pageIndex: number, x: number, y: number, tolerance = 2): AnnotInfo[] {
  return listAnnotations(doc, pageIndex)
    .filter((a) => x >= a.rect[0] - tolerance && x <= a.rect[2] + tolerance && y >= a.rect[1] - tolerance && y <= a.rect[3] + tolerance)
    .sort((a, b) => (a.rect[2] - a.rect[0]) * (a.rect[3] - a.rect[1]) - (b.rect[2] - b.rect[0]) * (b.rect[3] - b.rect[1]));
}

export function removeAnnotation(doc: PDFDocument, pageIndex: number, match: { ref?: PDFRef; nm?: string }): boolean {
  const annots = doc.getPage(pageIndex).node.Annots();
  if (!annots) return false;
  for (let i = 0; i < annots.size(); i++) {
    const el = annots.get(i);
    if (!(el instanceof PDFRef)) continue;
    const d = doc.context.lookupMaybe(el, PDFDict);
    if (!d) continue;
    let hit = false;
    if (match.ref && el.objectNumber === match.ref.objectNumber && el.generationNumber === match.ref.generationNumber) hit = true;
    if (!hit && match.nm) {
      const nmObj = d.get(PDFName.of("NM"));
      if ((nmObj instanceof PDFString || nmObj instanceof PDFHexString) && nmObj.decodeText() === match.nm) hit = true;
    }
    if (!hit) continue;
    annots.remove(i);
    const popup = d.get(PDFName.of("Popup"));
    if (popup instanceof PDFRef) {
      for (let j = 0; j < annots.size(); j++) {
        const pe = annots.get(j);
        if (pe instanceof PDFRef && pe.objectNumber === popup.objectNumber) {
          annots.remove(j);
          break;
        }
      }
      doc.context.delete(popup);
    }
    doc.context.delete(el);
    return true;
  }
  return false;
}

/** Update the text (/Contents) of an existing annotation. */
export function setContents(doc: PDFDocument, pageIndex: number, match: { ref?: PDFRef; nm?: string }, text: string): boolean {
  const annots = doc.getPage(pageIndex).node.Annots();
  if (!annots) return false;
  for (let i = 0; i < annots.size(); i++) {
    const el = annots.get(i);
    if (!(el instanceof PDFRef)) continue;
    const d = doc.context.lookupMaybe(el, PDFDict);
    if (!d) continue;
    let hit = false;
    if (match.ref && el.objectNumber === match.ref.objectNumber && el.generationNumber === match.ref.generationNumber) hit = true;
    if (!hit && match.nm) {
      const nmObj = d.get(PDFName.of("NM"));
      if ((nmObj instanceof PDFString || nmObj instanceof PDFHexString) && nmObj.decodeText() === match.nm) hit = true;
    }
    if (!hit) continue;
    d.set(PDFName.of("Contents"), PDFHexString.fromText(text));
    d.set(PDFName.of("M"), PDFString.of(pdfDate(new Date())));
    return true;
  }
  return false;
}

/** Remove every non-link, non-widget annotation on the page. Returns count. */
export function clearAnnotations(doc: PDFDocument, pageIndex: number): number {
  const list = listAnnotations(doc, pageIndex);
  let n = 0;
  for (const a of list) if (removeAnnotation(doc, pageIndex, { ref: a.ref })) n++;
  return n;
}
