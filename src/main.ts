import {
  App,
  FileView,
  FuzzySuggestModal,
  Menu,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  normalizePath,
} from "obsidian";
import * as fs from "fs";
import * as path from "path";
import { Lang, setLang, t, Keys } from "./i18n";
import {
  errMsg,
  ensureFolder,
  folderOf,
  formatBytes,
  isImage,
  isPdf,
  joinPath,
  parsePageOrder,
  parsePageRange,
  sanitizeName,
  toArrayBuffer,
  uniquePath,
  PAPER_SIZES,
  DARK_MODES,
  DarkMode,
} from "./util";
import * as ops from "./pdf/ops";
import { EncryptedError, FontProvider, PDFDocument } from "./pdf/ops";
import { extractText, renderPagesToPng } from "./pdf/pdfjs";
import { FieldSpec, FormValues, formModal, pickFilesOrdered, pickOneFile, promptPageRange, promptPassword, showInfoModal } from "./ui/modals";
import { OrganizeModal } from "./ui/organize";
import { PdfToolbar } from "./ui/toolbar";
import { ensurePaperFolder, exportBuiltinTemplate, listTemplates, openReadingNote } from "./ui/reading";
import { CHAT_VIEW, ChatContext, ChatView, CtxMode } from "./ui/chat";
import { REFS_VIEW, RefsView } from "./ui/refsview";
import { ensureDarkFilters, removeDarkFilters } from "./ui/darkmode";
import type { LlmProvider } from "./llm/runner";

/* ------------------------------------------------------------------ */
/* Settings                                                             */
/* ------------------------------------------------------------------ */

interface Settings {
  outputMode: "new" | "overwrite";
  outputFolder: string;
  fontPath: string;
  language: Lang | "auto";
  thumbWidth: number;
  ribbon: boolean;
  showToolbar: boolean;
  author: string;
  highlightColor: string;
  drawColor: string;
  strokeWidth: number;
  fontSize: number;
  darkMode: DarkMode;
  darkBg: string;
  darkText: string;
  readingFolder: string;
  autoQuote: boolean;
  llmProvider: LlmProvider;
  llmClaudePath: string;
  llmCodexPath: string;
  llmCustomCommand: string;
  llmModel: string;
  llmExtraPath: string;
  llmMaxChars: number;
  templatesFolder: string;
  /** "builtin" | "ask" | vault path of a template file */
  defaultTemplate: string;
  customPrompts: CustomPrompt[];
  hideBuiltinPrompts: boolean;
  refHover: boolean;
  organizeFolders: boolean;
  refQuestion: string;
}

export interface CustomPrompt {
  name: string;
  mode: CtxMode;
  prompt: string;
}



const DEFAULT_SETTINGS: Settings = {
  outputMode: "new",
  outputFolder: "",
  fontPath: "",
  language: "auto",
  thumbWidth: 140,
  ribbon: true,
  showToolbar: true,
  author: "",
  highlightColor: "#ffe11a",
  drawColor: "#f85149",
  strokeWidth: 2,
  fontSize: 12,
  darkMode: "off",
  darkBg: "#1f1f1f",
  darkText: "#c3c2b7",
  readingFolder: "",
  autoQuote: false,
  llmProvider: "claude",
  llmClaudePath: "",
  llmCodexPath: "",
  llmCustomCommand: "",
  llmModel: "",
  llmExtraPath: "",
  llmMaxChars: 60000,
  templatesFolder: "",
  defaultTemplate: "builtin",
  customPrompts: [],
  hideBuiltinPrompts: false,
  refHover: true,
  organizeFolders: true,
  refQuestion: "",
};

/* ------------------------------------------------------------------ */
/* Tool registry                                                        */
/* ------------------------------------------------------------------ */

interface Tool {
  id: string;
  name: Keys;
  desc: Keys;
  icon: string;
  /** false → tool does not need a PDF (merge, images→pdf) */
  needsPdf: boolean;
  run: (file: TFile | null) => Promise<void>;
}

/** A loaded document plus the password that opened it (for pdf.js re-opens). */
interface Loaded {
  doc: PDFDocument;
  bytes: Uint8Array;
  password?: string;
  encrypted: boolean;
}

export default class PdfToolkitPlugin extends Plugin {
  settings: Settings = DEFAULT_SETTINGS;
  tools: Tool[] = [];
  private fontCache: { path: string; bytes: Uint8Array } | null = null;
  private toolbars = new Map<FileView, PdfToolbar>();

