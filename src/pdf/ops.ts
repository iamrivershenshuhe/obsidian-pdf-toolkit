import {
  PDFDocument,
  PDFFont,
  PDFPage,
  StandardFonts,
  degrees,
  rgb,
  PDFTextField,
  PDFCheckBox,
  PDFDropdown,
  PDFRadioGroup,
  PDFOptionList,
  PDFField,
  PageSizes,
} from "@cantoo/pdf-lib";
import * as fontkit from "fontkit";
import { hexToRgb, todayStr } from "../util";
import { t } from "../i18n";

export type Bytes = Uint8Array;

/* ------------------------------------------------------------------ */
/* Loading / saving                                                     */
/* ------------------------------------------------------------------ */

export interface LoadOptions {
  password?: string;
}

export class EncryptedError extends Error {
  constructor() {
    super("encrypted");
    this.name = "EncryptedError";
  }
}

/**
 * Load a PDF. If it is encrypted and no password was given, throws EncryptedError
 * so the caller can prompt the user and retry.
 */
export async function loadDoc(bytes: Bytes, opts: LoadOptions = {}): Promise<PDFDocument> {
  if (opts.password !== undefined) {
    try {
      return await PDFDocument.load(bytes, { password: opts.password, updateMetadata: false });
    } catch (e) {
      throw new Error(t("wrongPassword"));
    }
  }
  const probe = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  if (probe.isEncrypted) {
    // Try the empty user password first — many "protected" PDFs open without one.
    try {
      return await PDFDocument.load(bytes, { password: "", updateMetadata: false });
    } catch {
      throw new EncryptedError();
    }
  }
  return probe;
}

export async function saveDoc(doc: PDFDocument, objectStreams = true): Promise<Bytes> {
  return doc.save({ useObjectStreams: objectStreams, updateFieldAppearances: false });
}

/* ------------------------------------------------------------------ */
/* Fonts                                                                */
/* ------------------------------------------------------------------ */

const WINANSI_EXTRA = new Set(
  "€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ".split(""),
);

export function isWinAnsi(text: string): boolean {
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if (c <= 0xff) continue;
    if (WINANSI_EXTRA.has(ch)) continue;
    return false;
  }
  return true;
}

/** If the file is a TrueType collection, extract font #index as a standalone TTF. */
export function extractFromTtc(bytes: Bytes, index = 0): Bytes {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  if (tag !== "ttcf") return bytes;
  const numFonts = dv.getUint32(8);
  if (index >= numFonts) index = 0;
  const fontOffset = dv.getUint32(12 + index * 4);
  const numTables = dv.getUint16(fontOffset + 4);
  const records: { tag: Bytes; checksum: number; offset: number; length: number }[] = [];
  for (let i = 0; i < numTables; i++) {
    const r = fontOffset + 12 + i * 16;
    records.push({
      tag: bytes.slice(r, r + 4),
      checksum: dv.getUint32(r + 4),
      offset: dv.getUint32(r + 8),
      length: dv.getUint32(r + 12),
    });
  }
  const align = (n: number) => (n + 3) & ~3;
  let total = 12 + numTables * 16;
  for (const r of records) total += align(r.length);
  const out = new Uint8Array(total);
  const odv = new DataView(out.buffer);
  // sfnt header (copy version + numTables + searchRange/entrySelector/rangeShift)
  out.set(bytes.slice(fontOffset, fontOffset + 12), 0);
  let dataPos = 12 + numTables * 16;
  records.forEach((r, i) => {
    const rp = 12 + i * 16;
    out.set(r.tag, rp);
    odv.setUint32(rp + 4, r.checksum);
    odv.setUint32(rp + 8, dataPos);
    odv.setUint32(rp + 12, r.length);
    out.set(bytes.slice(r.offset, r.offset + r.length), dataPos);
    dataPos += align(r.length);
  });
  return out;
}

export interface FontProvider {
  /** Returns bytes of the user-configured font, or null if none configured. */
  customFontBytes(): Promise<Bytes | null>;
}

