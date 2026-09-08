import { Component, FileView, Menu, Notice, TFile, setIcon } from "obsidian";
import { degrees } from "@cantoo/pdf-lib";
import type PdfToolkitPlugin from "../main";
import { appendQuote, openReadingNote, selectionLink, QuoteInfo } from "./reading";
import { extractText } from "../pdf/pdfjs";
import { RefPopover } from "./refpopover";
import type { PDFDocument } from "../pdf/ops";
import * as ann from "../pdf/annotations";
import { Keys, t } from "../i18n";
import { DARK_MODES, errMsg, hexToRgb, toArrayBuffer } from "../util";
import { formModal } from "./modals";

/*
 * Acrobat-style toolbar injected above Obsidian's PDF viewer.
 *
 * Markup tools work on text selection; drawing tools use a transparent overlay per page.
 * Every action writes a real annotation into the PDF file. To avoid the viewer flashing
 * on every stroke, the view's reload is suppressed while we write and the new annotation is
 * drawn in a "live layer" (SVG in PDF coordinates) until the document is reloaded for
 * another reason. Only removing annotations that pdf.js already rendered needs a reload.
 */

export type ToolId = "select" | "highlight" | "underline" | "strikeout" | "pen" | "rect" | "ellipse" | "note" | "text" | "eraser";

const MARKUP: ToolId[] = ["highlight", "underline", "strikeout"];
const DRAW: ToolId[] = ["pen", "rect", "ellipse", "note", "text", "eraser"];

export const COLORS = ["#ffe11a", "#7ee787", "#79c0ff", "#ff7eb6", "#ffa657", "#f85149", "#1f6feb", "#111111"];

interface ToolDef {
  id: ToolId;
  icon: string;
  name: Keys;
  sepBefore?: boolean;
}

const TOOLS: ToolDef[] = [
  { id: "select", icon: "mouse-pointer", name: "tb_select" },
  { id: "highlight", icon: "highlighter", name: "tb_highlight" },
  { id: "underline", icon: "underline", name: "tb_underline" },
  { id: "strikeout", icon: "strikethrough", name: "tb_strikeout" },
  { id: "pen", icon: "pencil", name: "tb_pen", sepBefore: true },
  { id: "rect", icon: "square", name: "tb_rect" },
  { id: "ellipse", icon: "circle", name: "tb_ellipse" },
  { id: "note", icon: "sticky-note", name: "tb_note", sepBefore: true },
  { id: "text", icon: "type", name: "tb_text" },
  { id: "eraser", icon: "eraser", name: "tb_eraser", sepBefore: true },
];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

interface Refs {
  pv: Any; // pdf.js PDFViewer
  eventBus: Any;
  viewerEl: HTMLElement;
  containerEl: HTMLElement;
  doc: Any; // pdf.js PDFDocumentProxy
}

interface Drag {
  overlay: HTMLElement;
  page: number; // 1-based
  pts: number[]; // css px, relative to overlay
  start: [number, number];
  shape: SVGElement | null;
}

interface Position {
  doc: Any;
  page: number;
  scrollTop: number;
  scrollLeft: number;
  scale: Any;
}

/** An annotation we added to the file but pdf.js has not loaded yet. Geometry in PDF user space. */
interface LiveAnnot {
  nm: string;
  kind: ann.MarkupKind | "Ink" | ann.ShapeKind | "Text" | "FreeText";
  color: string;
  width: number;
  quads?: ann.Quad[];
  path?: number[];
  box?: [number, number, number, number];
  text?: string;
  fontSize?: number;
}

const SVG_NS = "http://www.w3.org/2000/svg";
function svgEl<K extends keyof SVGElementTagNameMap>(tag: K): SVGElementTagNameMap[K] {
  return document.createElementNS(SVG_NS, tag);
}

/** A sticky note reference: either a live-layer note (nm) or one already in the file (ref). */
interface NoteRef {
  page: number;
  nm?: string;
  ref?: import("@cantoo/pdf-lib").PDFRef;
  text: string;
}

/** 20×20 note icon as a standalone SVG (used inside pdf.js annotation sections). */
function noteIconSvg(fill: string): SVGSVGElement {
  const svg = svgEl("svg");
  svg.setAttribute("viewBox", "0 0 20 20");
  svg.setAttribute("class", "pdftk-note-icon");
  const icon = ann.noteIconPaths(0, 20);
  const P = (x: number, y: number) => `${x},${20 - y}`;
  const d = (segs: ann.PathSeg[]) =>
    segs
      .map((s) => {
        if (s[0] === "h") return "Z";
        if (s[0] === "c") return `C ${P(s[1], s[2])} ${P(s[3], s[4])} ${P(s[5], s[6])}`;
        return `${s[0].toUpperCase()} ${P(s[1], s[2])}`;
      })
      .join(" ");
  for (const segs of [icon.tail, icon.bubble]) {
    const p = svgEl("path");
    p.setAttribute("d", d(segs));
    p.setAttribute("fill", fill);
    p.setAttribute("stroke", "#383838");
    p.setAttribute("stroke-width", "0.9");
    p.setAttribute("stroke-linejoin", "round");
    svg.appendChild(p);
  }
  for (const [ax, ay, bx, by] of icon.lines) {
    const l = svgEl("line");
    l.setAttribute("x1", String(ax));
    l.setAttribute("y1", String(20 - ay));
    l.setAttribute("x2", String(bx));
    l.setAttribute("y2", String(20 - by));
    l.setAttribute("stroke", "#383838");
    l.setAttribute("stroke-width", "1.1");
    l.setAttribute("stroke-linecap", "round");
    svg.appendChild(l);
  }
  return svg;
}

export class PdfToolbar extends Component {
  private el!: HTMLElement;
  private tool: ToolId = "select";
  private buttons = new Map<ToolId, HTMLElement>();
  private swatches: HTMLElement[] = [];
  private widthSelect!: HTMLSelectElement;
  private undoStack: { page: number; nm: string }[] = [];
  private hookedBus: Any = null;
  private busy = false;
  private password: string | undefined;
  private lastFile: TFile | null = null;
  private lastDoc: Any = null;
  private drag: Drag | null = null;