  async onload() {
    await this.loadSettings();
    setLang(this.settings.language);
    this.buildTools();

    this.addCommand({
      id: "open-toolbox",
      name: t("toolbox"),
      callback: () => this.openToolbox(this.getActivePdf()),
    });

    for (const tool of this.tools) {
      this.addCommand({
        id: tool.id,
        name: t(tool.name),
        checkCallback: (checking) => {
          const file = this.getActivePdf();
          if (tool.needsPdf && !file) return false;
          if (!checking) void this.runTool(tool, file);
          return true;
        },
      });
    }

    if (this.settings.ribbon) {
      this.addRibbonIcon("file-text", t("toolbox"), () => this.openToolbox(this.getActivePdf()));
    }

    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        if (!isPdf(file)) return;
        menu.addSeparator();
        menu.addItem((item) => {
          item.setTitle(t("toolboxMenu")).setIcon("file-text");
          const withSub = item as unknown as { setSubmenu?: () => Menu };
          if (typeof withSub.setSubmenu !== "function") {
            item.onClick(() => this.openToolbox(file));
            return;
          }
          const sub: Menu = withSub.setSubmenu();
          for (const tool of this.tools) {
            sub.addItem((si) =>
              si
                .setTitle(t(tool.name))
                .setIcon(tool.icon)
                .onClick(() => void this.runTool(tool, file)),
            );
          }
        });
      }),
    );

    this.registerEvent(
      this.app.workspace.on("files-menu", (menu, files) => {
        const pdfs = files.filter(isPdf);
        if (pdfs.length < 2) return;
        menu.addItem((item) =>
          item
            .setTitle(`${t("tool_merge")} (${pdfs.length})`)
            .setIcon("merge")
            .onClick(() => void this.mergeTool(pdfs)),
        );
      }),
    );

    this.addSettingTab(new PdfToolkitSettingTab(this.app, this));

    this.addCommand({
      id: "reading-note",
      name: t("tb_readingNote"),
      checkCallback: (checking) => {
        const file = this.getActivePdf();
        if (!file) return false;
        if (!checking) void openReadingNote(this, file).catch((e) => new Notice(t("failed", { msg: errMsg(e) })));
        return true;
      },
    });
    this.addCommand({
      id: "list-references",
      name: t("ref_list"),
      checkCallback: (checking) => {
        const tb = this.getActiveToolbar();
        if (!tb) return false;
        if (!checking) void tb.refPop.openList();
        return true;
      },
    });
    this.addCommand({
      id: "reading-note-from-template",
      name: t("cmd_noteFromTemplate"),
      checkCallback: (checking) => {
        const file = this.getActivePdf();
        if (!file) return false;
        if (!checking) void openReadingNote(this, file, "ask").catch((e) => new Notice(t("failed", { msg: errMsg(e) })));
        return true;
      },
    });
    this.addCommand({
      id: "export-reading-template",
      name: t("cmd_exportTemplate"),
      callback: () => void exportBuiltinTemplate(this).catch((e) => new Notice(t("failed", { msg: errMsg(e) }))),
    });
    this.addCommand({
      id: "quote-selection",
      name: t("tb_quote"),
      checkCallback: (checking) => {
        const tb = this.getActiveToolbar();
        if (!tb) return false;
        if (!checking) void tb.quoteSelection();
        return true;
      },
    });
    this.addCommand({
      id: "toggle-dark",
      name: t("tb_dark"),
      callback: () => {
        const i = DARK_MODES.indexOf(this.settings.darkMode);
        void this.setDarkMode(DARK_MODES[(i + 1) % DARK_MODES.length]);
      },
    });

    this.registerView(CHAT_VIEW, (leaf) => new ChatView(leaf, this));
    this.addCommand({ id: "open-chat", name: t("tb_chat"), callback: () => void this.openChat() });
    this.registerView(REFS_VIEW, (leaf) => new RefsView(leaf, this));
    this.addCommand({ id: "open-refs", name: t("cmd_openRefs"), callback: () => void this.openRefsView() });
    this.addCommand({
      id: "organize-folder",
      name: t("cmd_organize"),
      checkCallback: (checking) => {
        const file = this.getActivePdf();
        if (!file) return false;
        if (!checking) void ensurePaperFolder(this, file).catch((e) => new Notice(t("failed", { msg: errMsg(e) })));
        return true;
      },
    });
    ensureDarkFilters(this.settings.darkBg, this.settings.darkText);

    // Annotation toolbar on every PDF view
    this.registerEvent(this.app.workspace.on("layout-change", () => this.ensureToolbars()));
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.ensureToolbars()));
    this.registerEvent(this.app.workspace.on("file-open", () => this.ensureToolbars()));
    this.app.workspace.onLayoutReady(() => this.ensureToolbars());
  }

  onunload() {
    this.removeToolbars();
    removeDarkFilters();
  }

  private lastToolbar: PdfToolbar | null = null;

  /** The PDF the chat panel talks about: the active PDF view, else the most recently active one. */
  chatTarget(): PdfToolbar | null {
    const active = this.getActiveToolbar();
    if (active) this.lastToolbar = active;
    if (this.lastToolbar && this.lastToolbar.view.containerEl.isConnected) return this.lastToolbar;
    this.lastToolbar = null;
    for (const tb of this.toolbars.values()) return tb;
    return null;
  }

  async getChatContext(mode: CtxMode): Promise<ChatContext | null> {
    const tb = this.chatTarget();
    const file = tb?.file;
    if (!tb || !file || mode === "reference") return null;
    const max = Math.max(2000, this.settings.llmMaxChars || 60000);
    const page = tb.currentPage();
    const total = tb.pageCount();
    let text = "";
    if (mode === "selection") {
      text = tb.selectedText();
    } else {
      const pages = await tb.pageTexts();
      if (mode === "page") text = pages[page - 1] ?? "";
      else text = pages.map((p, i) => `--- page ${i + 1} ---\n${p}`).join("\n\n");
    }
    const truncated = text.length > max;
    if (truncated) text = text.slice(0, max) + "\n…(truncated)";
    return { fileName: file.name, filePath: file.path, page, total: total || (await tb.pageTexts()).length, mode, text, truncated };
  }

  vaultPath(): string {
    const adapter = this.app.vault.adapter as { getBasePath?: () => string };
    return typeof adapter.getBasePath === "function" ? adapter.getBasePath() : process.cwd();
  }

  async openChat(): Promise<ChatView | null> {
    let leaf = this.app.workspace.getLeavesOfType(CHAT_VIEW)[0];
    if (!leaf) {
      const l = this.app.workspace.getRightLeaf(false);
      if (!l) return null;
      await l.setViewState({ type: CHAT_VIEW, active: true });
      leaf = l;
    }
    await this.app.workspace.revealLeaf(leaf);
    return leaf.view instanceof ChatView ? leaf.view : null;
  }

  async openRefsView() {
    let leaf = this.app.workspace.getLeavesOfType(REFS_VIEW)[0];
    if (!leaf) {
      const l = this.app.workspace.getLeftLeaf(false);
      if (!l) return;
      await l.setViewState({ type: REFS_VIEW, active: true });
      leaf = l;
    }
    await this.app.workspace.revealLeaf(leaf);
    if (leaf.view instanceof RefsView) void leaf.view.refresh(true);
  }

  async askAiAboutReference(text: string, label: string) {
    const view = await this.openChat();
    if (!view) return;
    view.askReference(text, label);
  }

  ensureToolbars() {
    // drop toolbars whose view is gone
    for (const [view, tb] of this.toolbars) {
      if (!view.containerEl.isConnected) {
        view.removeChild(tb);
        this.toolbars.delete(view);
      }
    }
    if (!this.settings.showToolbar) return;
    this.app.workspace.iterateAllLeaves((leaf) => {
      const view = leaf.view;
      if (view.getViewType() !== "pdf" || !(view instanceof FileView)) return;
      if (this.toolbars.has(view)) return;
      const tb = new PdfToolbar(this, view);
      view.addChild(tb);
      this.toolbars.set(view, tb);
    });
  }

  removeToolbars() {
    for (const [view, tb] of this.toolbars) view.removeChild(tb);
    this.toolbars.clear();
  }

  getActiveToolbar(): PdfToolbar | null {
    const view = this.app.workspace.activeLeaf?.view;
    if (view instanceof FileView && this.toolbars.has(view)) return this.toolbars.get(view) ?? null;
    for (const [v, tb] of this.toolbars) if (v.file && v.file === this.app.workspace.getActiveFile()) return tb;
    return null;
  }

  async setDarkMode(mode: DarkMode) {
    this.settings.darkMode = mode;
    await this.saveSettings();
    for (const tb of this.toolbars.values()) tb.applyDarkMode();
    new Notice(`${t("tb_dark")}: ${t(("dark_" + mode) as Keys)}`, 2000);
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
    setLang(this.settings.language);
    ensureDarkFilters(this.settings.darkBg, this.settings.darkText);
  }

  /* ---------------------------------------------------------------- */
  /* Helpers                                                            */
  /* ---------------------------------------------------------------- */

  getActivePdf(): TFile | null {
    const leaf = this.app.workspace.activeLeaf;
    const view = leaf?.view as { file?: TFile; getViewType?: () => string } | undefined;
    if (view?.getViewType?.() === "pdf" && isPdf(view.file)) return view.file;
    const f = this.app.workspace.getActiveFile();
    return isPdf(f) ? f : null;
  }

  openToolbox(file: TFile | null) {
    const plugin = this;
    const m = new (class extends FuzzySuggestModal<Tool> {
      getItems() {
        return plugin.tools.filter((tl) => !tl.needsPdf || file);
      }
      getItemText(tl: Tool) {
        return `${t(tl.name)} — ${t(tl.desc)}`;
      }
      onChooseItem(tl: Tool) {
        void plugin.runTool(tl, file);
      }
    })(this.app);
    m.setPlaceholder(file ? `${t("toolboxPrompt")} (${file.name})` : t("toolboxPrompt"));
    m.open();
  }

  async runTool(tool: Tool, file: TFile | null) {
    if (tool.needsPdf && !file) {
      new Notice(t("noPdf"));
      return;
    }
    try {
      await tool.run(file);
    } catch (e) {
      console.error("[pdf-toolkit]", e);
      new Notice(t("failed", { msg: errMsg(e) }), 8000);
    }
  }

  async runToolById(id: string, file: TFile | null) {
    const tool = this.tools.find((tl) => tl.id === id);
    if (tool) await this.runTool(tool, file);
  }

  /** Read + parse a PDF, prompting for the password if needed. Returns null if the user cancels. */
  async loadPdf(file: TFile, knownPassword?: string): Promise<Loaded | null> {
    const bytes = new Uint8Array(await this.app.vault.readBinary(file));
    if (knownPassword !== undefined) {
      try {
        const doc = await ops.loadDoc(bytes, { password: knownPassword });
        return { doc, bytes, password: knownPassword, encrypted: true };
      } catch {
        /* fall through to the normal flow */
      }
    }
    try {
      const doc = await ops.loadDoc(bytes);
      return { doc, bytes, encrypted: doc.isEncrypted };
    } catch (e) {
      if (!(e instanceof EncryptedError)) throw e;
    }
    for (;;) {
      const pw = await promptPassword(this.app, file.name);
      if (pw === null) return null;
      try {
        const doc = await ops.loadDoc(bytes, { password: pw });
        return { doc, bytes, password: pw, encrypted: true };
      } catch (e) {
        new Notice(t("wrongPassword"));
      }
    }
  }

  outputFolder(file: TFile): string {
    return this.settings.outputFolder ? normalizePath(this.settings.outputFolder) : folderOf(file);
  }

  /** Write result bytes according to the output-mode setting. */
  async writeOutput(file: TFile, bytes: Uint8Array, suffix: string, forceNew = false): Promise<TFile> {
    if (this.settings.outputMode === "overwrite" && !forceNew) {
      await this.app.vault.modifyBinary(file, toArrayBuffer(bytes));
      new Notice(t("done", { name: file.name }));
      return file;
    }
    const folder = this.outputFolder(file);
    await ensureFolder(this.app, folder);
    const p = uniquePath(this.app, folder, `${file.basename}-${suffix}`, "pdf");
    const out = await this.app.vault.createBinary(p, toArrayBuffer(bytes));
    new Notice(t("done", { name: out.name }));
    return out;
  }

  async writeNew(folder: string, base: string, ext: string, bytes: Uint8Array): Promise<TFile> {
    await ensureFolder(this.app, folder);
    const p = uniquePath(this.app, folder, sanitizeName(base), ext);
    return this.app.vault.createBinary(p, toArrayBuffer(bytes));
  }

  fontProvider(): FontProvider {
    return {
      customFontBytes: async () => {
        const fp = this.settings.fontPath.trim();
        if (!fp) return null;
        if (this.fontCache && this.fontCache.path === fp) return this.fontCache.bytes;
        let bytes: Uint8Array | null = null;
        const vf = this.app.vault.getAbstractFileByPath(normalizePath(fp));
        if (vf instanceof TFile) bytes = new Uint8Array(await this.app.vault.readBinary(vf));
        else if (path.isAbsolute(fp) && fs.existsSync(fp)) bytes = new Uint8Array(fs.readFileSync(fp));
        if (!bytes) throw new Error(t("fontLoadFailed", { path: fp }));
        this.fontCache = { path: fp, bytes };
        return bytes;
      },
    };
  }

  private async askRange(file: TFile, title: Keys, total: number, extra: FieldSpec[] = [], def = "all") {
    const r = await promptPageRange(this.app, `${t(title)} — ${file.name}`, total, extra, def);
    if (!r) return null;
    return { pages: parsePageRange(String(r.range), total), values: r };
  }

  /* ---------------------------------------------------------------- */
  /* Tools                                                              */
  /* ---------------------------------------------------------------- */

  private buildTools() {
    const T = (
      id: string,
      name: Keys,
      desc: Keys,
      icon: string,
      run: (file: TFile) => Promise<void>,
    ): Tool => ({ id, name, desc, icon, needsPdf: true, run: (f) => run(f as TFile) });

    this.tools = [
      T("organize", "tool_organize", "tool_organize_desc", "layout-grid", (f) => this.organizeTool(f)),
      {
        id: "merge",
        name: "tool_merge",
        desc: "tool_merge_desc",
        icon: "merge",
        needsPdf: false,
        run: (f) => this.mergeTool(f ? [f] : []),
      },
      T("split", "tool_split", "tool_split_desc", "scissors", (f) => this.splitTool(f)),
      T("extract", "tool_extract", "tool_extract_desc", "file-output", (f) => this.extractTool(f)),
      T("delete-pages", "tool_delete", "tool_delete_desc", "trash", (f) => this.deleteTool(f)),
      T("rotate", "tool_rotate", "tool_rotate_desc", "rotate-cw", (f) => this.rotateTool(f)),
      T("reorder", "tool_reorder", "tool_reorder_desc", "list-ordered", (f) => this.reorderTool(f)),
      T("reverse", "tool_reverse", "tool_reverse_desc", "arrow-up-down", (f) => this.reverseTool(f)),
      T("blank", "tool_blank", "tool_blank_desc", "file-plus", (f) => this.blankTool(f)),
      T("duplicate", "tool_duplicate", "tool_duplicate_desc", "copy", (f) => this.duplicateTool(f)),
      T("watermark", "tool_watermark", "tool_watermark_desc", "stamp", (f) => this.watermarkTool(f)),
      T("header-footer", "tool_headerfooter", "tool_headerfooter_desc", "hash", (f) => this.headerFooterTool(f)),
      T("crop", "tool_crop", "tool_crop_desc", "crop", (f) => this.cropTool(f)),
      T("resize", "tool_resize", "tool_resize_desc", "maximize", (f) => this.resizeTool(f)),
      T("nup", "tool_nup", "tool_nup_desc", "columns", (f) => this.nupTool(f)),
      T("protect", "tool_protect", "tool_protect_desc", "lock", (f) => this.protectTool(f)),
      T("unlock", "tool_unlock", "tool_unlock_desc", "unlock", (f) => this.unlockTool(f)),
      T("metadata", "tool_metadata", "tool_metadata_desc", "tag", (f) => this.metadataTool(f)),
      T("info", "tool_info", "tool_info_desc", "info", (f) => this.infoTool(f)),
      T("extract-text", "tool_text", "tool_text_desc", "file-text", (f) => this.textTool(f)),
      T("export-images", "tool_images", "tool_images_desc", "image", (f) => this.imagesTool(f)),
      {
        id: "images-to-pdf",
        name: "tool_imgpdf",
        desc: "tool_imgpdf_desc",
        icon: "images",
        needsPdf: false,
        run: () => this.imagesToPdfTool(),
      },
      T("attach", "tool_attach", "tool_attach_desc", "paperclip", (f) => this.attachTool(f)),
      T("form-fill", "tool_form_fill", "tool_form_fill_desc", "form-input", (f) => this.formFillTool(f)),
      T("form-flatten", "tool_form_flatten", "tool_form_flatten_desc", "layers", (f) => this.formFlattenTool(f)),
      T("optimize", "tool_optimize", "tool_optimize_desc", "minimize-2", (f) => this.optimizeTool(f)),
    ];
  }

  /* --- structure ---------------------------------------------------- */

  async organizeTool(file: TFile) {
    const L = await this.loadPdf(file);
    if (!L) return;
    new OrganizeModal(this.app, file.name, L.bytes, L.doc.getPageCount(), this.settings.thumbWidth, L.password, {
      onSave: async (plan) => {
        try {
          const out = await ops.applyPagePlan(L.doc, plan);
          await this.writeOutput(file, out, "organized");
        } catch (e) {
          new Notice(t("failed", { msg: errMsg(e) }));
        }
      },
      onExtract: async (indices) => {
        try {
          const out = await ops.extractPages(L.doc, indices);
          await this.writeOutput(file, out, "extract", true);
        } catch (e) {
          new Notice(t("failed", { msg: errMsg(e) }));
        }
      },
    }).open();
  }

  async mergeTool(preselected: TFile[]) {
    const all = this.app.vault.getFiles().filter(isPdf).sort((a, b) => a.path.localeCompare(b.path));
    const r = await pickFilesOrdered(this.app, t("tool_merge"), t("mergeHint"), all, preselected, 2, t("mergeSearch"), [
      { kind: "text", key: "name", label: t("tool_merge"), value: `${preselected[0]?.basename ?? "merged"}-merged` },
    ]);
    if (!r) return;
    const list: Uint8Array[] = [];
    const pws: (string | undefined)[] = [];
    for (const f of r.files) {
      const L = await this.loadPdf(f);
      if (!L) return;
      list.push(L.bytes);
      pws.push(L.password);
    }
    const out = await ops.mergeDocs(list, pws);
    const folder = this.settings.outputFolder ? normalizePath(this.settings.outputFolder) : folderOf(r.files[0]);
    const created = await this.writeNew(folder, String(r.values.name) || "merged", "pdf", out);
    new Notice(t("done", { name: created.name }));
  }

  async splitTool(file: TFile) {
    const L = await this.loadPdf(file);
    if (!L) return;
    const total = L.doc.getPageCount();
    const r = await formModal(this.app, `${t("tool_split")} — ${file.name}`, [
      { kind: "dropdown", key: "mode", label: t("splitMode"), options: { every: t("splitEvery"), ranges: t("splitRanges") } },
      { kind: "number", key: "n", label: t("splitEveryN"), value: 1, min: 1 },
      { kind: "textarea", key: "ranges", label: t("splitRanges"), desc: t("splitRangesHint"), placeholder: "1-3\n4-6\n7-" },
    ]);
    if (!r) return;
    let parts: Uint8Array[];
    if (r.mode === "every") {
      parts = await ops.splitEvery(L.doc, Math.max(1, Number(r.n)));
    } else {
      const ranges = String(r.ranges)
        .split(/\n+/)
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => parsePageRange(s, total));
      if (!ranges.length) throw new Error(t("invalidRange"));
      parts = await ops.splitRanges(L.doc, ranges);
    }
    const folder = this.outputFolder(file);
    const pad = String(parts.length).length;
    for (let i = 0; i < parts.length; i++) {
      await this.writeNew(folder, `${file.basename}-part${String(i + 1).padStart(pad, "0")}`, "pdf", parts[i]);
    }
    new Notice(t("splitDone", { n: parts.length }));
  }

  async extractTool(file: TFile) {
    const L = await this.loadPdf(file);
    if (!L) return;
    const r = await this.askRange(file, "tool_extract", L.doc.getPageCount(), [], "1");
    if (!r) return;
    await this.writeOutput(file, await ops.extractPages(L.doc, r.pages), "extract", true);
  }

  async deleteTool(file: TFile) {
    const L = await this.loadPdf(file);
    if (!L) return;
    const r = await this.askRange(file, "tool_delete", L.doc.getPageCount(), [], "1");
    if (!r) return;
    await this.writeOutput(file, await ops.deletePages(L.doc, r.pages), "deleted");
  }

  async rotateTool(file: TFile) {
    const L = await this.loadPdf(file);
    if (!L) return;
    const r = await this.askRange(file, "tool_rotate", L.doc.getPageCount(), [
      { kind: "dropdown", key: "deg", label: t("rotation"), options: { "90": "90° ↻", "180": "180°", "270": "270° (90° ↺)" } },
    ]);
    if (!r) return;
    await this.writeOutput(file, await ops.rotatePages(L.doc, r.pages, Number(r.values.deg)), "rotated");
  }

  async reorderTool(file: TFile) {
    const L = await this.loadPdf(file);
    if (!L) return;
    const total = L.doc.getPageCount();
    const r = await formModal(this.app, `${t("tool_reorder")} — ${file.name}`, [
      { kind: "text", key: "order", label: t("newOrder"), desc: t("pageRangeHint", { n: total }), value: "1-" + total },
    ]);
    if (!r) return;
    const order = parsePageOrder(String(r.order), total);
    await this.writeOutput(file, await ops.reorderPages(L.doc, order), "reordered");
  }

  async reverseTool(file: TFile) {
    const L = await this.loadPdf(file);
    if (!L) return;
    await this.writeOutput(file, await ops.reversePages(L.doc), "reversed");
  }

  async blankTool(file: TFile) {
    const L = await this.loadPdf(file);
    if (!L) return;
    const total = L.doc.getPageCount();
    const r = await formModal(this.app, `${t("tool_blank")} — ${file.name}`, [
      { kind: "number", key: "after", label: t("insertAfter"), value: total, min: 0, max: total },
      { kind: "number", key: "count", label: t("count"), value: 1, min: 1 },
    ]);
    if (!r) return;
    const after = Math.min(Math.max(Number(r.after), 0), total);
    await this.writeOutput(file, await ops.insertBlankPages(L.doc, after, Math.max(1, Number(r.count))), "blank");
  }

  async duplicateTool(file: TFile) {
    const L = await this.loadPdf(file);
    if (!L) return;
    const r = await this.askRange(file, "tool_duplicate", L.doc.getPageCount(), [], "1");
    if (!r) return;
    await this.writeOutput(file, await ops.duplicatePages(L.doc, r.pages), "duplicated");
  }

  /* --- stamping ----------------------------------------------------- */

  async watermarkTool(file: TFile) {
    const L = await this.loadPdf(file);
    if (!L) return;
    const r = await this.askRange(file, "tool_watermark", L.doc.getPageCount(), [
      { kind: "text", key: "text", label: t("wmText"), value: "CONFIDENTIAL" },
      { kind: "number", key: "size", label: t("wmSize"), value: 48, min: 4 },
      { kind: "number", key: "opacity", label: t("wmOpacity"), value: 0.25, min: 0, max: 1, step: 0.05 },
      { kind: "number", key: "angle", label: t("wmAngle"), value: 45, min: -180, max: 180 },
      { kind: "text", key: "color", label: t("wmColor"), value: "#ff0000" },
      { kind: "toggle", key: "tile", label: t("wmTile"), value: false },
    ]);
    if (!r) return;
    const v = r.values;
    const out = await ops.addWatermark(
      L.doc,
      {
        text: String(v.text),
        fontSize: Number(v.size),
        opacity: Number(v.opacity),
        angle: Number(v.angle),
        color: String(v.color),
        tile: Boolean(v.tile),
        pages: r.pages,
      },
      this.fontProvider(),
    );
    await this.writeOutput(file, out, "watermarked");
  }

  async headerFooterTool(file: TFile) {
    const L = await this.loadPdf(file);
    if (!L) return;
    const r = await this.askRange(file, "tool_headerfooter", L.doc.getPageCount(), [
      { kind: "note", label: t("hfHint") },
      { kind: "text", key: "hl", label: t("hfHeaderLeft") },
      { kind: "text", key: "hc", label: t("hfHeaderCenter") },
      { kind: "text", key: "hr", label: t("hfHeaderRight") },
      { kind: "text", key: "fl", label: t("hfFooterLeft") },
      { kind: "text", key: "fc", label: t("hfFooterCenter"), value: "{page} / {total}" },
      { kind: "text", key: "fr", label: t("hfFooterRight") },
      { kind: "number", key: "size", label: t("wmSize"), value: 10, min: 4 },
      { kind: "number", key: "margin", label: t("hfMargin"), value: 28, min: 0 },
      { kind: "number", key: "start", label: t("hfStart"), value: 1 },
      { kind: "text", key: "color", label: t("wmColor"), value: "#333333" },
    ]);
    if (!r) return;
    const v = r.values;
    const out = await ops.addHeaderFooter(
      L.doc,
      {
        headerLeft: String(v.hl),
        headerCenter: String(v.hc),
        headerRight: String(v.hr),
        footerLeft: String(v.fl),
        footerCenter: String(v.fc),
        footerRight: String(v.fr),
        fontSize: Number(v.size),
        margin: Number(v.margin),
        startNumber: Number(v.start),
        color: String(v.color),
        pages: r.pages,
        fileName: file.basename,
      },
      this.fontProvider(),
    );
    await this.writeOutput(file, out, "numbered");
  }

  /* --- geometry ----------------------------------------------------- */

  async cropTool(file: TFile) {
    const L = await this.loadPdf(file);
    if (!L) return;
    const r = await this.askRange(file, "tool_crop", L.doc.getPageCount(), [
      { kind: "note", label: t("cropHint") },
      { kind: "number", key: "top", label: t("cropTop"), value: 0, min: 0 },
      { kind: "number", key: "bottom", label: t("cropBottom"), value: 0, min: 0 },
      { kind: "number", key: "left", label: t("cropLeft"), value: 0, min: 0 },
      { kind: "number", key: "right", label: t("cropRight"), value: 0, min: 0 },
    ]);
    if (!r) return;
    const v = r.values;
    const out = await ops.cropPages(L.doc, {
      top: Number(v.top),
      bottom: Number(v.bottom),
      left: Number(v.left),
      right: Number(v.right),
      pages: r.pages,
    });
    await this.writeOutput(file, out, "cropped");
  }

  async resizeTool(file: TFile) {
    const L = await this.loadPdf(file);
    if (!L) return;
    const sizes: Record<string, string> = {};
    for (const k of Object.keys(PAPER_SIZES)) sizes[k] = k;
    sizes.custom = t("custom");
    const r = await this.askRange(file, "tool_resize", L.doc.getPageCount(), [
      { kind: "dropdown", key: "size", label: t("paperSize"), options: sizes, value: "A4" },
      { kind: "toggle", key: "landscape", label: t("landscape"), value: false },
      { kind: "number", key: "w", label: t("width"), value: 595, min: 1 },
      { kind: "number", key: "h", label: t("height"), value: 842, min: 1 },
      { kind: "dropdown", key: "mode", label: t("fitMode"), options: { contain: t("fitContain"), stretch: t("fitStretch") } },
    ]);
    if (!r) return;
    const v = r.values;
    let [w, h] = v.size === "custom" ? [Number(v.w), Number(v.h)] : PAPER_SIZES[String(v.size)];
    if (v.landscape) [w, h] = [h, w];
    const out = await ops.resizePages(L.doc, { width: w, height: h, mode: v.mode === "stretch" ? "stretch" : "contain", pages: r.pages });
    await this.writeOutput(file, out, "resized");
  }

  async nupTool(file: TFile) {
    const L = await this.loadPdf(file);
    if (!L) return;
    const sizes: Record<string, string> = {};
    for (const k of Object.keys(PAPER_SIZES)) sizes[k] = k;
    const r = await formModal(this.app, `${t("tool_nup")} — ${file.name}`, [
      { kind: "dropdown", key: "per", label: t("nupPer"), options: { "2": "2", "4": "4" } },
      { kind: "dropdown", key: "size", label: t("paperSize"), options: sizes, value: "A4" },
      { kind: "toggle", key: "landscape", label: t("landscape"), value: true },
    ]);
    if (!r) return;
    const out = await ops.nUp(L.doc, {
      per: r.per === "4" ? 4 : 2,
      sheet: PAPER_SIZES[String(r.size)],
      landscape: Boolean(r.landscape),
    });
    await this.writeOutput(file, out, `${r.per}up`, true);
  }

  /* --- security ----------------------------------------------------- */

  async protectTool(file: TFile) {
    const L = await this.loadPdf(file);
    if (!L) return;
    const r = await formModal(this.app, `${t("tool_protect")} — ${file.name}`, [
      { kind: "text", key: "user", label: t("userPassword"), password: true },
      { kind: "text", key: "owner", label: t("ownerPassword"), password: true },
      { kind: "toggle", key: "printing", label: t("permPrinting"), value: true },
      { kind: "toggle", key: "modifying", label: t("permModifying"), value: false },
      { kind: "toggle", key: "copying", label: t("permCopying"), value: true },
      { kind: "toggle", key: "annotating", label: t("permAnnotating"), value: true },
      { kind: "toggle", key: "forms", label: t("permForms"), value: true },
    ]);
    if (!r) return;
    if (!String(r.user) && !String(r.owner)) {
      new Notice(t("needPassword"));
      return;
    }
    const out = await ops.protect(L.doc, {
      userPassword: String(r.user),
      ownerPassword: String(r.owner),
      printing: Boolean(r.printing),
      modifying: Boolean(r.modifying),
      copying: Boolean(r.copying),
      annotating: Boolean(r.annotating),
      fillingForms: Boolean(r.forms),
    });
    await this.writeOutput(file, out, "protected");
  }

  async unlockTool(file: TFile) {
    const L = await this.loadPdf(file);
    if (!L) return;
    await this.writeOutput(file, await ops.unlock(L.doc), "unlocked");
  }

  /* --- metadata / info ---------------------------------------------- */

  async metadataTool(file: TFile) {
    const L = await this.loadPdf(file);
    if (!L) return;
    const m = ops.getMetadata(L.doc);
    const r = await formModal(this.app, `${t("tool_metadata")} — ${file.name}`, [
      { kind: "text", key: "title", label: t("mdTitle"), value: m.title },
      { kind: "text", key: "author", label: t("mdAuthor"), value: m.author },
      { kind: "text", key: "subject", label: t("mdSubject"), value: m.subject },
      { kind: "text", key: "keywords", label: t("mdKeywords"), value: m.keywords },
      { kind: "text", key: "creator", label: t("mdCreator"), value: m.creator },
      { kind: "text", key: "producer", label: t("mdProducer"), value: m.producer },
    ], t("save"));
    if (!r) return;
    const out = await ops.setMetadata(L.doc, {
      title: String(r.title),
      author: String(r.author),
      subject: String(r.subject),
      keywords: String(r.keywords),
      creator: String(r.creator),
      producer: String(r.producer),
    });
    await this.writeOutput(file, out, "meta");
  }

  async infoTool(file: TFile) {
    const L = await this.loadPdf(file);
    if (!L) return;
    const info = ops.getInfo(L.doc, L.encrypted);
    const yn = (b: boolean) => (b ? t("yes") : t("no"));
    const pt2mm = (p: number) => (p * 0.352778).toFixed(0);
    const rows: [string, string][] = [
      [t("infoPages"), String(info.pages)],
      [t("infoSize"), formatBytes(file.stat.size)],
      [
        t("infoPageSize"),
        `${info.firstPageSize.width.toFixed(1)} × ${info.firstPageSize.height.toFixed(1)} pt (${pt2mm(info.firstPageSize.width)} × ${pt2mm(info.firstPageSize.height)} mm)`,
      ],
      [t("infoEncrypted"), yn(info.encrypted)],
      [t("infoForm"), String(info.formFields)],
      [t("mdTitle"), info.metadata.title],
      [t("mdAuthor"), info.metadata.author],
      [t("mdSubject"), info.metadata.subject],
      [t("mdKeywords"), info.metadata.keywords],
      [t("mdCreator"), info.metadata.creator],
      [t("mdProducer"), info.metadata.producer],
      [t("infoCreated"), info.created ? info.created.toLocaleString() : ""],
      [t("infoModified"), info.modified ? info.modified.toLocaleString() : ""],
    ];
    showInfoModal(this.app, file.name, rows);
  }

  /* --- content ------------------------------------------------------ */

  async textTool(file: TFile) {
    const L = await this.loadPdf(file);
    if (!L) return;
    const r = await this.askRange(file, "tool_text", L.doc.getPageCount(), [
      { kind: "toggle", key: "sep", label: t("textLayout"), value: true },
    ]);
    if (!r) return;
    const n = new Notice(t("working"), 0);
    try {
      const pages = await extractText(L.bytes, L.password);
      const chosen = r.pages.map((i) => [i, pages[i] ?? ""] as const);
      const body = chosen
        .map(([i, txt]) => (r.values.sep ? `## Page ${i + 1}\n\n${txt}` : txt))
        .join(r.values.sep ? "\n\n---\n\n" : "\n\n");
      if (!body.trim()) {
        new Notice(t("textEmpty"));
        return;
      }
      const md = `---\nsource: "[[${file.path}]]"\npages: ${L.doc.getPageCount()}\nextracted: ${new Date().toISOString()}\n---\n\n${body}\n`;
      const folder = this.outputFolder(file);
      await ensureFolder(this.app, folder);
      const p = uniquePath(this.app, folder, file.basename, "md");
      const note = await this.app.vault.create(p, md);
      new Notice(t("textDone", { name: note.name }));
      await this.app.workspace.getLeaf("tab").openFile(note);
    } finally {
      n.hide();
    }
  }

  async imagesTool(file: TFile) {
    const L = await this.loadPdf(file);
    if (!L) return;
    const r = await this.askRange(file, "tool_images", L.doc.getPageCount(), [
      { kind: "number", key: "scale", label: t("imgScale"), value: 2, min: 0.25, max: 8, step: 0.25 },
    ]);
    if (!r) return;
    const folder = joinPath(this.outputFolder(file), `${file.basename} images`);
    await ensureFolder(this.app, folder);
    const pad = String(L.doc.getPageCount()).length;
    const n = new Notice(t("working"), 0);
    let count = 0;
    try {
      await renderPagesToPng(
        L.bytes,
        Number(r.values.scale),
        r.pages,
        async (i, png) => {
          await this.writeNew(folder, `${file.basename}-p${String(i + 1).padStart(pad, "0")}`, "png", png);
          count++;
          n.setMessage(`${t("working")} ${count}/${r.pages.length}`);
        },
        L.password,
      );
    } finally {
      n.hide();
    }
    new Notice(t("imgDone", { n: count, folder }));
  }

  async imagesToPdfTool() {
    const imgs = this.app.vault.getFiles().filter(isImage).sort((a, b) => a.path.localeCompare(b.path));
    const sizes: Record<string, string> = { image: t("imgpdfFitImage") };
    for (const k of Object.keys(PAPER_SIZES)) sizes[k] = k;
    const r = await pickFilesOrdered(this.app, t("tool_imgpdf"), t("imgpdfHint"), imgs, [], 1, t("imgpdfSearch"), [
      { kind: "dropdown", key: "size", label: t("paperSize"), options: sizes },
      { kind: "text", key: "name", label: t("tool_imgpdf"), value: "images" },
    ]);
    if (!r) return;
    const inputs: ops.ImageInput[] = [];
    for (const f of r.files) inputs.push({ data: new Uint8Array(await this.app.vault.readBinary(f)), ext: f.extension });
    const size = r.values.size === "image" ? "image" : PAPER_SIZES[String(r.values.size)];
    const out = await ops.imagesToPdf(inputs, size);
    const folder = this.settings.outputFolder ? normalizePath(this.settings.outputFolder) : folderOf(r.files[0]);
    const created = await this.writeNew(folder, String(r.values.name) || "images", "pdf", out);
    new Notice(t("done", { name: created.name }));
  }

  async attachTool(file: TFile) {
    const L = await this.loadPdf(file);
    if (!L) return;
    const candidates = this.app.vault.getFiles().filter((f) => f.path !== file.path);
    const pick = await pickOneFile(this.app, t("attachPick"), candidates);
    if (!pick) return;
    const r = await formModal(this.app, `${t("tool_attach")} — ${pick.name}`, [
      { kind: "text", key: "desc", label: t("attachDesc"), value: pick.basename },
    ]);
    if (!r) return;
    const data = new Uint8Array(await this.app.vault.readBinary(pick));
    const mime = MIME[pick.extension.toLowerCase()] ?? "application/octet-stream";
    const out = await ops.attachFile(L.doc, data, pick.name, mime, String(r.desc));
    await this.writeOutput(file, out, "attached");
  }

  /* --- forms -------------------------------------------------------- */

  async formFillTool(file: TFile) {
    const L = await this.loadPdf(file);
    if (!L) return;
    const fields = ops.describeFields(L.doc);
    if (!fields.length) {
      new Notice(t("formNone"));
      return;
    }
    const specs: FieldSpec[] = [];
    for (const f of fields) {
      const label = f.name + (f.readOnly ? " (read-only)" : "");
      if (f.kind === "text") specs.push({ kind: "text", key: "f:" + f.name, label, value: String(f.value) });
      else if (f.kind === "checkbox") specs.push({ kind: "toggle", key: "f:" + f.name, label, value: Boolean(f.value) });
      else if (f.kind === "dropdown" || f.kind === "radio" || f.kind === "optionlist") {
        const options: Record<string, string> = { "": "—" };
        for (const o of f.options ?? []) options[o] = o;
        const cur = Array.isArray(f.value) ? f.value[0] ?? "" : String(f.value);
        specs.push({ kind: "dropdown", key: "f:" + f.name, label, options, value: cur });
      }
    }
    specs.push({ kind: "toggle", key: "__flatten", label: t("tool_form_flatten"), value: false });
    const r = await formModal(this.app, `${t("tool_form_fill")} — ${file.name}`, specs, t("save"));
    if (!r) return;
    const values: Record<string, string | boolean | string[]> = {};
    for (const [k, v] of Object.entries(r)) if (k.startsWith("f:")) values[k.slice(2)] = v as string | boolean;
    const out = await ops.fillFields(L.doc, values, Boolean(r.__flatten));
    await this.writeOutput(file, out, "filled");
  }

  async formFlattenTool(file: TFile) {
    const L = await this.loadPdf(file);
    if (!L) return;
    if (!ops.describeFields(L.doc).length) {
      new Notice(t("formNone"));
      return;
    }
    await this.writeOutput(file, await ops.flattenForm(L.doc), "flat");
    new Notice(t("formFlattened"));
  }

  async optimizeTool(file: TFile) {
    const L = await this.loadPdf(file);
    if (!L) return;
    const before = file.stat.size;
    const out = await ops.optimize(L.doc);
    const created = await this.writeOutput(file, out, "optimized");
    new Notice(`${created.name}: ${formatBytes(before)} → ${formatBytes(out.byteLength)}`);
  }
}

