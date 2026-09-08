import { ItemView, WorkspaceLeaf } from "obsidian";
import type PdfToolkitPlugin from "../main";
import type { RefList } from "../pdf/references";
import { t } from "../i18n";

export const REFS_VIEW = "pdf-toolkit-refs";

/** Sidebar listing every reference of the active PDF, searchable, with links and actions. */
export class RefsView extends ItemView {
  private searchEl!: HTMLInputElement;
  private statusEl!: HTMLElement;
  private listEl!: HTMLElement;
  private list: RefList | null = null;
  private forPath = "";
  private filter = "";
  private loading = false;

  constructor(
    leaf: WorkspaceLeaf,
    private plugin: PdfToolkitPlugin,
  ) {
    super(leaf);
  }

  getViewType() {
    return REFS_VIEW;
  }
  getDisplayText() {
    return t("tb_refs");
  }
  getIcon() {
    return "book-marked";
  }

  async onOpen() {
    const root = this.contentEl;
    root.empty();
    root.addClass("pdftk-refs");
    const head = root.createDiv("pdftk-refs-head");
    this.searchEl = head.createEl("input", { type: "search", placeholder: t("refs_search") });
    this.searchEl.addEventListener("input", () => {
      this.filter = this.searchEl.value.trim().toLowerCase();
      this.render();
    });
    this.statusEl = head.createDiv("pdftk-refs-status");
    this.listEl = root.createDiv("pdftk-refs-list");
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => void this.refresh()));
    this.registerEvent(this.app.workspace.on("file-open", () => void this.refresh()));
    await this.refresh();
  }

  async refresh(force = false) {
    const tb = this.plugin.chatTarget();
    const file = tb?.file;
    if (!tb || !file) {
      this.list = null;
      this.forPath = "";
      this.statusEl.setText(t("chat_noPdf"));
      this.listEl.empty();
      return;
    }
    if (!force && this.forPath === file.path && this.list) {
      this.render();
      return;
    }
    if (this.loading) return;
    this.loading = true;
    this.statusEl.setText(t("ref_parsing"));
    try {
      this.list = await tb.refPop.getList();
      this.forPath = file.path;
    } finally {
      this.loading = false;
    }
    this.render();
  }

  private render() {
    const tb = this.plugin.chatTarget();
    this.listEl.empty();
    if (!this.list || !this.list.entries.length || !tb) {
      this.statusEl.setText(this.forPath ? t("ref_none") : t("chat_noPdf"));
      return;
    }
    const f = this.filter;
    const entries = f
      ? this.list.entries.filter((e) => [e.text, e.title ?? "", e.firstAuthor ?? "", e.year ?? "", String(e.num ?? "")].join(" ").toLowerCase().includes(f))
      : this.list.entries;
    this.statusEl.setText(`${tb.file?.basename ?? ""} · ${entries.length}/${this.list.entries.length}`);
    for (const e of entries) tb.refPop.renderEntry(this.listEl, e);
  }
}