  /** live layer: pageIndex → annotations */
  private live = new Map<number, LiveAnnot[]>();
  private liveVersion = 0;
  /** while true, the view's reload-on-modify is skipped */
  private suppressReload = false;
  private patchedOnLoadFile = false;
  refPop!: RefPopover;

  constructor(
    private plugin: PdfToolkitPlugin,
    public view: FileView,
  ) {
    super();
  }

  get file(): TFile | null {
    return this.view.file;
  }

  private get color(): string {
    return DRAW.includes(this.tool) ? this.plugin.settings.drawColor : this.plugin.settings.highlightColor;
  }

  private set color(v: string) {
    if (DRAW.includes(this.tool)) this.plugin.settings.drawColor = v;
    else this.plugin.settings.highlightColor = v;
    void this.plugin.saveSettings();
  }

  /* ---------------------------------------------------------------- */
  /* Lifecycle                                                          */
  /* ---------------------------------------------------------------- */

  onload() {
    const content = this.view.contentEl;
    this.el = createDiv("pdftk-toolbar");
    content.prepend(this.el);
    content.addClass("pdftk-has-toolbar");
    this.buildBar();
    this.patchReload();
    this.refPop = new RefPopover(this.plugin, this);
    this.addChild(this.refPop);
    this.refPop.attach(content);
    this.registerDomEvent(content, "mouseup", () => this.onMouseUp());
    this.registerDomEvent(content, "keydown", (e) => {
      if (e.key === "Escape" && this.tool !== "select") this.setTool("select");
    });
    this.registerInterval(window.setInterval(() => this.sync(), 500));
    this.sync();
  }

  onunload() {
    this.cancelDrag();
    this.unhook();
    this.removeOverlays();
    this.unpatchReload();
    this.el.remove();
    this.view.contentEl.removeClass("pdftk-has-toolbar");
    delete this.view.contentEl.dataset.tool;
  }

  /**
   * Obsidian's PDF view reacts to vault "modify" by calling `this.onLoadFile(file)`.
   * Shadow it on this instance so our own writes do not trigger a full reload.
   */
  private patchReload() {
    const v = this.view as Any;
    const proto = Object.getPrototypeOf(v);
    if (typeof proto?.onLoadFile !== "function" || Object.prototype.hasOwnProperty.call(v, "onLoadFile")) return;
    v.onLoadFile = (file: TFile) => {
      if (this.suppressReload && file === this.view.file) return Promise.resolve();
      return proto.onLoadFile.call(v, file);
    };
    this.patchedOnLoadFile = true;
  }

  private unpatchReload() {
    if (this.patchedOnLoadFile) delete (this.view as Any).onLoadFile;
    this.patchedOnLoadFile = false;
  }

  /* ---------------------------------------------------------------- */
  /* Toolbar DOM                                                        */
  /* ---------------------------------------------------------------- */

  private buildBar() {
    for (const td of TOOLS) {
      if (td.sepBefore) this.sep();
      this.buttons.set(
        td.id,
        this.iconBtn(td.icon, t(td.name), () => this.setTool(td.id)),
      );
    }
    this.iconBtn("undo-2", t("tb_undo"), () => void this.undo());
    this.sep();

    const sw = this.el.createDiv("pdftk-swatches");
    for (const c of COLORS) {
      const s = sw.createDiv("pdftk-swatch");
      s.style.background = c;
      s.dataset.color = c;
      s.setAttr("aria-label", t("tb_color"));
      s.onclick = () => {
        this.color = c;
        this.refreshUi();
      };
      this.swatches.push(s);
    }

    this.widthSelect = this.el.createEl("select", { cls: "dropdown pdftk-width" });
    for (const w of [1, 2, 3, 5, 8]) this.widthSelect.createEl("option", { text: `${w} pt`, value: String(w) });
    this.widthSelect.value = String(this.plugin.settings.strokeWidth);
    this.widthSelect.setAttr("aria-label", t("tb_width"));
    this.widthSelect.setAttr("title", t("tb_width"));
    this.widthSelect.onchange = () => {
      this.plugin.settings.strokeWidth = Number(this.widthSelect.value) || 2;
      void this.plugin.saveSettings();
    };

    this.sep();
    this.iconBtn("moon", t("tb_dark"), (e) => this.darkMenu(e));
    this.iconBtn("book-open", t("tb_readingNote"), () => {
      if (this.file) void openReadingNote(this.plugin, this.file).catch((err) => new Notice(t("failed", { msg: errMsg(err) })));
    });
    this.iconBtn("quote", t("tb_quote"), () => void this.quoteSelection());
    this.iconBtn("message-square", t("tb_chat"), () => void this.plugin.openChat());
    this.iconBtn("book-marked", t("tb_refs"), (e) => this.refsMenu(e));
    this.sep();
    this.iconBtn("rotate-cw", t("tb_rotatePage"), () => void this.rotateCurrentPage());
    this.iconBtn("layout-grid", t("tb_organize"), () => {
      if (this.file) void this.plugin.runToolById("organize", this.file);
    });
    this.iconBtn("trash-2", t("tb_clearPage"), () => void this.clearPage());
    this.iconBtn("more-horizontal", t("tb_more"), () => this.plugin.openToolbox(this.file));
    this.refreshUi();
  }

  private iconBtn(icon: string, label: string, fn: (e: MouseEvent) => void): HTMLElement {
    const b = this.el.createEl("button", { cls: "clickable-icon pdftk-btn" });
    setIcon(b, icon);
    b.setAttr("aria-label", label);
    b.setAttr("title", label);
    b.addEventListener("click", (e) => {
      e.preventDefault();
      fn(e);
    });
    return b;
  }

  /* ---------------------------------------------------------------- */
  /* Dark mode / reading helpers                                        */
  /* ---------------------------------------------------------------- */