/** Pick a font that can render every string in `texts`. */
export async function pickFont(doc: PDFDocument, texts: string[], fonts: FontProvider): Promise<PDFFont> {
  const all = texts.join("");
  if (isWinAnsi(all)) return doc.embedFont(StandardFonts.Helvetica);
  const bytes = await fonts.customFontBytes();
  if (!bytes) throw new Error(t("fontMissing"));
  doc.registerFontkit(fontkit as unknown as Parameters<PDFDocument["registerFontkit"]>[0]);
  return doc.embedFont(extractFromTtc(bytes), { subset: true });
}

/* ------------------------------------------------------------------ */
/* Page structure                                                       */
/* ------------------------------------------------------------------ */

/** Create a new document containing `indices` (0-based, in that order) from `src`. */
export async function copyPagesToNew(src: PDFDocument, indices: number[]): Promise<PDFDocument> {
  const out = await PDFDocument.create();
  const pages = await out.copyPages(src, indices);
  for (const p of pages) out.addPage(p);
  copyMetadata(src, out);
  return out;
}

export function copyMetadata(from: PDFDocument, to: PDFDocument) {
  const title = from.getTitle();
  const author = from.getAuthor();
  const subject = from.getSubject();
  const keywords = from.getKeywords();
  if (title) to.setTitle(title);
  if (author) to.setAuthor(author);
  if (subject) to.setSubject(subject);
  if (keywords) to.setKeywords(keywords.split(/[,;]\s*/).filter(Boolean));
}

export async function extractPages(doc: PDFDocument, indices: number[]): Promise<Bytes> {
  return saveDoc(await copyPagesToNew(doc, indices));
}

export async function deletePages(doc: PDFDocument, indices: number[]): Promise<Bytes> {
  const del = new Set(indices);
  const keep = [];
  for (let i = 0; i < doc.getPageCount(); i++) if (!del.has(i)) keep.push(i);
  if (!keep.length) throw new Error(t("orgNothing"));
  return saveDoc(await copyPagesToNew(doc, keep));
}

export async function rotatePages(doc: PDFDocument, indices: number[], deg: number): Promise<Bytes> {
  for (const i of indices) {
    const p = doc.getPage(i);
    p.setRotation(degrees((p.getRotation().angle + deg) % 360));
  }
  return saveDoc(doc);
}

export async function reorderPages(doc: PDFDocument, order: number[]): Promise<Bytes> {
  return saveDoc(await copyPagesToNew(doc, order));
}

export async function reversePages(doc: PDFDocument): Promise<Bytes> {
  const n = doc.getPageCount();
  const order = [];
  for (let i = n - 1; i >= 0; i--) order.push(i);
  return reorderPages(doc, order);
}

export async function insertBlankPages(doc: PDFDocument, afterPage: number, count: number): Promise<Bytes> {
  const n = doc.getPageCount();
  const ref = doc.getPage(Math.min(Math.max(afterPage - 1, 0), n - 1));
  const { width, height } = ref.getSize();
  for (let k = 0; k < count; k++) doc.insertPage(afterPage + k, [width, height]);
  return saveDoc(doc);
}

export async function duplicatePages(doc: PDFDocument, indices: number[]): Promise<Bytes> {
  const dup = new Set(indices);
  const order: number[] = [];
  for (let i = 0; i < doc.getPageCount(); i++) {
    order.push(i);
    if (dup.has(i)) order.push(i);
  }
  return reorderPages(doc, order);
}

export async function mergeDocs(list: Bytes[], passwords: (string | undefined)[] = []): Promise<Bytes> {
  const out = await PDFDocument.create();
  for (let k = 0; k < list.length; k++) {
    const src = await loadDoc(list[k], { password: passwords[k] });
    const pages = await out.copyPages(src, src.getPageIndices());
    for (const p of pages) out.addPage(p);
  }
  return saveDoc(out);
}

export async function splitEvery(doc: PDFDocument, n: number): Promise<Bytes[]> {
  const total = doc.getPageCount();
  const result: Bytes[] = [];
  for (let start = 0; start < total; start += n) {
    const idx = [];
    for (let i = start; i < Math.min(start + n, total); i++) idx.push(i);
    result.push(await extractPages(doc, idx));
  }
  return result;
}