const MIME: Record<string, string> = {
  pdf: "application/pdf",
  md: "text/markdown",
  txt: "text/plain",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  svg: "image/svg+xml",
  json: "application/json",
  csv: "text/csv",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  zip: "application/zip",
  mp3: "audio/mpeg",
  mp4: "video/mp4",
};

/* ------------------------------------------------------------------ */
/* Settings tab                                                         */
/* ------------------------------------------------------------------ */

class PdfToolkitSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: PdfToolkitPlugin) {
    super(app, plugin);
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    const s = this.plugin.settings;

    new Setting(containerEl)
      .setName(t("setOutput"))
      .setDesc(t("setOutputDesc"))
      .addDropdown((dd) =>
        dd
          .addOptions({ new: t("setOutputNew"), overwrite: t("setOutputOverwrite") })
          .setValue(s.outputMode)
          .onChange(async (v) => {
            s.outputMode = v === "overwrite" ? "overwrite" : "new";
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName(t("setFolder"))
      .setDesc(t("setFolderDesc"))
      .addText((tx) =>
        tx
          .setValue(s.outputFolder)
          .setPlaceholder("PDF/output")
          .onChange(async (v) => {
            s.outputFolder = v.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName(t("setFont"))
      .setDesc(t("setFontDesc"))
      .addText((tx) =>
        tx
          .setValue(s.fontPath)
          .setPlaceholder("C:\\Windows\\Fonts\\msjh.ttc")
          .onChange(async (v) => {
            s.fontPath = v.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName(t("setThumb"))
      .setDesc(t("setThumbDesc"))
      .addSlider((sl) =>
        sl
          .setLimits(80, 320, 10)
          .setValue(s.thumbWidth)
          .setDynamicTooltip()
          .onChange(async (v) => {
            s.thumbWidth = v;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName(t("setLang"))
      .addDropdown((dd) =>
        dd
          .addOptions({ auto: t("setLangAuto"), en: "English", "zh-TW": "繁體中文" })
          .setValue(s.language)
          .onChange(async (v) => {
            s.language = v as Lang | "auto";
            await this.plugin.saveSettings();
            this.display();
          }),
      );

    new Setting(containerEl)
      .setName(t("setToolbar"))
      .setDesc(t("setToolbarDesc"))
      .addToggle((tg) =>
        tg.setValue(s.showToolbar).onChange(async (v) => {
          s.showToolbar = v;
          await this.plugin.saveSettings();
          if (v) this.plugin.ensureToolbars();
          else this.plugin.removeToolbars();
        }),
      );

    new Setting(containerEl)
      .setName(t("setAuthor"))
      .setDesc(t("setAuthorDesc"))
      .addText((tx) =>
        tx.setValue(s.author).onChange(async (v) => {
          s.author = v.trim();
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl).setName(t("setDark")).addDropdown((dd) => {
      const opts: Record<string, string> = {};
      for (const m of DARK_MODES) opts[m] = t(("dark_" + m) as Keys);
      dd.addOptions(opts)
        .setValue(s.darkMode)
        .onChange((v) => void this.plugin.setDarkMode(v as DarkMode));
    });

    new Setting(containerEl)
      .setName(t("setDarkBg"))
      .setDesc(t("setDarkColorsDesc"))
      .addText((tx) =>
        tx.setValue(s.darkBg).setPlaceholder("#1f1f1f").onChange(async (v) => {
          if (/^#?[0-9a-f]{6}$/i.test(v.trim())) {
            s.darkBg = v.trim().startsWith("#") ? v.trim() : "#" + v.trim();
            await this.plugin.saveSettings();
          }
        }),
      );

    new Setting(containerEl).setName(t("setDarkText")).addText((tx) =>
      tx.setValue(s.darkText).setPlaceholder("#c3c2b7").onChange(async (v) => {
        if (/^#?[0-9a-f]{6}$/i.test(v.trim())) {
          s.darkText = v.trim().startsWith("#") ? v.trim() : "#" + v.trim();
          await this.plugin.saveSettings();
        }
      }),
    );

    new Setting(containerEl).setName(t("setLlm")).setHeading();

    new Setting(containerEl).setName(t("setLlmProvider")).addDropdown((dd) =>
      dd
        .addOptions({ claude: t("llm_claude"), codex: t("llm_codex"), custom: t("llm_custom") })
        .setValue(s.llmProvider)
        .onChange(async (v) => {
          s.llmProvider = v as LlmProvider;
          await this.plugin.saveSettings();
        }),
    );

    new Setting(containerEl)
      .setName(t("setLlmClaudePath"))
      .setDesc(t("setLlmPathDesc"))
      .addText((tx) =>
        tx.setValue(s.llmClaudePath).setPlaceholder("claude").onChange(async (v) => {
          s.llmClaudePath = v.trim();
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName(t("setLlmCodexPath"))
      .setDesc(t("setLlmPathDesc"))
      .addText((tx) =>
        tx.setValue(s.llmCodexPath).setPlaceholder("codex").onChange(async (v) => {
          s.llmCodexPath = v.trim();
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName(t("setLlmCustom"))
      .setDesc(t("setLlmCustomDesc"))
      .addText((tx) =>
        tx.setValue(s.llmCustomCommand).setPlaceholder("ollama run llama3").onChange(async (v) => {
          s.llmCustomCommand = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName(t("setLlmModel"))
      .setDesc(t("setLlmModelDesc"))
      .addText((tx) =>
        tx.setValue(s.llmModel).onChange(async (v) => {
          s.llmModel = v.trim();
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName(t("setLlmExtraPath"))
      .setDesc(t("setLlmExtraPathDesc"))
      .addTextArea((ta) => {
        ta.setValue(s.llmExtraPath).onChange(async (v) => {
          s.llmExtraPath = v;
          await this.plugin.saveSettings();
        });
        ta.inputEl.rows = 3;
        ta.inputEl.cols = 40;
      });

    new Setting(containerEl)
      .setName(t("setLlmMaxChars"))
      .setDesc(t("setLlmMaxCharsDesc"))
      .addText((tx) => {
        tx.inputEl.type = "number";
        tx.setValue(String(s.llmMaxChars)).onChange(async (v) => {
          s.llmMaxChars = Number(v) || 60000;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName(t("setOrganize"))
      .setDesc(t("setOrganizeDesc"))
      .addToggle((tg) =>
        tg.setValue(s.organizeFolders).onChange(async (v) => {
          s.organizeFolders = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName(t("setRefQuestion"))
      .addTextArea((ta) => {
        ta.setPlaceholder(t("ref_defaultQuestion")).setValue(s.refQuestion).onChange(async (v) => {
          s.refQuestion = v;
          await this.plugin.saveSettings();
        });
        ta.inputEl.rows = 3;
        ta.inputEl.cols = 40;
      });

    new Setting(containerEl)
      .setName(t("setRefHover"))
      .setDesc(t("setRefHoverDesc"))
      .addToggle((tg) =>
        tg.setValue(s.refHover).onChange(async (v) => {
          s.refHover = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl).setName(t("setPrompts")).setDesc(t("setPromptsDesc")).setHeading();

    s.customPrompts.forEach((p, i) => {
      const row = new Setting(containerEl).setClass("pdftk-prompt-row");
      row.addText((tx) =>
        tx.setPlaceholder(t("prompt_name")).setValue(p.name).onChange(async (v) => {
          p.name = v;
          await this.plugin.saveSettings();
        }),
      );
      row.addDropdown((dd) =>
        dd
          .addOptions({ selection: t("ctx_selection"), page: t("ctx_page"), document: t("ctx_document"), reference: t("ctx_reference") })
          .setValue(p.mode)
          .onChange(async (v) => {
            p.mode = v as CtxMode;
            await this.plugin.saveSettings();
          }),
      );
      row.addExtraButton((b) =>
        b.setIcon("trash").setTooltip(t("prompt_remove")).onClick(async () => {
          s.customPrompts.splice(i, 1);
          await this.plugin.saveSettings();
          this.display();
        }),
      );
      row.addTextArea((ta) => {
        ta.setPlaceholder(t("prompt_text")).setValue(p.prompt).onChange(async (v) => {
          p.prompt = v;
          await this.plugin.saveSettings();
        });
        ta.inputEl.rows = 3;
        ta.inputEl.addClass("pdftk-prompt-text");
      });
    });

    new Setting(containerEl)
      .addButton((b) =>
        b.setButtonText(t("prompt_add")).onClick(async () => {
          s.customPrompts.push({ name: "", mode: "page", prompt: "" });
          await this.plugin.saveSettings();
          this.display();
        }),
      )
      .addToggle((tg) =>
        tg.setTooltip(t("setHideBuiltin")).setValue(s.hideBuiltinPrompts).onChange(async (v) => {
          s.hideBuiltinPrompts = v;
          await this.plugin.saveSettings();
        }),
      )
      .setName(t("setHideBuiltin"));

    new Setting(containerEl).setName(t("tool_text")).setHeading();

    new Setting(containerEl)
      .setName(t("setTemplatesFolder"))
      .setDesc(t("setTemplatesFolderDesc"))
      .addText((tx) =>
        tx
          .setValue(s.templatesFolder)
          .setPlaceholder("Templates")
          .onChange(async (v) => {
            s.templatesFolder = v.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName(t("setDefaultTemplate"))
      .addDropdown((dd) => {
        const opts: Record<string, string> = { builtin: t("tpl_builtin"), ask: t("tpl_ask") };
        for (const f of listTemplates(this.plugin)) opts[f.path] = f.basename;
        if (!(s.defaultTemplate in opts)) s.defaultTemplate = "builtin";
        dd.addOptions(opts)
          .setValue(s.defaultTemplate)
          .onChange(async (v) => {
            s.defaultTemplate = v;
            await this.plugin.saveSettings();
          });
      })
      .addExtraButton((b) =>
        b.setIcon("download").setTooltip(t("cmd_exportTemplate")).onClick(async () => {
          await exportBuiltinTemplate(this.plugin).catch((e) => new Notice(t("failed", { msg: errMsg(e) })));
          this.display();
        }),
      );

    new Setting(containerEl)
      .setName(t("setReadingFolder"))
      .setDesc(t("setReadingFolderDesc"))
      .addText((tx) =>
        tx
          .setValue(s.readingFolder)
          .setPlaceholder("Papers/notes")
          .onChange(async (v) => {
            s.readingFolder = v.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName(t("setAutoQuote"))
      .setDesc(t("setAutoQuoteDesc"))
      .addToggle((tg) =>
        tg.setValue(s.autoQuote).onChange(async (v) => {
          s.autoQuote = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl).setName(t("setFontSize")).addText((tx) => {
      tx.inputEl.type = "number";
      tx.setValue(String(s.fontSize)).onChange(async (v) => {
        s.fontSize = Number(v) || 12;
        await this.plugin.saveSettings();
      });
    });

    new Setting(containerEl)
      .setName(t("setRibbon"))
      .setDesc(t("setRibbonDesc"))
      .addToggle((tg) =>
        tg.setValue(s.ribbon).onChange(async (v) => {
          s.ribbon = v;
          await this.plugin.saveSettings();
        }),
      );
  }
}

export type { FormValues };