  applyDarkMode() {
    const dm = this.plugin.settings.darkMode;
    for (const m of DARK_MODES) if (m !== "off") this.view.contentEl.toggleClass(`pdftk-dark-${m}`, dm === m);
  }

  private refsMenu(e: MouseEvent) {
    const menu = new Menu();
    menu.addItem((item) =>
      item
        .setTitle(t("ref_hover"))
        .setChecked(this.plugin.settings.refHover)
        .onClick(async () => {
          this.plugin.settings.refHover = !this.plugin.settings.refHover;
          await this.plugin.saveSettings();
          if (!this.plugin.settings.refHover) this.refPop.hide();
        }),
    );
    menu.addItem((item) => item.setTitle(t("cmd_openRefs")).setIcon("panel-left").onClick(() => void this.plugin.openRefsView()));
    menu.addItem((item) => item.setTitle(t("ref_list")).setIcon("list").onClick(() => void this.refPop.openList()));
    menu.showAtMouseEvent(e);
  }

  goToPage(n: number) {
    const r = this.refs();
    if (r) r.pv.currentPageNumber = n;
  }

  private darkMenu(e: MouseEvent) {
    const menu = new Menu();
    for (const m of DARK_MODES) {
      menu.addItem((item) =>
        item
          .setTitle(t(("dark_" + m) as Keys))
          .setChecked(this.plugin.settings.darkMode === m)
          .onClick(() => void this.plugin.setDarkMode(m)),
      );
    }
    menu.showAtMouseEvent(e);
  }

  /** Text + page + back-link of the current selection (must run while the selection still exists). */
  private captureQuote(sel: Selection): QuoteInfo | null {
    const file = this.file;
    if (!file) return null;
    const text = sel.toString().replace(/-\n(?=[a-z])/g, "").replace(/\s*\n\s*/g, " ").trim();
    if (!text) return null;
    const range = sel.getRangeAt(0);
    const start = range.startContainer;
    const el = start instanceof HTMLElement ? start : start.parentElement;
    const pd = el?.closest<HTMLElement>(".page[data-page-number]") ?? null;
    const page = pd ? Number(pd.dataset.pageNumber) : this.currentPage();
    return { text, page, link: selectionLink(this.view, file, page, pd) };
  }

  async quoteSelection() {
    const file = this.file;
    const r = this.refs();
    const sel = window.getSelection();
    if (!file || !r || !sel || sel.isCollapsed || sel.rangeCount === 0 || !r.viewerEl.contains(sel.getRangeAt(0).commonAncestorContainer)) {
      new Notice(t("quote_noSelection"));
      return;
    }
    const q = this.captureQuote(sel);
    if (!q) {
      new Notice(t("quote_noSelection"));
      return;
    }
    const res = await formModal(this.plugin.app, t("tb_quote"), [
      { kind: "note", label: `p.${q.page}: ${q.text.length > 160 ? q.text.slice(0, 160) + "…" : q.text}` },
      { kind: "textarea", key: "c", label: t("quote_comment"), rows: 3 },
    ]);
    if (!res) return;
    try {
      await appendQuote(this.plugin, file, q, String(res.c));
    } catch (err) {
      new Notice(t("failed", { msg: errMsg(err) }), 8000);
    }
  }

  private sep() {
    this.el.createDiv("pdftk-sep");
  }

  private refreshUi() {
    for (const [id, b] of this.buttons) b.toggleClass("is-active", id === this.tool);
    const c = this.color;
    for (const s of this.swatches) s.toggleClass("is-active", s.dataset.color === c);
    this.el.dataset.tool = this.tool;
    this.view.contentEl.dataset.tool = this.tool;
    this.refreshOverlays();
  }

  setTool(id: ToolId) {
    this.cancelDrag();
    this.tool = id;
    this.refreshUi();
  }

  /* ---------------------------------------------------------------- */
  /* pdf.js viewer access                                               */
  /* ---------------------------------------------------------------- */

  private refs(): Refs | null {
    const v = (this.view as Any).viewer;
    const child = v?.child;
    const ov = child?.pdfViewer;
    const pv = ov?.pdfViewer;
    if (!pv || !pv.viewer || !pv.container) return null;
    return { pv, eventBus: ov.eventBus ?? pv.eventBus, viewerEl: pv.viewer, containerEl: pv.container, doc: pv.pdfDocument };
  }

  private sync() {
    // Compare file identity, not path: a rename/move (organise into folder) must keep the live layer.
    if (this.file !== this.lastFile) {
      this.lastFile = this.file;
      this.undoStack = [];
      this.password = undefined;
      this.clearLive();
    }
    const r = this.refs();
    if (!r) return;
    if (r.doc && r.doc !== this.lastDoc) {
      // The viewer loaded a (new) document: everything we wrote is now rendered by pdf.js.
      this.lastDoc = r.doc;
      this.clearLive();
    }
    if (r.eventBus !== this.hookedBus) {
      this.unhook();
      this.hookedBus = r.eventBus;
      r.eventBus?.on?.("pagerendered", this.onPageRendered);
    }
    this.applyDarkMode();
    this.refreshOverlays();
  }

  private onPageRendered = () => this.refreshOverlays();

  private unhook() {
    this.hookedBus?.off?.("pagerendered", this.onPageRendered);
    this.hookedBus = null;
  }

  private viewport(pageNumber: number): Any {
    const r = this.refs();
    return r?.pv.getPageView?.(pageNumber - 1)?.viewport ?? null;
  }

  private pageDivs(): HTMLElement[] {
    const r = this.refs();
    if (!r) return [];
    return Array.from(r.viewerEl.querySelectorAll<HTMLElement>(".page[data-page-number]"));
  }

  /* ---------------------------------------------------------------- */
  /* Overlays + live layer                                              */
  /* ---------------------------------------------------------------- */