export async function splitRanges(doc: PDFDocument, ranges: number[][]): Promise<Bytes[]> {
  const result: Bytes[] = [];
  for (const r of ranges) result.push(await extractPages(doc, r));
  return result;
}

/* ------------------------------------------------------------------ */
/* Organize (visual) — apply a page plan                                */
/* ------------------------------------------------------------------ */

export interface PagePlanItem {
  srcIndex: number;
  /** extra rotation to add, multiple of 90 */
  rotate: number;
  deleted: boolean;
}

export async function applyPagePlan(src: PDFDocument, plan: PagePlanItem[]): Promise<Bytes> {
  const keep = plan.filter((p) => !p.deleted);
  if (!keep.length) throw new Error(t("orgNothing"));
  const out = await PDFDocument.create();
  const pages = await out.copyPages(
    src,
    keep.map((p) => p.srcIndex),
  );
  pages.forEach((page, i) => {
    const extra = keep[i].rotate;
    if (extra) page.setRotation(degrees((page.getRotation().angle + extra) % 360));
    out.addPage(page);
  });
  copyMetadata(src, out);
  return saveDoc(out);
}

/* ------------------------------------------------------------------ */
/* Stamping: watermark, header/footer                                   */
/* ------------------------------------------------------------------ */

export interface WatermarkOptions {
  text: string;
  fontSize: number;
  opacity: number;
  angle: number;
  color: string;
  tile: boolean;
  pages: number[];
}

export async function addWatermark(doc: PDFDocument, o: WatermarkOptions, fonts: FontProvider): Promise<Bytes> {
  const font = await pickFont(doc, [o.text], fonts);
  const c = hexToRgb(o.color);
  const color = rgb(c.r, c.g, c.b);
  const textWidth = font.widthOfTextAtSize(o.text, o.fontSize);
  const textHeight = font.heightAtSize(o.fontSize);
  for (const i of o.pages) {
    const page = doc.getPage(i);
    const { width, height } = page.getSize();
    if (o.tile) {
      const stepX = textWidth + 80;
      const stepY = textHeight + 120;
      for (let y = -height; y < height * 2; y += stepY) {
        for (let x = -width; x < width * 2; x += stepX) {
          page.drawText(o.text, {
            x,
            y,
            size: o.fontSize,
            font,
            color,
            opacity: o.opacity,
            rotate: degrees(o.angle),
          });
        }
      }
    } else {
      // Center the rotated text on the page.
      const rad = (o.angle * Math.PI) / 180;
      const cx = width / 2;
      const cy = height / 2;
      const x = cx - (textWidth / 2) * Math.cos(rad) + (textHeight / 2) * Math.sin(rad);
      const y = cy - (textWidth / 2) * Math.sin(rad) - (textHeight / 2) * Math.cos(rad);
      page.drawText(o.text, {
        x,
        y,
        size: o.fontSize,
        font,
        color,
        opacity: o.opacity,
        rotate: degrees(o.angle),
      });
    }
  }
  return saveDoc(doc);
}

export interface HeaderFooterOptions {
  headerLeft: string;
  headerCenter: string;
  headerRight: string;
  footerLeft: string;
  footerCenter: string;
  footerRight: string;
  fontSize: number;
  margin: number;
  startNumber: number;
  color: string;
  pages: number[];
  fileName: string;
}

function fillPlaceholders(tpl: string, vars: Record<string, string>): string {
  let s = tpl;
  for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(v);
  return s;
}

