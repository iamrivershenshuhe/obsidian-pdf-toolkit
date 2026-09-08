import { App, Modal, Notice, setIcon } from "obsidian";
import { t } from "../i18n";
import { PagePlanItem } from "../pdf/ops";
import { openWithPdfJs, renderPageToCanvas } from "../pdf/pdfjs";

interface Item extends PagePlanItem {
  id: number;
  selected: boolean;
  thumb?: string;
  aspect: number;
}

export interface OrganizeCallbacks {
  onSave: (plan: PagePlanItem[]) => Promise<void>;
  onExtract: (indices: number[]) => Promise<void>;
}

export class OrganizeModal extends Modal {
  private items: Item[] = [];
  private gridEl!: HTMLElement;
  private statusEl!: HTMLElement;
  private cancelled = false;
  private dragFrom: number | null = null;

  constructor(
    app: App,
    private fileName: string,
    private bytes: Uint8Array,
    private pageCount: number,
    private thumbWidth: number,
    private password: string | undefined,
    private cb: OrganizeCallbacks,
  ) {
    super(app);
  }

  onOpen() {
    const { contentEl, modalEl } = this;
    modalEl.addClass("pdf-toolkit-organize-modal");
    contentEl.addClass("pdf-toolkit-modal", "pdf-toolkit-organize");
    contentEl.createEl("h2", { text: `${t("tool_organize")} — ${this.fileName}` });
    contentEl.createEl("p", { text: t("orgDragHint"), cls: "pdf-toolkit-note" });

    for (let i = 0; i < this.pageCount; i++)
      this.items.push({ id: i, srcIndex: i, rotate: 0, deleted: false, selected: false, aspect: 1.414 });

    const bar = contentEl.createDiv("pdf-toolkit-toolbar");
    const btn = (label: string, icon: string, fn: () => void, cta = false) => {
      const b = bar.createEl("button", { cls: cta ? "mod-cta" : "" });
      const ic = b.createSpan();
      setIcon(ic, icon);
      b.createSpan({ text: " " + label });
      b.onclick = fn;
      return b;
    };
    btn(t("orgSelectAll"), "check-square", () => this.setAll(true));
    btn(t("orgSelectNone"), "square", () => this.setAll(false));
    btn(t("orgRotateSelected"), "rotate-cw", () => this.forSelected((it) => (it.rotate = (it.rotate + 90) % 360)));
    btn(t("orgDeleteSelected"), "trash", () => this.forSelected((it) => (it.deleted = !it.deleted)));
    btn(t("orgExtractSelected"), "file-output", () => this.extract());

    this.statusEl = contentEl.createDiv("pdf-toolkit-status");
    this.gridEl = contentEl.createDiv("pdf-toolkit-grid");
    this.gridEl.style.setProperty("--pdf-thumb-w", `${this.thumbWidth}px`);
    this.renderGrid();

    const footer = contentEl.createDiv("pdf-toolkit-footer");
    const cancel = footer.createEl("button", { text: t("cancel") });
    cancel.onclick = () => this.close();
    const save = footer.createEl("button", { text: t("orgSave"), cls: "mod-cta" });
    save.onclick = () => this.save();

    void this.renderThumbs();
  }

  private setAll(v: boolean) {
    this.items.forEach((it) => (it.selected = v));
    this.renderGrid();
  }

  private forSelected(fn: (it: Item) => void) {
    let n = 0;
    for (const it of this.items) if (it.selected) (fn(it), n++);
    if (!n) return;
    this.renderGrid();
  }

  private async renderThumbs() {
    this.statusEl.setText(t("orgLoading"));
    let doc;
    try {
      doc = await openWithPdfJs(this.bytes, this.password);
    } catch (e) {
      this.statusEl.setText(String(e));
      return;
    }
    try {
      for (let i = 0; i < this.pageCount; i++) {
        if (this.cancelled) break;
        const canvas = await renderPageToCanvas(doc, i + 1, { width: this.thumbWidth * 2 });
        const item = this.items.find((x) => x.id === i);
        if (item) {
          item.thumb = canvas.toDataURL("image/jpeg", 0.8);
          item.aspect = canvas.height / canvas.width;
          this.updateCard(item);
        }
        canvas.width = 0;
        canvas.height = 0;
        this.statusEl.setText(`${t("orgLoading")} ${i + 1}/${this.pageCount}`);
      }
      this.statusEl.setText("");
    } finally {
      await doc.destroy();
    }
  }

