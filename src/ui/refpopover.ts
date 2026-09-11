import { Component, Modal, Notice, setIcon } from "obsidian";
import type PdfToolkitPlugin from "../main";
import type { PdfToolbar } from "./toolbar";
import { Citation, RefEntry, RefList, citationAt, parseReferences, resolveCitation, scholarUrl } from "../pdf/references";
import { appendReference } from "./reading";
import { t } from "../i18n";
import { errMsg } from "../util";
import type { SavedSummary } from "../llm/summary-store";

/*
 * Hover a citation like [12] or (Smith et al., 2020) in the PDF text layer → a card with the
 * reference entry, links (Google Scholar / DOI / arXiv / URL), jump-to-entry and add-to-note.
 */

export class RefPopover extends Component {
  private el: HTMLElement | null = null;
  private hideTimer: number | null = null;
  private lastMove = 0;
  private shownKey = "";
  private list: RefList | null | undefined;
  private listFor = "";
  private parsing: Promise<RefList | null> | null = null;
  private parsingFor = "";
  private pendingKey = "";
  private generation = 0;
  private summaryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private plugin: PdfToolkitPlugin,
    private toolbar: PdfToolbar,
  ) {
    super();
  }

  attach(content: HTMLElement) {
    this.registerDomEvent(content, "mousemove", (e) => this.onMove(e));
    this.registerDomEvent(content, "mouseleave", () => this.scheduleHide());
    this.registerDomEvent(content, "scroll", () => this.hide(), { capture: true });
  }

  onunload() {
    this.hide();
  }

  /* ---------------------------------------------------------------- */

  async getList(): Promise<RefList | null> {
    const path = this.toolbar.file?.path ?? "";
    if (this.list !== undefined && this.listFor === path) return this.list;
    if (this.parsing && this.parsingFor === path) return this.parsing;
    this.parsingFor = path;
    this.parsing = (async () => {
      let result: RefList | null = null;
      try {
        const pages = await this.toolbar.pageTexts();
        result = parseReferences(pages);
      } catch {
        /* Leave the normal reference UI available if text extraction fails. */
      }
      if (this.toolbar.file?.path !== path) return null;
      this.list = result;
      this.listFor = path;
      if (this.parsingFor === path) this.parsing = null;
      return result;
    })();
    return this.parsing;
  }

  private onMove(e: MouseEvent) {
    if (!this.plugin.settings.refHover) return;
    const now = Date.now();
    if (now - this.lastMove < 60) return;
    this.lastMove = now;
    const target = e.target as HTMLElement | null;
    if (this.el && target && this.el.contains(target)) {
      this.cancelHide();
      return;
    }
    let span = target?.closest<HTMLElement>(".textLayer span");
    // PDF link annotations sit above the text layer. Locate the text underneath the link.
    const annotation = target?.closest<HTMLElement>(".annotationLayer a");
    if (!span && annotation) {
      const page = annotation.closest<HTMLElement>(".page");
      span = Array.from(page?.querySelectorAll<HTMLElement>(".textLayer span") ?? []).find((el) => {
        const rect = el.getBoundingClientRect();
        return e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom;
      });
    }
    if (!span) {
      this.scheduleHide();
      return;
    }
    const doc = span.ownerDocument;
    const range = doc.caretRangeFromPoint?.(e.clientX, e.clientY);
    if (!range && !annotation) return;
    // Citations can be split over neighbouring spans ("[" "12" "]"): look at prev + this + next.
    const prev = span.previousElementSibling?.textContent ?? "";
    const own = span.textContent ?? "";
    const next = span.nextElementSibling?.textContent ?? "";
    const text = prev + own + next;
    let offset = prev.length;
    if (range && span.contains(range.startContainer)) offset += range.startOffset;
    else offset += Math.floor(own.length / 2);
    let cit = citationAt(text, offset);
    if (!cit && annotation && /(?:cite|bib|ref)/i.test(annotation.getAttribute("href") ?? "") && /^\d{1,3}$/.test(own.trim())) {
      cit = { raw: own, start: 0, end: own.length, numbers: [Number(own.trim())] };
    }
    if (!cit) {
      this.scheduleHide();
      return;
    }
    const key = `${this.toolbar.file?.path}|${cit.raw}`;
    if (key === this.shownKey && this.el) {
      this.cancelHide();
      return;
    }
    if (key === this.pendingKey) return;
    this.pendingKey = key;
    void this.showFor(cit, key, span);
  }

  private async showFor(cit: Citation, key: string, anchor: HTMLElement) {
    const generation = this.generation;
    const list = await this.getList();
    if (generation !== this.generation || this.pendingKey !== key) return;
    this.pendingKey = "";
    if (!list) return;
    const entries = resolveCitation(list, cit);
    if (!entries.length) return;
    if (!anchor.isConnected) return;
    this.render(entries, anchor.getBoundingClientRect(), anchor.ownerDocument);
    this.shownKey = key;
  }

  private render(entries: RefEntry[], at: DOMRect, doc: Document) {
    this.hide();
    const el = doc.body.createDiv("pdftk-refpop");
    this.el = el;
    el.addEventListener("mouseenter", () => this.cancelHide());
    el.addEventListener("mouseleave", () => this.scheduleHide());
    for (const [index, e] of entries.slice(0, 6).entries()) this.renderEntry(el, e, false, index === 0 && this.plugin.settings.refAutoSummary);
    // position: below the citation, clamped to the viewport
    const vw = doc.documentElement.clientWidth;
    const vh = doc.documentElement.clientHeight;
    const w = Math.min(460, vw - 24);
    el.style.width = `${w}px`;
    let left = Math.max(12, Math.min(at.left, vw - w - 12));
    let top = at.bottom + 6;
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
    const h = el.offsetHeight;
    if (top + h > vh - 8) {
      top = Math.max(8, at.top - h - 6);
      el.style.top = `${top}px`;
    }
    left = Math.max(12, Math.min(left, vw - el.offsetWidth - 12));
    el.style.left = `${left}px`;
    el.style.maxHeight = `${Math.max(80, vh - top - 8)}px`;
  }

  renderEntry(parent: HTMLElement, e: RefEntry, compact = false, autoSummary = false) {
    const row = parent.createDiv("pdftk-refpop-entry");
    const head = row.createDiv("pdftk-refpop-head");
    head.createSpan({ text: e.num !== undefined ? `[${e.num}]` : e.firstAuthor ? `${e.firstAuthor} ${e.year ?? ""}` : "•", cls: "pdftk-refpop-num" });
    if (e.title) head.createSpan({ text: e.title, cls: "pdftk-refpop-title" });
    row.createDiv({ text: e.text, cls: "pdftk-refpop-text" });
    const links = row.createDiv("pdftk-refpop-links");
    const link = (label: string, url: string, icon?: string) => {
      const a = links.createEl("a", { text: label, href: url, cls: "pdftk-refpop-link" });
      a.target = "_blank";
      a.rel = "noopener";
      if (icon) {
        const ic = a.createSpan();
        setIcon(ic, icon);
        a.prepend(ic);
      }
    };
    link(t("ref_scholar"), scholarUrl(e), "graduation-cap");
    if (e.doi) link("DOI", `https://doi.org/${e.doi}`, "link");
    if (e.arxiv) link("arXiv", `https://arxiv.org/abs/${e.arxiv}`, "file-text");
    if (e.url && !e.doi && !e.arxiv) link("URL", e.url, "external-link");
    if (!compact) {
      const go = links.createEl("button", { text: t("ref_goto", { n: e.page }), cls: "pdftk-chat-chip" });
      go.onclick = () => {
        this.toolbar.goToPage(e.page);
        this.hide();
      };
    }
    const ask = links.createEl("button", { text: t("ref_ask"), cls: "pdftk-chat-chip" });
    ask.onclick = () => {
      this.hide();
      const label = e.num !== undefined ? `[${e.num}]` : `${e.firstAuthor ?? ""} ${e.year ?? ""}`.trim();
      void this.plugin.askAiAboutReference(e.text, label);
    };
    const add = links.createEl("button", { text: t("ref_addNote"), cls: "pdftk-chat-chip" });
    add.onclick = async () => {
      const file = this.toolbar.file;
      if (!file) return;
      try {
        await appendReference(this.plugin, file, e, scholarUrl(e));
      } catch (err) {
        new Notice(t("failed", { msg: errMsg(err) }));
      }
    };
    const summary = row.createDiv("pdftk-ref-summary");
    const summaryHead = summary.createDiv("pdftk-ref-summary-head");
    summaryHead.createSpan({ text: t("ref_summary"), cls: "pdftk-ref-summary-title" });
    const start = summaryHead.createEl("button", { text: t("ref_summaryStart"), cls: "pdftk-chat-chip" });
    const body = summary.createDiv({ text: t("ref_summaryHint"), cls: "pdftk-ref-summary-body" });
    body.setAttr("role", "status");
    const source = summary.createDiv("pdftk-ref-summary-source");
    const store = this.plugin.summaryStore;
    let active = false;
    const showSaved = (record: SavedSummary) => {
      if (!row.isConnected) return;
      body.setText(record.status === "done" ? record.text : record.status === "missing" ? t("ref_summaryMissing") : t("ref_summaryFailed", { msg: record.text }));
      start.setText(t("ref_regenerate"));
      source.empty();
      if (record.evidence) {
        const a = source.createEl("a", { text: `${t("ref_summarySource")} · ${record.evidence.provider}`, href: record.evidence.url });
        a.target = "_blank";
        a.rel = "noopener";
        const abstract = source.createEl("details");
        abstract.createEl("summary", { text: t("ref_viewAbstract") });
        abstract.createDiv({ text: record.evidence.abstract, cls: "pdftk-ref-abstract" });
      }
    };
    const run = async (force = false) => {
      if (!store) return;
      active = true;
      start.setText(t("chat_stop"));
      body.setText(t("ref_summaryLoading"));
      try {
        const settings = this.plugin.settings;
        const record = await store.generate(e, { ...settings,
          llmModel: settings.refSummaryModel.trim() || settings.llmModel,
          llmEffort: settings.refSummaryModel.trim() ? "" : settings.llmEffort,
        }, this.plugin.vaultPath(), t("ref_summaryLanguage"), force);
        showSaved(record);
      } catch (err) {
        if (row.isConnected) {
          body.setText(t("ref_summaryFailed", { msg: errMsg(err) }));
          start.setText(t("ref_regenerate"));
        }
      } finally { active = false; }
    };
    start.onclick = () => {
      if (autoSummary && this.summaryTimer !== null) clearTimeout(this.summaryTimer);
      this.summaryTimer = null;
      if (active || store?.pending(e)) { store?.stop(e); return; }
      void run(true);
    };
    void (async () => {
      if (!store) return;
      try {
        const saved = await store.get(e);
        if (!row.isConnected) return;
        if (store.pending(e)) { await run(); return; }
        if (saved) { showSaved(saved); return; }
        if (autoSummary) this.summaryTimer = setTimeout(() => {
          this.summaryTimer = null;
          if (row.isConnected && !active && this.plugin.settings.refAutoSummary) void run();
        }, 650);
      } catch (err) { if (row.isConnected) body.setText(t("ref_summaryFailed", { msg: errMsg(err) })); }
    })();
  }

  private scheduleHide() {
    this.pendingKey = "";
    if (this.hideTimer !== null || !this.el) return;
    this.hideTimer = window.setTimeout(() => {
      this.hideTimer = null;
      this.hide();
    }, 300);
  }

  private cancelHide() {
    if (this.hideTimer !== null) {
      window.clearTimeout(this.hideTimer);
      this.hideTimer = null;
    }
  }

  hide() {
    this.generation++;
    this.pendingKey = "";
    if (this.summaryTimer !== null) clearTimeout(this.summaryTimer);
    this.summaryTimer = null;
    this.cancelHide();
    this.el?.remove();
    this.el = null;
    this.shownKey = "";
  }

  /** Modal with every parsed reference. */
  async openList() {
    const n = new Notice(t("ref_parsing"), 0);
    let list: RefList | null;
    try {
      list = await this.getList();
    } finally {
      n.hide();
    }
    if (!list || !list.entries.length) {
      new Notice(t("ref_none"));
      return;
    }
    const self = this;
    new (class extends Modal {
      onOpen() {
        this.modalEl.addClass("pdftk-reflist-modal");
        this.contentEl.addClass("pdf-toolkit-modal");
        this.contentEl.createEl("h2", { text: `${t("tb_refs")} (${list!.entries.length})` });
        const box = this.contentEl.createDiv("pdftk-reflist");
        for (const e of list!.entries) self.renderEntry(box, e);
      }
      onClose() {
        this.contentEl.empty();
      }
    })(this.plugin.app).open();
  }
}