export async function addHeaderFooter(doc: PDFDocument, o: HeaderFooterOptions, fonts: FontProvider): Promise<Bytes> {
  const templates = [o.headerLeft, o.headerCenter, o.headerRight, o.footerLeft, o.footerCenter, o.footerRight];
  const total = doc.getPageCount();
  const title = doc.getTitle() || o.fileName;
  const date = todayStr();
  // Pre-render every string so the font subset covers all glyphs.
  const samples: string[] = [];
  for (const i of o.pages) {
    for (const tpl of templates) {
      if (tpl)
        samples.push(
          fillPlaceholders(tpl, { page: String(i + o.startNumber), total: String(total), title, date, file: o.fileName }),
        );
    }
  }
  const font = await pickFont(doc, samples, fonts);
  const c = hexToRgb(o.color);
  const color = rgb(c.r, c.g, c.b);
  const size = o.fontSize;
  for (const i of o.pages) {
    const page = doc.getPage(i);
    const { width, height } = page.getSize();
    const vars = { page: String(i + o.startNumber), total: String(total), title, date, file: o.fileName };
    const draw = (tpl: string, align: "l" | "c" | "r", top: boolean) => {
      if (!tpl) return;
      const text = fillPlaceholders(tpl, vars);
      const w = font.widthOfTextAtSize(text, size);
      const x = align === "l" ? o.margin : align === "c" ? (width - w) / 2 : width - o.margin - w;
      const y = top ? height - o.margin - size : o.margin;
      page.drawText(text, { x, y, size, font, color });
    };
    draw(o.headerLeft, "l", true);
    draw(o.headerCenter, "c", true);
    draw(o.headerRight, "r", true);
    draw(o.footerLeft, "l", false);
    draw(o.footerCenter, "c", false);
    draw(o.footerRight, "r", false);
  }
  return saveDoc(doc);
}

/* ------------------------------------------------------------------ */
/* Geometry: crop, resize, n-up                                         */
/* ------------------------------------------------------------------ */

export interface CropOptions {
  top: number;
  bottom: number;
  left: number;
  right: number;
  pages: number[];
}

export async function cropPages(doc: PDFDocument, o: CropOptions): Promise<Bytes> {
  for (const i of o.pages) {
    const page = doc.getPage(i);
    const box = page.getMediaBox();
    const x = box.x + o.left;
    const y = box.y + o.bottom;
    const w = box.width - o.left - o.right;
    const h = box.height - o.top - o.bottom;
    if (w <= 0 || h <= 0) throw new Error("Crop margins exceed the page size.");
    page.setCropBox(x, y, w, h);
    page.setMediaBox(x, y, w, h);
  }
  return saveDoc(doc);
}

export interface ResizeOptions {
  width: number;
  height: number;
  mode: "contain" | "stretch";
  pages: number[];
}

/** Re-embed each page onto a new page of the target size. */
export async function resizePages(doc: PDFDocument, o: ResizeOptions): Promise<Bytes> {
  const out = await PDFDocument.create();
  const target = new Set(o.pages);
  const n = doc.getPageCount();
  for (let i = 0; i < n; i++) {
    if (!target.has(i)) {
      const [p] = await out.copyPages(doc, [i]);
      out.addPage(p);
      continue;
    }
    const [embedded] = await out.embedPdf(doc, [i]);
    const page = out.addPage([o.width, o.height]);
    const sw = embedded.width;
    const sh = embedded.height;
    if (o.mode === "stretch") {
      page.drawPage(embedded, { x: 0, y: 0, width: o.width, height: o.height });
    } else {
      const s = Math.min(o.width / sw, o.height / sh);
      const w = sw * s;
      const h = sh * s;
      page.drawPage(embedded, { x: (o.width - w) / 2, y: (o.height - h) / 2, width: w, height: h });
    }
  }
  copyMetadata(doc, out);
  return saveDoc(out);
}

export interface NupOptions {
  per: 2 | 4;
  sheet: [number, number];
  landscape: boolean;
}