  private refreshOverlays() {
    const active = DRAW.includes(this.tool);
    for (const pd of this.pageDivs()) {
      let ov = pd.querySelector<HTMLElement>(":scope > .pdftk-overlay");
      if (!ov) {
        ov = pd.createDiv("pdftk-overlay");
        const svg = svgEl("svg");
        const liveG = svgEl("g");
        liveG.setAttribute("class", "pdftk-live");
        const prevG = svgEl("g");
        prevG.setAttribute("class", "pdftk-preview");
        svg.append(liveG, prevG);
        ov.appendChild(svg);
        this.bindOverlay(ov, pd);
      }
      // Separate layer for highlights: mix-blend-mode is applied to the layer element itself, so it
      // multiplies with the page canvas no matter how pdf.js stacks its own layers.
      let blend = pd.querySelector<HTMLElement>(":scope > .pdftk-blend");
      if (!blend) {
        blend = pd.createDiv("pdftk-blend");
        const svg = svgEl("svg");
        const g = svgEl("g");
        g.setAttribute("class", "pdftk-live");
        svg.appendChild(g);
        blend.appendChild(svg);
        pd.insertBefore(blend, ov);
      }
      ov.toggleClass("is-active", active);
      ov.dataset.tool = this.tool;
      this.renderLive(pd, ov, blend);
      // pdf.js renders sticky notes as <img> icons whose asset is missing in Obsidian (shows as a broken
      // image). Hide it; when pdf.js did not draw the appearance stream on its own canvas, use our icon.
      pd.querySelectorAll<HTMLElement>(".annotationLayer .textAnnotation").forEach((sec) => {
        sec.querySelectorAll("img").forEach((img) => (img.style.display = "none"));
        if (!sec.querySelector("canvas") && !sec.querySelector(".pdftk-note-icon")) sec.appendChild(noteIconSvg("#ffe11a"));
      });
    }
  }

  private removeOverlays() {
    for (const pd of this.pageDivs()) pd.querySelectorAll(":scope > .pdftk-overlay, :scope > .pdftk-blend").forEach((o) => o.remove());
  }

  private clearLive() {
    if (!this.live.size) return;
    this.live.clear();
    this.liveVersion++;
  }

  private addLive(pageIndex: number, a: LiveAnnot) {
    let list = this.live.get(pageIndex);
    if (!list) this.live.set(pageIndex, (list = []));
    list.push(a);
    this.liveVersion++;
    this.refreshOverlays();
  }

  private removeLive(nm: string): boolean {
    for (const [page, list] of this.live) {
      const i = list.findIndex((a) => a.nm === nm);
      if (i >= 0) {
        list.splice(i, 1);
        if (!list.length) this.live.delete(page);
        this.liveVersion++;
        this.refreshOverlays();
        return true;
      }
    }
    return false;
  }

  private isLive(nm: string | undefined): boolean {
    if (!nm) return false;
    for (const list of this.live.values()) if (list.some((a) => a.nm === nm)) return true;
    return false;
  }