  private cardEls = new Map<number, HTMLElement>();

  private renderGrid() {
    this.gridEl.empty();
    this.cardEls.clear();
    this.items.forEach((item, pos) => {
      const card = this.gridEl.createDiv("pdf-toolkit-card");
      card.draggable = true;
      card.dataset.pos = String(pos);
      this.cardEls.set(item.id, card);
      this.fillCard(card, item, pos);

      card.addEventListener("click", (e) => {
        if ((e.target as HTMLElement).closest("button")) return;
        item.selected = !item.selected;
        card.toggleClass("is-selected", item.selected);
      });
      card.addEventListener("dragstart", (e) => {
        this.dragFrom = pos;
        card.addClass("is-dragging");
        e.dataTransfer?.setData("text/plain", String(pos));
      });
      card.addEventListener("dragend", () => card.removeClass("is-dragging"));
      card.addEventListener("dragover", (e) => {
        e.preventDefault();
        card.addClass("is-dragover");
      });
      card.addEventListener("dragleave", () => card.removeClass("is-dragover"));
      card.addEventListener("drop", (e) => {
        e.preventDefault();
        card.removeClass("is-dragover");
        const from = this.dragFrom;
        this.dragFrom = null;
        if (from === null || from === pos) return;
        const [moved] = this.items.splice(from, 1);
        this.items.splice(pos, 0, moved);
        this.renderGrid();
      });
    });
  }

  private fillCard(card: HTMLElement, item: Item, pos: number) {
    card.empty();
    card.toggleClass("is-selected", item.selected);
    card.toggleClass("is-deleted", item.deleted);
    const thumbWrap = card.createDiv("pdf-toolkit-thumb");
    thumbWrap.style.height = `${Math.round(this.thumbWidth * Math.max(item.aspect, 0.5))}px`;
    if (item.thumb) {
      const img = thumbWrap.createEl("img");
      img.src = item.thumb;
      img.style.transform = `rotate(${item.rotate}deg)`;
      if (item.rotate % 180 !== 0) img.addClass("is-rotated");
    } else {
      thumbWrap.createDiv("pdf-toolkit-thumb-placeholder");
    }
    const label = card.createDiv("pdf-toolkit-card-label");
    label.setText(`${pos + 1}  (p.${item.srcIndex + 1}${item.rotate ? `, ${item.rotate}°` : ""})`);
    const actions = card.createDiv("pdf-toolkit-card-actions");
    const mk = (icon: string, title: string, fn: () => void) => {
      const b = actions.createEl("button", { attr: { "aria-label": title, title } });
      setIcon(b, icon);
      b.onclick = (e) => {
        e.stopPropagation();
        fn();
        this.fillCard(card, item, pos);
      };
    };
    mk("rotate-ccw", t("orgRotateLeft"), () => (item.rotate = (item.rotate + 270) % 360));
    mk("rotate-cw", t("orgRotateRight"), () => (item.rotate = (item.rotate + 90) % 360));
    mk(item.deleted ? "undo" : "trash", t("orgDelete"), () => (item.deleted = !item.deleted));
  }

  private updateCard(item: Item) {
    const card = this.cardEls.get(item.id);
    if (!card) return;
    const pos = this.items.indexOf(item);
    this.fillCard(card, item, pos);
  }

  private async save() {
    const plan: PagePlanItem[] = this.items.map(({ srcIndex, rotate, deleted }) => ({ srcIndex, rotate, deleted }));
    if (!plan.some((p) => !p.deleted)) {
      new Notice(t("orgNothing"));
      return;
    }
    await this.cb.onSave(plan);
    this.close();
  }

  private async extract() {
    const sel = this.items.filter((it) => it.selected && !it.deleted).map((it) => it.srcIndex);
    if (!sel.length) return;
    await this.cb.onExtract(sel);
  }

  onClose() {
    this.cancelled = true;
    this.contentEl.empty();
  }
}