export async function nUp(doc: PDFDocument, o: NupOptions): Promise<Bytes> {
  const out = await PDFDocument.create();
  let [sw, sh] = o.sheet;
  if (o.landscape) [sw, sh] = [sh, sw];
  const cols = o.per === 2 ? 2 : 2;
  const rows = o.per === 2 ? 1 : 2;
  const cellW = sw / cols;
  const cellH = sh / rows;
  const pad = 10;
  const all = doc.getPageIndices();
  const embedded = await out.embedPdf(doc, all);
  for (let start = 0; start < embedded.length; start += o.per) {
    const sheet = out.addPage([sw, sh]);
    for (let k = 0; k < o.per && start + k < embedded.length; k++) {
      const e = embedded[start + k];
      const col = k % cols;
      const row = Math.floor(k / cols);
      const s = Math.min((cellW - pad * 2) / e.width, (cellH - pad * 2) / e.height);
      const w = e.width * s;
      const h = e.height * s;
      const x = col * cellW + (cellW - w) / 2;
      const y = sh - (row + 1) * cellH + (cellH - h) / 2;
      sheet.drawPage(e, { x, y, width: w, height: h });
    }
  }
  copyMetadata(doc, out);
  return saveDoc(out);
}

/* ------------------------------------------------------------------ */
/* Security                                                             */
/* ------------------------------------------------------------------ */

export interface ProtectOptions {
  userPassword: string;
  ownerPassword: string;
  printing: boolean;
  modifying: boolean;
  copying: boolean;
  annotating: boolean;
  fillingForms: boolean;
}

export async function protect(doc: PDFDocument, o: ProtectOptions): Promise<Bytes> {
  doc.encrypt({
    userPassword: o.userPassword || undefined,
    ownerPassword: o.ownerPassword || o.userPassword,
    permissions: {
      printing: o.printing ? "highResolution" : false,
      modifying: o.modifying,
      copying: o.copying,
      annotating: o.annotating,
      fillingForms: o.fillingForms,
      contentAccessibility: true,
      documentAssembly: o.modifying,
    },
  });
  return saveDoc(doc, false);
}

export async function unlock(doc: PDFDocument): Promise<Bytes> {
  // A decrypted document re-saved without encrypt() is an unprotected copy.
  return saveDoc(doc);
}

/* ------------------------------------------------------------------ */
/* Metadata / info                                                      */
/* ------------------------------------------------------------------ */

export interface Metadata {
  title: string;
  author: string;
  subject: string;
  keywords: string;
  creator: string;
  producer: string;
}

export function getMetadata(doc: PDFDocument): Metadata {
  return {
    title: doc.getTitle() ?? "",
    author: doc.getAuthor() ?? "",
    subject: doc.getSubject() ?? "",
    keywords: doc.getKeywords() ?? "",
    creator: doc.getCreator() ?? "",
    producer: doc.getProducer() ?? "",
  };
}

export async function setMetadata(doc: PDFDocument, m: Metadata): Promise<Bytes> {
  doc.setTitle(m.title);
  doc.setAuthor(m.author);
  doc.setSubject(m.subject);
  doc.setKeywords(
    m.keywords
      .split(/[,;]\s*/)
      .map((s) => s.trim())
      .filter(Boolean),
  );
  doc.setCreator(m.creator);
  doc.setProducer(m.producer);
  doc.setModificationDate(new Date());
  return saveDoc(doc);
}

export interface DocInfo {
  pages: number;
  firstPageSize: { width: number; height: number };
  encrypted: boolean;
  formFields: number;
  created?: Date;
  modified?: Date;
  metadata: Metadata;
}

export function getInfo(doc: PDFDocument, encrypted: boolean): DocInfo {
  const n = doc.getPageCount();
  const first = n ? doc.getPage(0).getSize() : { width: 0, height: 0 };
  let formFields = 0;
  try {
    formFields = doc.getForm().getFields().length;
  } catch {
    /* no form */
  }
  return {
    pages: n,
    firstPageSize: first,
    encrypted,
    formFields,
    created: doc.getCreationDate(),
    modified: doc.getModificationDate(),
    metadata: getMetadata(doc),
  };
}

/* ------------------------------------------------------------------ */
/* Attachments                                                          */
/* ------------------------------------------------------------------ */

export async function attachFile(
  doc: PDFDocument,
  data: Bytes,
  name: string,
  mimeType: string,
  description: string,
): Promise<Bytes> {
  await doc.attach(data, name, { mimeType, description, creationDate: new Date(), modificationDate: new Date() });
  return saveDoc(doc);
}