  /** Draw live annotations of one page into its overlay SVG (PDF space → viewport space). */
  private renderLive(pd: HTMLElement, ov: HTMLElement, blend: HTMLElement) {
    const gMain = ov.querySelector<SVGGElement>("g.pdftk-live");
    const gBlend = blend.querySelector<SVGGElement>("g.pdftk-live");
    if (!gMain || !gBlend) return;
    const page = Number(pd.dataset.pageNumber);
    const items = this.live.get(page - 1) ?? [];
    const vp = this.viewport(page);
    const key = vp ? `${vp.width}x${vp.height}r${vp.rotation}s${vp.scale}v${this.liveVersion}` : "";
    if (ov.dataset.liveKey === key) return;
    ov.dataset.liveKey = key;
    gMain.replaceChildren();
    gBlend.replaceChildren();
    if (!items.length || !vp) return;
    const P = (x: number, y: number): [number, number] => vp.convertToViewportPoint(x, y) as [number, number];
    const S = (w: number) => Math.max(0.5, w * vp.scale);

    for (const a of items) {
      const g = a.kind === "Highlight" ? gBlend : gMain;
      if (a.quads) {
        for (const q of a.quads) {
          const ul = P(q.x1, q.y1);
          const ur = P(q.x2, q.y2);
          const ll = P(q.x3, q.y3);
          const lr = P(q.x4, q.y4);
          if (a.kind === "Highlight") {
            const poly = svgEl("polygon");
            poly.setAttribute("points", `${ul} ${ur} ${lr} ${ll}`);
            poly.setAttribute("fill", a.color);
            poly.setAttribute("class", "pdftk-live-highlight");
            g.appendChild(poly);
          } else {
            const h = Math.abs(q.y1 - q.y3);
            const lw = Math.max(0.8, h * 0.07);
            const y = a.kind === "Underline" ? Math.min(q.y3, q.y1) + lw : (q.y1 + q.y3) / 2;
            const s = P(q.x3, y);
            const e = P(q.x4, y);
            const line = svgEl("line");
            line.setAttribute("x1", String(s[0]));
            line.setAttribute("y1", String(s[1]));
            line.setAttribute("x2", String(e[0]));
            line.setAttribute("y2", String(e[1]));
            line.setAttribute("stroke", a.color);
            line.setAttribute("stroke-width", String(S(lw)));
            g.appendChild(line);
          }
        }
      } else if (a.path) {
        const pl = svgEl("polyline");
        let pts = "";
        for (let i = 0; i < a.path.length; i += 2) pts += `${P(a.path[i], a.path[i + 1])} `;
        pl.setAttribute("points", pts.trim());
        pl.setAttribute("fill", "none");
        pl.setAttribute("stroke", a.color);
        pl.setAttribute("stroke-width", String(S(a.width)));
        pl.setAttribute("stroke-linecap", "round");
        pl.setAttribute("stroke-linejoin", "round");
        g.appendChild(pl);
      } else if (a.box) {
        const [x1, y1, x2, y2] = a.box;
        const c1 = P(Math.min(x1, x2), Math.max(y1, y2)); // top-left in viewport
        const c2 = P(Math.max(x1, x2), Math.min(y1, y2)); // bottom-right
        const left = Math.min(c1[0], c2[0]);
        const top = Math.min(c1[1], c2[1]);
        const w = Math.abs(c2[0] - c1[0]);
        const h = Math.abs(c2[1] - c1[1]);
        if (a.kind === "Square") {
          const r = svgEl("rect");
          const sw = S(a.width);
          r.setAttribute("x", String(left + sw / 2));
          r.setAttribute("y", String(top + sw / 2));
          r.setAttribute("width", String(Math.max(0, w - sw)));
          r.setAttribute("height", String(Math.max(0, h - sw)));
          r.setAttribute("fill", "none");
          r.setAttribute("stroke", a.color);
          r.setAttribute("stroke-width", String(sw));
          g.appendChild(r);
        } else if (a.kind === "Circle") {
          const e = svgEl("ellipse");
          const sw = S(a.width);
          e.setAttribute("cx", String(left + w / 2));
          e.setAttribute("cy", String(top + h / 2));
          e.setAttribute("rx", String(Math.max(0, w / 2 - sw / 2)));
          e.setAttribute("ry", String(Math.max(0, h / 2 - sw / 2)));
          e.setAttribute("fill", "none");
          e.setAttribute("stroke", a.color);
          e.setAttribute("stroke-width", String(sw));
          g.appendChild(e);
        } else if (a.kind === "Text") {
          const grp = svgEl("g");
          grp.setAttribute("class", "pdftk-note");
          const icon = ann.noteIconPaths(Math.min(x1, x2), Math.max(y1, y2));
          const d = (segs: ann.PathSeg[]) =>
            segs
              .map((s) => {
                if (s[0] === "h") return "Z";
                if (s[0] === "c") return `C ${P(s[1], s[2])} ${P(s[3], s[4])} ${P(s[5], s[6])}`;
                return `${s[0].toUpperCase()} ${P(s[1], s[2])}`;
              })
              .join(" ");
          for (const segs of [icon.tail, icon.bubble]) {
            const p = svgEl("path");
            p.setAttribute("d", d(segs));
            p.setAttribute("fill", a.color);
            p.setAttribute("stroke", "#383838");
            p.setAttribute("stroke-width", String(S(0.9)));
            p.setAttribute("stroke-linejoin", "round");
            grp.appendChild(p);
          }
          for (const [ax, ay, bx, by] of icon.lines) {
            const l = svgEl("line");
            const s = P(ax, ay);
            const e = P(bx, by);
            l.setAttribute("x1", String(s[0]));
            l.setAttribute("y1", String(s[1]));
            l.setAttribute("x2", String(e[0]));
            l.setAttribute("y2", String(e[1]));
            l.setAttribute("stroke", "#383838");
            l.setAttribute("stroke-width", String(S(1.1)));
            l.setAttribute("stroke-linecap", "round");
            grp.appendChild(l);
          }
          if (a.text) {
            const title = svgEl("title");
            title.textContent = a.text;
            grp.appendChild(title);
          }
          const note: NoteRef = { page: page - 1, nm: a.nm, text: a.text ?? "" };
          grp.addEventListener("click", (e) => {
            // drawing tools own the pointer; the note tool handles hits itself in onUp
            if (DRAW.includes(this.tool)) return;
            e.stopPropagation();
            e.preventDefault();
            void this.openNoteEditor(note);
          });
          g.appendChild(grp);
        } else if (a.kind === "FreeText") {
          const fo = svgEl("foreignObject");
          fo.setAttribute("x", String(left));
          fo.setAttribute("y", String(top));
          fo.setAttribute("width", String(w));
          fo.setAttribute("height", String(Math.max(h, 4)));
          const div = document.createElement("div");
          div.className = "pdftk-live-freetext";
          div.style.fontSize = `${S(a.fontSize ?? 12)}px`;
          div.style.lineHeight = "1.25";
          div.style.color = a.color;
          div.style.padding = `${S(3)}px`;
          div.textContent = a.text ?? "";
          fo.appendChild(div);
          g.appendChild(fo);
        }
      }
    }
  }

  private bindOverlay(ov: HTMLElement, pd: HTMLElement) {
    ov.addEventListener("pointerdown", (e) => this.onDown(e, ov, pd));
    ov.addEventListener("pointermove", (e) => this.onMove(e, ov));
    ov.addEventListener("pointerup", (e) => void this.onUp(e, ov));
    ov.addEventListener("pointercancel", () => this.cancelDrag());
  }

  private cssWidth(page: number): number {
    const vp = this.viewport(page);
    return this.plugin.settings.strokeWidth * (vp?.scale ?? 1);
  }

  private onDown(e: PointerEvent, ov: HTMLElement, pd: HTMLElement) {
    if (!DRAW.includes(this.tool) || e.button !== 0 || this.busy) return;
    e.preventDefault();
    e.stopPropagation();
    const page = Number(pd.dataset.pageNumber);
    const rect = ov.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    try {
      ov.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    const preview = ov.querySelector("g.pdftk-preview") ?? ov.querySelector("svg")!;
    const drag: Drag = { overlay: ov, page, pts: [x, y], start: [x, y], shape: null };
    const stroke = (el: SVGElement) => {
      el.setAttribute("fill", "none");
      el.setAttribute("stroke", this.color);
      el.setAttribute("stroke-width", String(this.cssWidth(page)));
      el.setAttribute("stroke-linecap", "round");
      el.setAttribute("stroke-linejoin", "round");
    };
    if (this.tool === "pen") {
      const pl = svgEl("polyline");
      stroke(pl);
      pl.setAttribute("points", `${x},${y}`);
      preview.appendChild(pl);
      drag.shape = pl;
    } else if (this.tool === "rect" || this.tool === "text") {
      const r = svgEl("rect");
      stroke(r);
      if (this.tool === "text") r.setAttribute("stroke-dasharray", "4 3");
      preview.appendChild(r);
      drag.shape = r;
    } else if (this.tool === "ellipse") {
      const el = svgEl("ellipse");
      stroke(el);
      preview.appendChild(el);
      drag.shape = el;
    }
    this.drag = drag;
  }

  private onMove(e: PointerEvent, ov: HTMLElement) {
    const d = this.drag;
    if (!d || d.overlay !== ov) return;
    const rect = ov.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    if (this.tool === "pen") {
      d.pts.push(x, y);
      d.shape?.setAttribute("points", pointsAttr(d.pts));
      return;
    }
    if (!d.shape) return;
    const [sx, sy] = d.start;
    const x1 = Math.min(sx, x);
    const y1 = Math.min(sy, y);
    const w = Math.abs(x - sx);
    const h = Math.abs(y - sy);
    if (d.shape instanceof SVGRectElement) {
      d.shape.setAttribute("x", String(x1));
      d.shape.setAttribute("y", String(y1));
      d.shape.setAttribute("width", String(w));
      d.shape.setAttribute("height", String(h));
    } else if (d.shape instanceof SVGEllipseElement) {
      d.shape.setAttribute("cx", String(x1 + w / 2));
      d.shape.setAttribute("cy", String(y1 + h / 2));
      d.shape.setAttribute("rx", String(w / 2));
      d.shape.setAttribute("ry", String(h / 2));
    }
  }

  private cancelDrag() {
    if (!this.drag) return;
    this.drag.shape?.remove();
    this.drag = null;
  }

  private async onUp(e: PointerEvent, ov: HTMLElement) {
    const d = this.drag;
    if (!d || d.overlay !== ov) return;
    this.drag = null;
    try {
      ov.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    const vp = this.viewport(d.page);
    if (!vp) {
      d.shape?.remove();
      return;
    }
    const rect = ov.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const toPdf = (cx: number, cy: number) => vp.convertToPdfPoint(cx, cy) as [number, number];
    const pageIndex = d.page - 1;
    const colorHex = this.color;
    const color = hexToRgb(colorHex);
    const meta: ann.AnnotMeta = { author: this.plugin.settings.author };
    const width = this.plugin.settings.strokeWidth;
    const [sx, sy] = d.start;
    const tiny = Math.abs(x - sx) < 4 && Math.abs(y - sy) < 4;
    // keep the preview shape on screen until the live layer takes over
    const dropPreview = () => d.shape?.remove();

    try {
      switch (this.tool) {
        case "pen": {
          d.pts.push(x, y);
          const flat: number[] = [];
          for (let i = 0; i < d.pts.length; i += 2) flat.push(...toPdf(d.pts[i], d.pts[i + 1]));
          await this.mutate((doc) => {
            const nm = ann.addInk(doc, pageIndex, [flat], color, width, 1, meta);
            this.undoStack.push({ page: pageIndex, nm });
            this.addLive(pageIndex, { nm, kind: "Ink", color: colorHex, width, path: flat });
          });
          break;
        }
        case "rect":
        case "ellipse": {
          if (tiny) return;
          const a = toPdf(sx, sy);
          const b = toPdf(x, y);
          const kind: ann.ShapeKind = this.tool === "rect" ? "Square" : "Circle";
          await this.mutate((doc) => {
            const nm = ann.addShape(doc, pageIndex, [a[0], a[1], b[0], b[1]], kind, color, width, 1, meta);
            this.undoStack.push({ page: pageIndex, nm });
            this.addLive(pageIndex, { nm, kind, color: colorHex, width, box: [a[0], a[1], b[0], b[1]] });
          });
          break;
        }
        case "note": {
          const p = toPdf(x, y);
          const existing = await this.findNoteAt(pageIndex, p[0], p[1], 3 / (vp.scale || 1));
          if (existing) {
            await this.openNoteEditor(existing);
            return;
          }
          const r = await formModal(this.plugin.app, t("tb_noteTitle"), [{ kind: "textarea", key: "c", label: t("tb_content"), rows: 5 }]);
          const text = r ? String(r.c).trim() : "";
          if (!text) return;
          await this.mutate((doc) => {
            const nm = ann.addNote(doc, pageIndex, p[0], p[1], color, { ...meta, contents: text });
            this.undoStack.push({ page: pageIndex, nm });
            this.addLive(pageIndex, {
              nm,
              kind: "Text",
              color: colorHex,
              width: 1,
              box: [p[0], p[1] - ann.NOTE_SIZE, p[0] + ann.NOTE_SIZE, p[1]],
              text,
            });
          });
          break;
        }
        case "text": {
          const a = toPdf(sx, sy);
          let b = toPdf(x, y);
          if (Math.abs(x - sx) < 12 || Math.abs(y - sy) < 12) b = [a[0] + 220, a[1] - 40];
          const r = await formModal(this.plugin.app, t("tb_textTitle"), [
            { kind: "textarea", key: "c", label: t("tb_content"), rows: 4 },
            { kind: "number", key: "size", label: t("wmSize"), value: this.plugin.settings.fontSize, min: 4 },
          ]);
          const text = r ? String(r.c).trim() : "";
          if (!text) return;
          const size = Number(r!.size) || this.plugin.settings.fontSize;
          await this.mutate(async (doc) => {
            const nm = await ann.addFreeText(doc, pageIndex, [a[0], a[1], b[0], b[1]], text, size, color, this.plugin.fontProvider(), meta);
            this.undoStack.push({ page: pageIndex, nm });
            this.addLive(pageIndex, { nm, kind: "FreeText", color: colorHex, width: 1, box: [a[0], a[1], b[0], b[1]], text, fontSize: size });
          });
          break;
        }
        case "eraser": {
          const p = toPdf(x, y);
          const tol = 4 / (vp.scale || 1);
          let hitNm: string | undefined;
          let found = false;
          await this.mutate(
            (doc) => {
              const hits = ann.annotationsAt(doc, pageIndex, p[0], p[1], tol);
              if (!hits.length) {
                new Notice(t("tb_nothingToErase"));
                return false;
              }
              found = true;
              hitNm = hits[0].nm;
              ann.removeAnnotation(doc, pageIndex, { ref: hits[0].ref });
              if (hitNm) this.undoStack = this.undoStack.filter((u) => u.nm !== hitNm);
              return true;
            },
            // an annotation pdf.js already rendered can only disappear through a reload
            () => found && !this.isLive(hitNm),
          );
          if (hitNm) this.removeLive(hitNm);
          break;
        }
      }
    } finally {
      dropPreview();
    }
  }

  /* ---------------------------------------------------------------- */
  /* Sticky notes: open / edit / delete                                 */
  /* ---------------------------------------------------------------- */

  /** Find a sticky note under a PDF-space point: live layer first, then the file. */
  private async findNoteAt(pageIndex: number, x: number, y: number, tol: number): Promise<NoteRef | null> {
    for (const a of this.live.get(pageIndex) ?? []) {
      if (a.kind !== "Text" || !a.box) continue;
      const [bx1, by1, bx2, by2] = a.box;
      if (x >= bx1 - tol && x <= bx2 + tol && y >= by1 - tol && y <= by2 + tol) return { page: pageIndex, nm: a.nm, text: a.text ?? "" };
    }
    const file = this.file;
    if (!file) return null;
    const L = await this.plugin.loadPdf(file, this.password);
    if (!L) return null;
    this.password = L.password;
    const hit = ann.annotationsAt(L.doc, pageIndex, x, y, tol).find((a) => a.subtype === "Text");
    if (!hit) return null;
    return { page: pageIndex, nm: hit.nm, ref: hit.ref, text: hit.contents ?? "" };
  }

  async openNoteEditor(n: NoteRef) {
    const r = await formModal(
      this.plugin.app,
      t("tb_noteTitle"),
      [
        { kind: "textarea", key: "c", label: t("tb_content"), rows: 6, value: n.text },
        { kind: "toggle", key: "del", label: t("tb_noteDelete"), value: false },
      ],
      t("save"),
    );
    if (!r) return;
    const live = this.isLive(n.nm);
    const match = { nm: n.nm, ref: n.ref };
    if (r.del) {
      await this.mutate(
        (doc) => ann.removeAnnotation(doc, n.page, match),
        () => !live,
      );
      if (n.nm) {
        this.removeLive(n.nm);
        this.undoStack = this.undoStack.filter((u) => u.nm !== n.nm);
      }
      return;
    }
    const text = String(r.c).trim();
    if (text === n.text) return;
    await this.mutate(
      (doc) => ann.setContents(doc, n.page, match, text),
      // pdf.js only shows the popup text it loaded; a baked note needs a reload to show the new text
      () => !live,
    );
    if (live) {
      for (const a of this.live.get(n.page) ?? []) if (a.nm === n.nm) a.text = text;
      this.liveVersion++;
      this.refreshOverlays();
    }
  }

  /* ---------------------------------------------------------------- */
  /* Text markup from selection                                         */
  /* ---------------------------------------------------------------- */

  private onMouseUp() {
    if (!MARKUP.includes(this.tool)) return;
    window.setTimeout(() => void this.applySelection(), 10);
  }

  private async applySelection() {
    const r = this.refs();
    if (!r || this.busy) return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    if (!r.viewerEl.contains(range.commonAncestorContainer)) return;

    const pages = this.pageDivs();
    const byPage = new Map<number, ann.Quad[]>();
    const seen = new Set<string>();
    for (const cr of Array.from(range.getClientRects())) {
      if (cr.width < 1 || cr.height < 1) continue;
      const key = [cr.left, cr.top, cr.width, cr.height].map((v) => Math.round(v)).join(",");
      if (seen.has(key)) continue;
      seen.add(key);
      const cx = (cr.left + cr.right) / 2;
      const cy = (cr.top + cr.bottom) / 2;
      const pd = pages.find((p) => {
        const b = p.getBoundingClientRect();
        return cx >= b.left && cx <= b.right && cy >= b.top && cy <= b.bottom;
      });
      if (!pd) continue;
      const n = Number(pd.dataset.pageNumber);
      const vp = this.viewport(n);
      if (!vp) continue;
      const baseEl = pd.querySelector(":scope > .pdftk-overlay") ?? pd.querySelector(".canvasWrapper") ?? pd;
      const base = baseEl.getBoundingClientRect();
      const c = (px: number, py: number) => vp.convertToPdfPoint(px - base.left, py - base.top) as [number, number];
      const ul = c(cr.left, cr.top);
      const ur = c(cr.right, cr.top);
      const ll = c(cr.left, cr.bottom);
      const lr = c(cr.right, cr.bottom);
      const q: ann.Quad = { x1: ul[0], y1: ul[1], x2: ur[0], y2: ur[1], x3: ll[0], y3: ll[1], x4: lr[0], y4: lr[1] };
      let list = byPage.get(n);
      if (!list) byPage.set(n, (list = []));
      list.push(q);
    }
    if (!byPage.size) return;
    const quote = this.plugin.settings.autoQuote && this.tool === "highlight" ? this.captureQuote(sel) : null;
    sel.removeAllRanges();

    const kind: ann.MarkupKind = this.tool === "highlight" ? "Highlight" : this.tool === "underline" ? "Underline" : "StrikeOut";
    const colorHex = this.color;
    const color = hexToRgb(colorHex);
    const meta: ann.AnnotMeta = { author: this.plugin.settings.author };
    await this.mutate((doc) => {
      for (const [n, quads] of byPage) {
        const nm = ann.addTextMarkup(doc, n - 1, quads, kind, color, 1, meta);
        this.undoStack.push({ page: n - 1, nm });
        this.addLive(n - 1, { nm, kind, color: colorHex, width: 1, quads });
      }
    });
    if (quote && this.file) {
      try {
        await appendQuote(this.plugin, this.file, quote, undefined, colorHex);
      } catch (err) {
        new Notice(t("failed", { msg: errMsg(err) }), 8000);
      }
    }
  }

  /* ---------------------------------------------------------------- */
  /* Other actions                                                      */
  /* ---------------------------------------------------------------- */

  private async undo() {
    const last = this.undoStack.pop();
    if (!last) {
      new Notice(t("tb_nothingToUndo"));
      return;
    }
    const live = this.isLive(last.nm);
    await this.mutate(
      (doc) => ann.removeAnnotation(doc, last.page, { nm: last.nm }),
      () => !live,
    );
    if (live) this.removeLive(last.nm);
  }

  currentPage(): number {
    const r = this.refs();
    return Number(r?.pv.currentPageNumber) || 1;
  }

  pageCount(): number {
    const r = this.refs();
    return Number(r?.pv.pagesCount) || 0;
  }

  /** Currently selected text inside this PDF view, or "". */
  selectedText(): string {
    const r = this.refs();
    const sel = window.getSelection();
    if (!r || !sel || sel.isCollapsed || sel.rangeCount === 0) return "";
    if (!r.viewerEl.contains(sel.getRangeAt(0).commonAncestorContainer)) return "";
    return sel.toString().replace(/-\n(?=[a-z])/g, "").replace(/[ \t]*\n[ \t]*/g, "\n").trim();
  }

  private textCache: { key: string; pages: string[] } | null = null;

  /** Text of every page (cached per file version). */
  async pageTexts(): Promise<string[]> {
    const file = this.file;
    if (!file) return [];
    const key = `${file.path}@${file.stat.mtime}:${file.stat.size}`;
    if (this.textCache?.key === key) return this.textCache.pages;
    const L = await this.plugin.loadPdf(file, this.password);
    if (!L) return [];
    this.password = L.password;
    const pages = await extractText(L.bytes, L.password);
    this.textCache = { key, pages };
    return pages;
  }

  private async rotateCurrentPage() {
    const n = this.currentPage();
    await this.mutate(
      (doc) => {
        const p = doc.getPage(n - 1);
        p.setRotation(degrees((p.getRotation().angle + 90) % 360));
      },
      () => true,
    );
  }

  private async clearPage() {
    const n = this.currentPage();
    const ok = await formModal(this.plugin.app, t("tb_clearPage"), [{ kind: "note", label: t("tb_clearConfirm", { n }) }]);
    if (!ok) return;
    await this.mutate(
      (doc) => {
        const count = ann.clearAnnotations(doc, n - 1);
        if (!count) {
          new Notice(t("tb_nothingToErase"));
          return false;
        }
        this.undoStack = this.undoStack.filter((u) => u.page !== n - 1);
        return true;
      },
      () => true,
    );
  }

  /* ---------------------------------------------------------------- */
  /* Write-back                                                         */
  /* ---------------------------------------------------------------- */

  /**
   * Load the current file, apply `fn`, save in place.
   * `needsReload` decides (after `fn` ran) whether the viewer must reload the document;
   * otherwise the reload is suppressed and the live layer shows the change.
   */
  private async mutate(
    fn: (doc: PDFDocument) => Promise<void | boolean> | void | boolean,
    needsReload: () => boolean = () => false,
  ) {
    const file = this.file;
    if (!file) return;
    if (this.busy) {
      new Notice(t("working"));
      return;
    }
    this.busy = true;
    this.el.addClass("is-busy");
    try {
      const L = await this.plugin.loadPdf(file, this.password);
      if (!L) return;
      this.password = L.password;
      const res = await fn(L.doc);
      if (res === false) return;
      const bytes = await L.doc.save({ useObjectStreams: true, updateFieldAppearances: false });
      const reload = needsReload() || !this.patchedOnLoadFile;
      if (reload) {
        const pos = this.capturePosition();
        await this.plugin.app.vault.modifyBinary(file, toArrayBuffer(bytes));
        this.restorePosition(pos, file);
      } else {
        this.suppressReload = true;
        try {
          await this.plugin.app.vault.modifyBinary(file, toArrayBuffer(bytes));
        } finally {
          // the vault fires "modify" right after the write; keep the guard up briefly
          window.setTimeout(() => (this.suppressReload = false), 1500);
        }
      }
    } catch (e) {
      console.error("[pdf-toolkit]", e);
      new Notice(t("failed", { msg: errMsg(e) }), 8000);
    } finally {
      this.busy = false;
      this.el.removeClass("is-busy");
    }
  }

  private capturePosition(): Position | null {
    const r = this.refs();
    if (!r) return null;
    return { doc: r.doc, page: r.pv.currentPageNumber, scrollTop: r.containerEl.scrollTop, scrollLeft: r.containerEl.scrollLeft, scale: r.pv.currentScaleValue };
  }

  /** Obsidian reloads the viewer after the file changes; put the user back where they were. */
  private restorePosition(pos: Position | null, file: TFile) {
    if (!pos) return;
    let tries = 0;
    let forced = false;
    const tick = () => {
      const r = this.refs();
      if (r && r.doc && r.doc !== pos.doc && r.pv.pagesCount > 0) {
        this.lastDoc = r.doc;
        this.clearLive();
        try {
          if (pos.scale && r.pv.currentScaleValue !== pos.scale) r.pv.currentScaleValue = pos.scale;
          r.pv.currentPageNumber = pos.page;
        } catch {
          /* ignore */
        }
        window.requestAnimationFrame(() => {
          const rr = this.refs();
          if (rr) {
            rr.containerEl.scrollTop = pos.scrollTop;
            rr.containerEl.scrollLeft = pos.scrollLeft;
          }
          this.sync();
        });
        return;
      }
      tries++;
      if (tries === 15 && !forced) {
        // The viewer did not pick up the change on its own — ask Obsidian to reload the view.
        forced = true;
        const leaf = this.view.leaf as Any;
        if (this.view.file === file && typeof leaf?.rebuildView === "function") leaf.rebuildView();
      }
      if (tries < 60) window.setTimeout(tick, 100);
    };
    window.setTimeout(tick, 100);
  }
}

function pointsAttr(pts: number[]): string {
  let s = "";
  for (let i = 0; i < pts.length; i += 2) s += `${pts[i]},${pts[i + 1]} `;
  return s.trim();
}