/* ------------------------------------------------------------------ */
/* Forms                                                                */
/* ------------------------------------------------------------------ */

export type FieldKind = "text" | "checkbox" | "dropdown" | "radio" | "optionlist" | "other";

export interface FieldDescriptor {
  name: string;
  kind: FieldKind;
  value: string | boolean | string[];
  options?: string[];
  readOnly: boolean;
}

export function describeFields(doc: PDFDocument): FieldDescriptor[] {
  let fields: PDFField[];
  try {
    fields = doc.getForm().getFields();
  } catch {
    return [];
  }
  return fields.map((f) => {
    const name = f.getName();
    const readOnly = f.isReadOnly();
    if (f instanceof PDFTextField) return { name, kind: "text", value: f.getText() ?? "", readOnly };
    if (f instanceof PDFCheckBox) return { name, kind: "checkbox", value: f.isChecked(), readOnly };
    if (f instanceof PDFDropdown)
      return { name, kind: "dropdown", value: f.getSelected()[0] ?? "", options: f.getOptions(), readOnly };
    if (f instanceof PDFRadioGroup)
      return { name, kind: "radio", value: f.getSelected() ?? "", options: f.getOptions(), readOnly };
    if (f instanceof PDFOptionList)
      return { name, kind: "optionlist", value: f.getSelected(), options: f.getOptions(), readOnly };
    return { name, kind: "other", value: "", readOnly };
  });
}

export async function fillFields(
  doc: PDFDocument,
  values: Record<string, string | boolean | string[]>,
  flatten: boolean,
): Promise<Bytes> {
  const form = doc.getForm();
  for (const [name, v] of Object.entries(values)) {
    let f: PDFField;
    try {
      f = form.getField(name);
    } catch {
      continue;
    }
    if (f instanceof PDFTextField) f.setText(String(v));
    else if (f instanceof PDFCheckBox) (v ? f.check() : f.uncheck());
    else if (f instanceof PDFDropdown) {
      if (v) f.select(String(v));
      else f.clear();
    } else if (f instanceof PDFRadioGroup) {
      if (v) f.select(String(v));
      else f.clear();
    } else if (f instanceof PDFOptionList) {
      const arr = Array.isArray(v) ? v : String(v) ? [String(v)] : [];
      if (arr.length) f.select(arr);
      else f.clear();
    }
  }
  if (flatten) form.flatten();
  else form.updateFieldAppearances();
  return doc.save({ useObjectStreams: true, updateFieldAppearances: !flatten });
}

export async function flattenForm(doc: PDFDocument): Promise<Bytes> {
  doc.getForm().flatten();
  return saveDoc(doc);
}

/* ------------------------------------------------------------------ */
/* Images → PDF                                                         */
/* ------------------------------------------------------------------ */

export interface ImageInput {
  data: Bytes;
  ext: string;
}

export async function imagesToPdf(images: ImageInput[], pageSize: [number, number] | "image"): Promise<Bytes> {
  const out = await PDFDocument.create();
  for (const img of images) {
    const embedded = /png$/i.test(img.ext) ? await out.embedPng(img.data) : await out.embedJpg(img.data);
    if (pageSize === "image") {
      const page = out.addPage([embedded.width, embedded.height]);
      page.drawImage(embedded, { x: 0, y: 0, width: embedded.width, height: embedded.height });
    } else {
      const [pw, ph] = pageSize;
      const page = out.addPage([pw, ph]);
      const margin = 36;
      const s = Math.min((pw - margin * 2) / embedded.width, (ph - margin * 2) / embedded.height);
      const w = embedded.width * s;
      const h = embedded.height * s;
      page.drawImage(embedded, { x: (pw - w) / 2, y: (ph - h) / 2, width: w, height: h });
    }
  }
  return saveDoc(out);
}

/* ------------------------------------------------------------------ */
/* Optimize                                                             */
/* ------------------------------------------------------------------ */

export async function optimize(doc: PDFDocument): Promise<Bytes> {
  return doc.save({ useObjectStreams: true, addDefaultPage: false });
}

export { PageSizes, PDFDocument, PDFPage };
