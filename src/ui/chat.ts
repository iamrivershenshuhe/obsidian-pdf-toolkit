import { ItemView, MarkdownRenderer, Notice, TFile, WorkspaceLeaf, setIcon } from "obsidian";
import type PdfToolkitPlugin from "../main";
import { Keys, t } from "../i18n";
import { RunHandle, SlashCommand, buildCommand, listSlashCommands, looksLikeNotFound, runLlm } from "../llm/runner";
import { appendAiAnswer } from "./reading";
import { errMsg } from "../util";
import { combineContexts, sameContext } from "../llm/context";
import { getModelOptions } from "../llm/models";
import type { LlmProvider } from "../llm/runner";
import { formModal } from "./modals";
import { randomUUID } from "crypto";
import { SavedChat, safeVaultPath } from "../llm/storage";

export const CHAT_VIEW = "pdf-toolkit-chat";

export type CtxMode = "selection" | "page" | "document" | "reference";

export interface ChatContext {
  fileName: string;
  filePath: string;
  page: number;
  total: number;
  mode: CtxMode;
  text: string;
  truncated: boolean;
}

interface Msg {
  role: "user" | "assistant";
  content: string;
  question?: string;
  el?: HTMLElement;
  bodyEl?: HTMLElement;
  sourceFile?: TFile;
  sourcesText?: string;
}

const QUICK: { key: Keys; mode: CtxMode; prompt: string }[] = [
  { key: "qp_explain", mode: "selection", prompt: "Explain the selected passage in plain language. If it contains an equation or a technical term, explain what it means and why it matters here." },
  { key: "qp_translate", mode: "selection", prompt: "Translate the selected passage into Traditional Chinese (Taiwan usage). Keep technical terms in English in parentheses the first time they appear." },
  { key: "qp_summarizePage", mode: "page", prompt: "Summarize this page in 3-5 bullet points. Mention any figure or table on it and what it shows." },
  { key: "qp_terms", mode: "page", prompt: "List the key technical terms and abbreviations on this page with a one-line explanation each." },
  { key: "qp_fourQ", mode: "document", prompt: "Answer Andrew Ng's four questions about this paper: 1) What did the authors try to accomplish? 2) What are the key elements of the approach? 3) What can a reader use themselves? 4) Which references would be worth following? Be concrete and cite page numbers." },
];

const RULES =
  "You are a research assistant helping someone read an academic paper inside Obsidian. " +
  "Answer in the same language as the question (Traditional Chinese if the question is in Chinese; keep technical terms in English). " +
  "Be concise and concrete. Use Markdown. When you refer to the paper, cite page numbers like (p.3). " +
  "If the context does not contain the answer, say so instead of guessing. Do not use tools, do not read or modify files; answer from the context below.";

export class ChatView extends ItemView {
  private messages: Msg[] = [];
  private mode: CtxMode = "page";
  private running: RunHandle | null = null;
  private logEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private targetEl!: HTMLElement;
  private modeSelect!: HTMLSelectElement;
  private sendBtn!: HTMLButtonElement;
  private quickEl!: HTMLElement;
  private quickKey = "";
  private historyEl!: HTMLElement;
  private historyRevision = 0;
  private drawerEl!: HTMLElement;
  private addBtn!: HTMLButtonElement;
  private selections: ChatContext[] = [];
  private pendingShortcuts: { label: string; prompt: string; mode: CtxMode }[] = [];
  private pendingEl!: HTMLElement;
  private selectionFiles = new Map<ChatContext, TFile>();
  private contextRevision = 0;
  private runId = 0;
  private preparing = false;
  private emptyEl: HTMLElement | null = null;
  private statusEl!: HTMLElement;
  private controlsEl!: HTMLElement;
  private controlsKey = "";
  private conversationId: string = randomUUID();
  private conversationPath = "";
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private checkpointTimer: ReturnType<typeof setInterval> | null = null;
  private restoring = false;
  private persistenceFailed = false;
  private shortcutTooltip: HTMLElement | null = null;
  private tooltipTimer: ReturnType<typeof setTimeout> | null = null;
  private selectionEl!: HTMLElement;
  private slashEl!: HTMLElement;
  private slashCache: { key: string; list: SlashCommand[] } | null = null;
  private renderTimer: number | null = null;
  /** Claude Code session to continue with --resume */
  private sessionId: string | null = null;
  /** reference chosen from a citation card / the references sidebar */
  private refCtx: { text: string; label: string } | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    private plugin: PdfToolkitPlugin,
  ) {
    super(leaf);
  }

  getViewType() {
    return CHAT_VIEW;
  }
  getDisplayText() {
    return t("chat_title");
  }
  getIcon() {
    return "message-square";
  }

  /* ---------------------------------------------------------------- */
  /* UI                                                                 */
  /* ---------------------------------------------------------------- */

  async onOpen() {
    const root = this.contentEl;
    root.empty();
    root.addClass("pdftk-chat");

    const head = root.createDiv("pdftk-chat-head");
    const row1 = head.createDiv("pdftk-chat-row");
    const brand = row1.createDiv("pdftk-chat-brand");
    setIcon(brand.createSpan("pdftk-chat-brand-icon"), "sparkles");
    brand.createSpan({ text: t("chat_title") });
    const newBtn = row1.createEl("button", { cls: "clickable-icon pdftk-chat-icon" });
    setIcon(newBtn, "plus");
    newBtn.setAttr("aria-label", t("chat_new"));
    newBtn.setAttr("title", t("chat_new"));
    newBtn.onclick = () => this.newChat();
    const historyBtn = row1.createEl("button", { cls: "clickable-icon pdftk-chat-icon" });
    setIcon(historyBtn, "history");
    historyBtn.setAttr("aria-label", t("chat_history"));
    historyBtn.setAttr("title", t("chat_history"));
    historyBtn.onclick = () => void this.chooseHistory();
    this.historyEl = head.createDiv("pdftk-chat-history-panel");
    this.historyEl.hidden = true;
    this.targetEl = head.createDiv("pdftk-chat-target");
    this.controlsEl = head.createDiv("pdftk-chat-model-controls");
    this.refreshSettings();

    const ctxRow = head.createDiv("pdftk-chat-ctx");
    ctxRow.createSpan({ text: t("chat_context") + ": " });
    this.modeSelect = ctxRow.createEl("select", { cls: "dropdown" });
    for (const m of ["selection", "page", "document", "reference"] as CtxMode[]) this.modeSelect.createEl("option", { value: m, text: t(("ctx_" + m) as Keys) });
    this.modeSelect.value = this.mode;
    this.modeSelect.onchange = () => {
      this.mode = this.modeSelect.value as CtxMode;
      this.contextRevision++;
      this.sessionId = null;
      this.renderSelection();
      this.refreshTarget();
    };

    const quick = head.createEl("details", { cls: "pdftk-chat-shortcuts" });
    quick.createEl("summary", { text: t("chat_shortcuts") });
    this.quickEl = quick.createDiv("pdftk-chat-quick");
    this.renderQuick();
    const addShortcut = quick.createEl("button", { text: t("prompt_add"), cls: "pdftk-shortcut-add" });
    addShortcut.onclick = () => void this.editShortcut();

    this.logEl = root.createDiv("pdftk-chat-log");
    this.logEl.setAttr("role", "log");
    this.renderEmpty();

    const inputWrap = root.createDiv("pdftk-chat-inputwrap");
    this.drawerEl = inputWrap.createDiv("pdftk-chat-add-panel");
    this.drawerEl.hidden = true;
    for (const mode of ["selection", "page", "document"] as const) {
      const add = this.drawerEl.createEl("button", { cls: "pdftk-chat-add-source" });
      setIcon(add.createSpan(), mode === "selection" ? "text-select" : mode === "page" ? "file-text" : "files");
      add.createSpan({ text: t("chat_addContext") + " · " + t(("ctx_" + mode) as Keys) });
      add.onclick = async () => {
        if (this.restoring || add.disabled) return;
        const conversation = this.conversationId;
        add.disabled = true;
        try {
          const context = await this.plugin.getChatContext(mode);
          if (conversation !== this.conversationId) return;
          if (!context?.text.trim()) { new Notice(t("chat_noSelection")); return; }
          this.attachSelection(context);
          this.closeDrawer();
        } catch (err) { new Notice(t("failed", { msg: errMsg(err) })); }
        finally { add.disabled = false; }
      };
    }
    this.drawerEl.appendChild(quick);
    const preferences = head.createDiv("pdftk-chat-preferences");
    preferences.hidden = true;
    preferences.appendChild(ctxRow);
    const settingsBtn = row1.createEl("button", { cls: "clickable-icon pdftk-chat-icon" });
    setIcon(settingsBtn, "settings-2");
    settingsBtn.setAttr("title", t("chat_readingSettings"));
    settingsBtn.setAttr("aria-label", t("chat_readingSettings"));
    settingsBtn.setAttr("aria-expanded", "false");
    settingsBtn.onclick = () => {
      preferences.hidden = !preferences.hidden;
      settingsBtn.setAttr("aria-expanded", String(!preferences.hidden));
    };
    this.registerDomEvent(root, "keydown", (event) => {
      if (event.key === "Escape") { preferences.hidden = true; settingsBtn.setAttr("aria-expanded", "false"); }
    });
    this.selectionEl = inputWrap.createDiv("pdftk-chat-selection");
    this.renderSelection();
    this.pendingEl = inputWrap.createDiv("pdftk-chat-pending-shortcuts");
    this.slashEl = inputWrap.createDiv("pdftk-chat-slash");
    this.slashEl.hide();
    const inputRow = inputWrap.createDiv("pdftk-chat-input");
    this.addBtn = inputRow.createEl("button", { cls: "clickable-icon pdftk-chat-add" });
    setIcon(this.addBtn, "plus");
    this.addBtn.setAttr("aria-label", t("chat_addContext"));
    this.addBtn.setAttr("title", t("chat_addContext"));
    this.addBtn.setAttr("aria-expanded", "false");
    this.addBtn.onclick = () => {
      this.drawerEl.hidden = !this.drawerEl.hidden;
      this.addBtn.setAttr("aria-expanded", String(!this.drawerEl.hidden));
      if (!this.drawerEl.hidden) this.drawerEl.querySelector<HTMLButtonElement>("button")?.focus();
    };
    this.registerDomEvent(root, "keydown", (event) => {
      if (event.key === "Escape") {
        this.closeDrawer(); this.historyEl.hidden = true; this.historyRevision++;
        this.inputEl.focus();
      }
    });
    this.registerDomEvent(root.ownerDocument, "pointerdown", (event) => {
      const target = event.target as Node;
      if (!this.drawerEl.contains(target) && !this.addBtn.contains(target)) this.closeDrawer();
      if (!head.contains(target)) { this.historyEl.hidden = true; this.historyRevision++; }
    });
    this.inputEl = inputRow.createEl("textarea", { attr: { rows: "3", placeholder: t("chat_placeholder") } });
    this.inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        this.slashEl.hide();
        return;
      }
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        void this.send(this.inputEl.value);
      }
    });
    this.inputEl.setAttr("aria-label", t("chat_placeholder"));
    this.inputEl.addEventListener("input", () => {
      this.updateSlash();
      this.inputEl.style.height = "auto";
      this.inputEl.style.height = `${Math.min(180, this.inputEl.scrollHeight)}px`;
      this.setSendState(!!this.running || this.preparing);
      this.scheduleSave();
    });
    this.sendBtn = inputRow.createEl("button", { cls: "mod-cta pdftk-chat-send" });
    this.setSendState(false);
    this.sendBtn.onclick = () => {
      if (this.running || this.preparing) this.stop();
      else void this.send(this.inputEl.value);
    };

    inputWrap.appendChild(this.controlsEl);
    this.statusEl = inputWrap.createDiv({ text: t("chat_inputHint"), cls: "pdftk-chat-status" });
    this.statusEl.setAttr("role", "status");
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.refreshTarget()));
    this.registerEvent(this.app.workspace.on("file-open", () => this.refreshTarget()));
    this.refreshTarget();
    if (this.plugin.chatHistory) {
      this.restoring = true;
      try {
        const index = await this.plugin.chatHistory.index();
        if (index.last) await this.restoreConversation(index.last);
      } catch (err) { new Notice(t("chat_restoreFailed", { msg: errMsg(err) })); }
      finally { this.restoring = false; }
    }
  }

  async onClose() {
    this.hideShortcutTooltip();
    this.historyRevision++;
    this.stop();
    if (this.saveTimer) clearTimeout(this.saveTimer);
    await this.persist();
  }

  private closeDrawer() {
    this.drawerEl.hidden = true;
    this.addBtn.setAttr("aria-expanded", "false");
    this.hideShortcutTooltip();
  }

  private setSendState(running: boolean) {
    this.sendBtn.empty();
    setIcon(this.sendBtn, running ? "square" : "send");
    this.sendBtn.setAttr("aria-label", running ? t("chat_stop") : t("chat_send"));
    this.sendBtn.toggleClass("is-running", running);
    this.sendBtn.disabled = !running && !this.inputEl.value.trim() && !this.pendingShortcuts.length;
    if (this.statusEl) this.statusEl.setText(t(running ? "chat_running" : "chat_inputHint"));
    this.controlsEl?.querySelectorAll<HTMLElement>("select, button").forEach((el) => (el as HTMLSelectElement).disabled = running || el.dataset.unsupported === "true");
  }

  /** Built-in + user-defined prompt buttons (re-rendered when settings change). */
  private renderQuick() {
    if (!this.quickEl) return;
    const s = this.plugin.settings;
    const list: { label: string; mode: CtxMode; prompt: string; description: string; index?: number }[] = [];
    if (!s.hideBuiltinPrompts) for (const q of QUICK) list.push({ label: t(q.key), mode: q.mode, prompt: q.prompt, description: t((q.key + "Desc") as Keys) });
    s.customPrompts.forEach((p, index) => { if (p.name.trim() && p.prompt.trim()) list.push({ label: p.name.trim(), mode: p.mode, prompt: p.prompt, description: p.description || p.prompt, index }); });
    const key = JSON.stringify(list);
    if (key === this.quickKey) return;
    this.hideShortcutTooltip();
    this.quickKey = key;
    this.quickEl.empty();
    for (const q of list) {
      const item = this.quickEl.createDiv("pdftk-shortcut-item");
      const b = item.createEl("button", { cls: "pdftk-shortcut-card" });
      b.createSpan({ text: q.label, cls: "pdftk-shortcut-name" });
      b.createSpan({ text: q.description, cls: "pdftk-shortcut-description" });
      b.setAttr("title", q.prompt);
      const showTooltip = () => this.showShortcutTooltip(b, q.prompt);
      const hideTooltip = () => { this.tooltipTimer = setTimeout(() => this.hideShortcutTooltip(), 150); };
      b.onmouseenter = showTooltip;
      b.onfocus = showTooltip;
      b.onmouseleave = hideTooltip;
      b.onblur = hideTooltip;
      b.onkeydown = (event) => { if (event.key === "Escape") this.hideShortcutTooltip(); };
      if (q.index !== undefined) {
        const edit = item.createEl("button", { cls: "clickable-icon pdftk-shortcut-edit" });
        setIcon(edit, "pencil"); edit.setAttr("aria-label", t("shortcut_edit"));
        edit.onclick = () => void this.editShortcut(q.index);
      }
      b.onclick = () => {
        if (this.running || this.preparing) return;
        this.hideShortcutTooltip();
        this.contextRevision++;
        this.sessionId = null;
        if (!this.pendingShortcuts.some((item) => item.prompt === q.prompt && item.mode === q.mode)) {
          this.pendingShortcuts.push({ label: q.label, prompt: q.prompt, mode: q.mode });
        }
        this.renderPendingShortcuts();
        this.closeDrawer();
        this.setSendState(false);
        this.scheduleSave();
        this.inputEl.focus();
      };
    }
  }

  private renderPendingShortcuts() {
    this.pendingEl.empty();
    for (const item of this.pendingShortcuts) {
      const card = this.pendingEl.createDiv("pdftk-shortcut-pending");
      const details = card.createEl("details");
      details.createEl("summary", { text: item.label });
      details.createEl("p", { text: item.prompt });
      const remove = card.createEl("button", { cls: "clickable-icon" });
      setIcon(remove, "x");
      remove.setAttr("aria-label", "Remove " + item.label);
      remove.onclick = () => {
        this.pendingShortcuts = this.pendingShortcuts.filter((p) => p !== item);
        this.renderPendingShortcuts();
        this.setSendState(!!this.running || this.preparing);
        this.scheduleSave();
      };
    }
  }

  private refreshTarget() {
    this.refreshSelectionFiles();
    this.renderQuick();
    const tb = this.plugin.chatTarget();
    const provider = this.plugin.settings.llmProvider;
    const who = t(("llm_" + provider) as Keys);
    const name = this.mode === "selection" && this.selections.length ? this.selections[0].fileName : tb?.file?.name;
    this.targetEl.setText(name ? `📄 ${name}   ·   ${who}${this.sessionId ? " ⟳" : ""}` : t("chat_noPdf"));
  }

  private newChat() {
    if (this.restoring) return;
    this.closeDrawer();
    this.historyEl.hidden = true; this.historyRevision++;
    this.stop();
    void this.persist();
    this.conversationId = randomUUID();
    this.conversationPath = "";
    this.messages = [];
    this.logEl.empty();
    this.renderEmpty();
    this.sessionId = null;
    this.refCtx = null;
    this.selections = [];
    this.pendingShortcuts = [];
    this.renderPendingShortcuts();
    this.selectionFiles.clear();
    this.contextRevision++;
    this.renderSelection();
    if (this.mode === "reference") {
      this.mode = "page";
      this.modeSelect.value = "page";
    }
    this.refreshTarget();
    this.inputEl.focus();
    this.inputEl.value = "";
    this.inputEl.style.height = "auto";
    this.setSendState(false);
    this.scheduleSave();
  }

  private stop() {
    if (this.checkpointTimer) clearInterval(this.checkpointTimer);
    this.checkpointTimer = null;
    this.runId++;
    this.preparing = false;
    this.sessionId = null;
    if (this.running) {
      this.running.kill();
      this.running = null;
    }
    const reply = this.messages[this.messages.length - 1];
    if (reply?.role === "assistant" && reply.bodyEl?.hasClass("is-streaming")) {
      if (!reply.content) reply.content = t("chat_stopped");
      this.renderMarkdown(reply);
    }
    this.setSendState(false);
    this.scheduleSave();
  }

  /* ---------------------------------------------------------------- */
  /* Slash command suggestions                                          */
  /* ---------------------------------------------------------------- */

  private slashCommands(): SlashCommand[] {
    const key = `${this.plugin.settings.llmProvider}|${this.plugin.vaultPath()}`;
    if (this.slashCache?.key !== key) this.slashCache = { key, list: listSlashCommands(this.plugin.settings.llmProvider, this.plugin.vaultPath()) };
    return this.slashCache.list;
  }

  private updateSlash() {
    const v = this.inputEl.value;
    const m = v.match(/^\/([\w:.-]*)$/);
    if (!m) {
      this.slashEl.hide();
      return;
    }
    const prefix = m[1].toLowerCase();
    const list = this.slashCommands().filter((c) => c.name.toLowerCase().startsWith(prefix)).slice(0, 12);
    this.slashEl.empty();
    if (!list.length) {
      this.slashEl.hide();
      return;
    }
    this.slashEl.createDiv({ text: t("chat_slash"), cls: "pdftk-chat-slash-title" });
    for (const c of list) {
      const row = this.slashEl.createDiv("pdftk-chat-slash-row");
      row.createSpan({ text: "/" + c.name, cls: "pdftk-chat-slash-name" });
      row.createSpan({ text: c.source, cls: "pdftk-chat-slash-src" });
      row.onclick = () => {
        this.inputEl.value = "/" + c.name + " ";
        this.setSendState(!!this.running || this.preparing);
        this.slashEl.hide();
        this.inputEl.focus();
      };
    }
    this.slashEl.show();
  }

  /* ---------------------------------------------------------------- */
  /* Messages                                                           */
  /* ---------------------------------------------------------------- */

  private addMessage(role: Msg["role"], content: string, question?: string): Msg {
    this.emptyEl?.remove();
    this.emptyEl = null;
    const el = this.logEl.createDiv(`pdftk-chat-msg is-${role}`);
    el.createDiv({ text: t(role === "user" ? "chat_you" : "chat_assistant"), cls: "pdftk-chat-role" });
    const bodyEl = el.createDiv("pdftk-chat-body");
    const msg: Msg = { role, content, question, el, bodyEl };
    this.messages.push(msg);
    if (role === "assistant") {
      bodyEl.addClass("is-streaming");
      bodyEl.setText(t("chat_running"));
      const tools = el.createDiv("pdftk-chat-tools");
      const toNote = tools.createEl("button", { text: t("chat_toNote"), cls: "pdftk-chat-chip" });
      toNote.onclick = () => void this.toNote(msg);
      const copy = tools.createEl("button", { text: t("chat_copy"), cls: "pdftk-chat-chip" });
      copy.onclick = () => void navigator.clipboard.writeText(msg.content).then(() => new Notice(t("copied")));
    } else {
      bodyEl.setText(content);
    }
    this.logEl.scrollTop = this.logEl.scrollHeight;
    return msg;
  }

  /** Cheap update while streaming: plain text only. */
  private scheduleText(msg: Msg) {
    if (this.renderTimer !== null) return;
    this.renderTimer = window.setTimeout(() => {
      this.renderTimer = null;
      if (!msg.bodyEl) return;
      msg.bodyEl.setText(msg.content);
      this.logEl.scrollTop = this.logEl.scrollHeight;
    }, 120);
  }

  /** Final render as Markdown. */
  private renderMarkdown(msg: Msg) {
    if (!msg.bodyEl) return;
    if (this.renderTimer !== null) {
      window.clearTimeout(this.renderTimer);
      this.renderTimer = null;
    }
    msg.bodyEl.removeClass("is-streaming");
    msg.bodyEl.empty();
    const tb = this.plugin.chatTarget();
    void MarkdownRenderer.render(this.app, msg.content, msg.bodyEl, msg.sourceFile?.path ?? tb?.file?.path ?? "", this).then(() => {
      this.logEl.scrollTop = this.logEl.scrollHeight;
    });
  }

  private async toNote(msg: Msg) {
    const tb = this.plugin.chatTarget();
    const file = msg.sourceFile ?? tb?.file;
    if (!file) {
      new Notice(t("chat_noPdf"));
      return;
    }
    try {
      await appendAiAnswer(this.plugin, file, msg.question ?? "", msg.content);
    } catch (e) {
      new Notice(t("failed", { msg: errMsg(e) }));
    }
  }

  /* ---------------------------------------------------------------- */
  /* Context + prompt                                                   */
  /* ---------------------------------------------------------------- */

  /** Called from a citation card or the references sidebar. */
  askReference(text: string, label: string, question?: string) {
    this.refCtx = { text, label };
    this.mode = "reference";
    this.modeSelect.value = "reference";
    this.renderSelection();
    const q = (question ?? this.plugin.settings.refQuestion).trim() || t("ref_defaultQuestion");
    void this.send(q, `${label}: ${q}`);
  }

  private async buildContext(mode: CtxMode = this.mode, includeAttachments = true): Promise<ChatContext | null> {
    this.refreshSelectionFiles();
    const attached = includeAttachments ? this.selections.map((ctx) => ({ ...ctx })) : [];
    const combine = (ctx?: ChatContext) => combineContexts(ctx ? [ctx, ...attached] : attached, this.plugin.settings.llmMaxChars);
    if (mode === "selection" && attached.length) {
      return combine();
    }
    if (mode === "reference") {
      if (!this.refCtx) {
        new Notice(t("chat_noRef"));
        return null;
      }
      const tb = this.plugin.chatTarget();
      return combine({
        fileName: tb?.file?.name ?? "",
        filePath: tb?.file?.path ?? "",
        page: tb?.currentPage() ?? 1,
        total: tb?.pageCount() ?? 0,
        mode: "reference",
        text: `Reference entry (${this.refCtx.label}):\n${this.refCtx.text}`,
        truncated: false,
      });
    }
    let ctx = await this.plugin.getChatContext(mode);
    if (!ctx) {
      new Notice(t("chat_noPdf"));
      return null;
    }
    if (mode === "selection" && !ctx.text) {
      new Notice(t("chat_noSelection"));
      ctx = await this.plugin.getChatContext("page");
    }
    return ctx ? combine(ctx) : null;
  }

  private buildPrompt(ctx: ChatContext, question: string, includeHistory: boolean): string {
    const modeLabel =
      ctx.mode === "selection"
        ? `selected passage starting on page ${ctx.page} of ${ctx.total}`
        : ctx.mode === "page"
          ? `page ${ctx.page} of ${ctx.total}`
          : ctx.mode === "reference"
            ? "one entry of the reference list, cited in the paper being read"
            : `full text (${ctx.total} pages)`;
    const contextBlock = [`=== READING CONTEXT — ${modeLabel}${ctx.truncated ? " (truncated; some source text omitted)" : ""} ===`, "Each source is separately labeled. Cite its file name and page; do not mix up sources.", ctx.text || "(no text)", "=== END CONTEXT ==="].join("\n");
    const history = includeHistory
      ? this.messages
          .slice(0, -2)
          .filter((m) => m.content && m.el)
          .slice(-8)
          .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.role === "user" ? m.question ?? m.content : m.content}`)
          .join("\n\n")
      : "";
    // A slash command must be the first thing the CLI sees.
    if (question.startsWith("/")) return [question, "", RULES, "", contextBlock, history ? `\nConversation so far:\n${history}` : ""].join("\n");
    return [RULES, "", contextBlock, "", history ? `Conversation so far:\n${history}\n` : "", `Question: ${question}`].join("\n");
  }

  /* ---------------------------------------------------------------- */
  /* Send                                                               */
  /* ---------------------------------------------------------------- */

  async send(question: string, label?: string) {
    const staged = label ? [] : [...this.pendingShortcuts];
    const q = [question.trim(), ...staged.map((item) => item.label + ":\n" + item.prompt)].filter(Boolean).join("\n\n");
    if (!q || this.running || this.preparing || this.restoring) return;
    const runSettings = { ...this.plugin.settings };
    const id = ++this.runId;
    const revision = this.contextRevision;
    this.preparing = true;
    this.setSendState(true);
    this.slashEl.hide();
    let ctx: ChatContext | null;
    try {
      const modes = [...new Set(staged.length ? staged.map((item) => item.mode) : [this.mode])];
      const contexts: ChatContext[] = [];
      for (const mode of modes) {
        const part = await this.buildContext(mode, contexts.length === 0);
        if (!part || id !== this.runId) { contexts.length = 0; break; }
        contexts.push(part);
      }
      ctx = contexts.length ? (contexts.length === 1 ? contexts[0] : combineContexts(contexts, runSettings.llmMaxChars)) : null;
    } catch (e) {
      if (id === this.runId) new Notice(t("failed", { msg: errMsg(e) }));
      ctx = null;
    }
    if (id !== this.runId) return;
    this.preparing = false;
    if (!ctx) { this.setSendState(false); return; }
    this.pendingShortcuts = this.pendingShortcuts.filter((item) => !staged.includes(item));
    this.renderPendingShortcuts();
    this.inputEl.value = "";
    this.inputEl.style.height = "auto";
    const isClaude = runSettings.llmProvider === "claude";
    let resume = isClaude && this.sessionId ? this.sessionId : undefined;

    const user = this.addMessage("user", label ?? q, q);
    user.sourcesText = ctx.text;
    const sources = user.el!.createEl("details", { cls: "pdftk-chat-sources" });
    sources.createEl("summary", { text: t("chat_sentContext") });
    sources.createEl("pre", { text: ctx.text });
    if (ctx.truncated) sources.createDiv({ text: t("chat_contextTruncated") });
    const reply = this.addMessage("assistant", "", label ?? q);
    const source = this.app.vault.getAbstractFileByPath(ctx.filePath);
    if (source instanceof TFile) reply.sourceFile = source;
    this.setSendState(true);
    const cwd = this.plugin.vaultPath();
    void this.persist();
    this.checkpointTimer = setInterval(() => { void this.persist(); }, 2000);

    const attempt = (plainText: boolean, resumeId: string | undefined, history: boolean) => {
      reply.content = "";
      const prompt = this.buildPrompt(ctx, q, history);
      const handle = runLlm(
        runSettings,
        prompt,
        cwd,
        (chunk) => {
          if (id !== this.runId) return;
          reply.content += chunk;
          this.scheduleText(reply);
        },
        { plainText, resume: resumeId },
      );
      this.running = handle;
      return handle.done;
    };

    try {
      let res = await attempt(false, resume, !resume);
      if (id !== this.runId) return;
      let failed = res.code !== 0 && !res.text.trim();
      if (failed && resume && this.running) {
        // the session may have expired: start a fresh one with the history inlined
        resume = undefined;
        this.sessionId = null;
        res = await attempt(false, undefined, true);
        if (id !== this.runId) return;
        failed = res.code !== 0 && !res.text.trim();
      }
      if (failed && isClaude && !looksLikeNotFound(res.stderr, res.code) && this.running) {
        // CLI without stream-json flags → plain text mode
        res = await attempt(true, undefined, true);
        if (id !== this.runId) return;
        failed = res.code !== 0 && !res.text.trim();
      }
      if (!this.running) return; // stopped by the user
      if (res.sessionId && revision === this.contextRevision) this.sessionId = res.sessionId;
      if (res.text.trim()) reply.content = res.text;
      if (failed) {
        const cmd = buildCommand(this.plugin.settings, { plainText: true }).line.split(" ")[0];
        reply.content = looksLikeNotFound(res.stderr, res.code)
          ? `> [!error] ${t("chat_notFound", { cmd })}`
          : `> [!error] ${t("chat_failed", { code: String(res.code), err: res.stderr.trim().slice(0, 800) })}`;
      }
    } catch (e) {
      if (id === this.runId) reply.content = `> [!error] ${errMsg(e)}`;
    } finally {
      if (id !== this.runId) return;
      if (this.checkpointTimer) clearInterval(this.checkpointTimer);
      this.checkpointTimer = null;
      this.running = null;
      this.setSendState(false);
      this.renderMarkdown(reply);
      this.refreshTarget();
      this.inputEl.focus();
      void this.persist();
    }
  }
  attachSelection(context: ChatContext) {
    this.refreshSelectionFiles();
    if (!this.selections.some((ctx) => sameContext(ctx, context))) {
      const attached = { ...context };
      this.selections.push(attached);
      const file = this.app.vault.getAbstractFileByPath(context.filePath);
      if (file instanceof TFile) this.selectionFiles.set(attached, file);
      this.contextRevision++;
      this.sessionId = null;
    }
    this.mode = "selection";
    this.modeSelect.value = this.mode;
    this.renderSelection();
    this.refreshTarget();
    this.inputEl.focus();
    this.scheduleSave();
  }

  private renderSelection() {
    if (!this.selectionEl) return;
    this.selectionEl.empty();
    this.selectionEl.toggleClass("is-hidden", !this.selections.length);
    if (!this.selections.length) return;
    this.selectionEl.createDiv({ text: t("chat_attached", { n: this.selections.length }), cls: "pdftk-chat-attachments-label" });
    for (const ctx of this.selections) {
      const card = this.selectionEl.createDiv("pdftk-chat-attachment");
      const details = card.createEl("details");
      details.createEl("summary", { text: `${ctx.fileName} · p.${ctx.page}` });
      details.createDiv({ text: ctx.text, cls: "pdftk-chat-selection-text" });
      const remove = card.createEl("button", { cls: "clickable-icon pdftk-chat-remove" });
      setIcon(remove, "x");
      remove.setAttr("aria-label", `${t("chat_removeSelection")}: ${ctx.fileName} · p.${ctx.page}`);
      remove.setAttr("title", t("chat_removeSelection"));
      remove.onclick = () => {
        this.selections = this.selections.filter((item) => item !== ctx);
        this.selectionFiles.delete(ctx);
        this.contextRevision++;
        this.sessionId = null;
        this.renderSelection();
        this.refreshTarget();
        this.scheduleSave();
      };
    }
  }

  private renderEmpty() {
    this.emptyEl?.remove();
    this.emptyEl = this.logEl.createDiv("pdftk-chat-empty");
    setIcon(this.emptyEl.createDiv("pdftk-chat-empty-icon"), "book-open");
    this.emptyEl.createEl("h3", { text: t("chat_welcome") });
    this.emptyEl.createEl("p", { text: t("chat_welcomeHint") });
  }

  private hideShortcutTooltip() {
    if (this.tooltipTimer) clearTimeout(this.tooltipTimer);
    this.tooltipTimer = null;
    this.shortcutTooltip?.remove();
    this.shortcutTooltip = null;
  }

  private showShortcutTooltip(anchor: HTMLElement, prompt: string) {
    this.hideShortcutTooltip();
    const doc = anchor.ownerDocument;
    const tooltip = doc.body.createDiv({ text: prompt, cls: "pdftk-shortcut-tooltip" });
    this.shortcutTooltip = tooltip;
    tooltip.setAttr("role", "tooltip");
    tooltip.id = `pdftk-prompt-${randomUUID()}`;
    anchor.setAttr("aria-describedby", tooltip.id);
    tooltip.onmouseenter = () => { if (this.tooltipTimer) clearTimeout(this.tooltipTimer); };
    tooltip.onmouseleave = () => this.hideShortcutTooltip();
    const rect = anchor.getBoundingClientRect();
    const width = Math.min(380, doc.documentElement.clientWidth - 16);
    tooltip.style.width = `${width}px`;
    tooltip.style.left = `${Math.max(8, Math.min(rect.left, doc.documentElement.clientWidth - width - 8))}px`;
    tooltip.style.top = `${Math.max(8, Math.min(rect.bottom + 5, doc.documentElement.clientHeight - tooltip.offsetHeight - 8))}px`;
  }

  refreshSettings() {
    if (!this.controlsEl) return;
    const s = this.plugin.settings;
    const models = getModelOptions(s.llmProvider, s.llmModelCatalog?.[s.llmProvider] || "");
    const key = JSON.stringify([s.llmProvider, s.llmModel, s.llmEffort, s.llmEnabledProviders, models]);
    this.renderQuick();
    if (key === this.controlsKey) return;
    this.controlsKey = key;
    this.sessionId = null;
    this.contextRevision++;
    this.controlsEl.empty();
    const select = (label: string) => {
      const row = this.controlsEl.createEl("label");
      row.createSpan({ text: label, cls: "pdftk-sr-only" });
      row.setAttr("title", label);
      return row.createEl("select", { cls: "dropdown" });
    };
    const provider = select(t("chat_provider"));
    for (const id of s.llmEnabledProviders || ["claude", "codex"]) provider.createEl("option", { value: id, text: t(("llm_" + id) as Keys) });
    provider.value = s.llmProvider;
    provider.onchange = () => {
      const next = provider.value as LlmProvider;
      s.llmProfiles ??= {};
      s.llmProfiles[s.llmProvider] = { model: s.llmModel, effort: s.llmEffort || "" };
      s.llmProvider = next;
      s.llmModel = s.llmProfiles[next]?.model || "";
      s.llmEffort = s.llmProfiles[next]?.effort || "";
      void this.saveModelChoice();
    };
    const model = select(t("setLlmModel"));
    model.createEl("option", { value: "", text: t("chat_cliDefault") });
    for (const option of models) model.createEl("option", { value: option.id, text: option.label });
    if (s.llmModel && !models.some((item) => item.id === s.llmModel)) model.createEl("option", { value: s.llmModel, text: s.llmModel });
    model.createEl("option", { value: "__custom__", text: t("chat_customModel") });
    model.value = s.llmModel;
    model.onchange = async () => {
      let value = model.value;
      if (value === "__custom__") {
        const result = await formModal(this.app, t("chat_customModel"), [{ kind: "text", key: "model", label: t("setLlmModel") }]);
        if (!result || this.running || this.preparing) { model.value = s.llmModel; return; }
        value = String(result.model).trim();
        if (!/^[\w./:@+\[\]-]+$/.test(value)) { new Notice(t("chat_invalidModel")); model.value = s.llmModel; return; }
      }
      s.llmModel = value;
      s.llmEffort = "";
      await this.saveModelChoice();
    };
    const effort = select("Effort");
    effort.createEl("option", { value: "", text: "Effort · " + t("chat_cliDefault") });
    const levels = models.find((item) => item.id === s.llmModel)?.efforts || [];
    for (const level of levels) effort.createEl("option", { value: level, text: level });
    if (s.llmEffort && !levels.includes(s.llmEffort)) s.llmEffort = "";
    effort.value = s.llmEffort || "";
    effort.dataset.unsupported = String(!levels.length);
    effort.disabled = !levels.length;
    effort.onchange = () => { s.llmEffort = effort.value; void this.saveModelChoice(); };
  }

  private async saveModelChoice() {
    const s = this.plugin.settings;
    s.llmProfiles ??= {};
    s.llmProfiles[s.llmProvider] = { model: s.llmModel, effort: s.llmEffort || "" };
    try { await this.plugin.saveSettings(); } catch (err) { new Notice(t("failed", { msg: errMsg(err) })); }
    this.refreshSettings();
    this.refreshTarget();
    this.scheduleSave();
  }

  private async editShortcut(index?: number) {
    const original = index === undefined ? undefined : this.plugin.settings.customPrompts[index];
    let values = { name: original?.name || "", description: original?.description || "", mode: original?.mode || "page", prompt: original?.prompt || "" };
    for (;;) {
      const result = await formModal(this.app, t(original ? "shortcut_edit" : "prompt_add"), [
        { kind: "text", key: "name", label: t("prompt_name"), value: values.name },
        { kind: "textarea", key: "description", label: t("shortcut_description"), value: values.description, rows: 2 },
        { kind: "dropdown", key: "mode", label: t("prompt_mode"), value: values.mode, options: { selection: t("ctx_selection"), page: t("ctx_page"), document: t("ctx_document"), reference: t("ctx_reference") } },
        { kind: "textarea", key: "prompt", label: t("prompt_text"), value: values.prompt, rows: 8 },
      ], t("save"));
      if (!result) return;
      values = { name: String(result.name).trim(), description: String(result.description).trim(), mode: String(result.mode) as CtxMode, prompt: String(result.prompt).trim() };
      if (!values.name || !values.prompt) { new Notice(t("shortcut_required")); continue; }
      if (original) Object.assign(original, values);
      else this.plugin.settings.customPrompts.push(values);
      await this.plugin.saveSettings();
      this.renderQuick();
      return;
    }
  }

  private scheduleSave() {
    if (this.restoring || !this.plugin.chatHistory) return;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => { this.saveTimer = null; void this.persist(); }, 500);
  }

  private async persist(whileRestoring = false) {
    if (!this.plugin.chatHistory || (this.restoring && !whileRestoring) || !this.inputEl) return;
    if (!this.conversationPath && !this.messages.length && !this.selections.length && !this.pendingShortcuts.length && !this.inputEl.value.trim()) return;
    try {
      this.refreshSelectionFiles();
      if (!this.conversationPath) {
        const source = this.selections[0]?.filePath || this.plugin.chatTarget()?.file?.path || "";
        const parent = source.includes("/") ? source.slice(0, source.lastIndexOf("/")) + "/" : "";
        const basename = source.split("/").pop()?.replace(/\.pdf$/i, "") || "";
        const folder = this.plugin.settings.chatHistoryFolder || (source ? `${parent}${basename}.ai` : "PDF Toolkit/Conversations");
        this.conversationPath = safeVaultPath(`${folder}/${this.conversationId}.chat.json`);
      }
      const s = this.plugin.settings;
      const chat: SavedChat = {
        version: 1, id: this.conversationId, path: this.conversationPath,
        title: (this.messages.find((m) => m.role === "user")?.content || this.selections[0]?.fileName || "Conversation").replace(/\s+/g, " ").slice(0, 100),
        updated: new Date().toISOString(),
        messages: this.messages.map((m) => ({ role: m.role, content: m.content, question: m.question, sourcePath: m.sourceFile?.path, sourcesText: m.sourcesText })),
        selections: this.selections.map((ctx) => ({ ...ctx })), mode: this.mode, draft: this.inputEl.value,
        provider: s.llmProvider, model: s.llmModel, effort: s.llmEffort || "",
        pendingShortcuts: this.pendingShortcuts.map((item) => ({ ...item })),
        reference: this.refCtx,
      };
      await this.plugin.chatHistory.save(chat);
      this.persistenceFailed = false;
    } catch (err) {
      if (!this.persistenceFailed) new Notice(t("chat_saveFailed", { msg: errMsg(err) }));
      this.persistenceFailed = true;
    }
  }

  private async restoreConversation(path: string) {
    const saved = await this.plugin.chatHistory.load(path);
    const wasRestoring = this.restoring;
    this.restoring = true;
    try {
      this.stop();
      this.conversationId = saved.id;
      this.conversationPath = saved.path;
      this.messages = [];
      this.logEl.empty();
      this.selections = saved.selections;
      this.pendingShortcuts = saved.pendingShortcuts || [];
      this.renderPendingShortcuts();
      this.selectionFiles.clear();
      for (const ctx of this.selections) {
        const file = this.app.vault.getAbstractFileByPath(ctx.filePath);
        if (file instanceof TFile) this.selectionFiles.set(ctx, file);
      }
      this.refCtx = saved.reference || null;
      this.mode = saved.mode === "reference" && !this.refCtx ? "page" : saved.mode;
      this.modeSelect.value = this.mode;
      for (const data of saved.messages) {
        const msg = this.addMessage(data.role, data.content, data.question);
        msg.sourcesText = data.sourcesText;
        const file = data.sourcePath ? this.app.vault.getAbstractFileByPath(data.sourcePath) : null;
        if (file instanceof TFile) msg.sourceFile = file;
        if (data.role === "assistant") this.renderMarkdown(msg);
        if (data.sourcesText) {
          const sources = msg.el!.createEl("details", { cls: "pdftk-chat-sources" });
          sources.createEl("summary", { text: t("chat_sentContext") });
          sources.createEl("pre", { text: data.sourcesText });
        }
      }
      if (!this.messages.length) this.renderEmpty();
      this.inputEl.value = saved.draft;
      const settings = this.plugin.settings;
      if (settings.llmEnabledProviders?.includes(saved.provider)) {
        settings.llmProvider = saved.provider;
        settings.llmModel = saved.model || "";
        settings.llmEffort = saved.effort || "";
        await this.plugin.saveSettings();
        this.refreshSettings();
      }
      this.contextRevision++;
      this.renderSelection();
      this.refreshTarget();
      this.setSendState(false);
    } finally { this.restoring = wasRestoring; }
  }

  private async chooseHistory() {
    if (!this.plugin.chatHistory || this.restoring) return;
    if (!this.historyEl.hidden) { this.historyEl.hidden = true; this.historyRevision++; return; }
    const revision = ++this.historyRevision;
    this.historyEl.hidden = false;
    this.historyEl.empty();
    this.historyEl.createDiv({ text: t("working") });
    await this.persist();
    try {
      const { entries } = await this.plugin.chatHistory.index();
      if (revision !== this.historyRevision) return;
      this.historyEl.empty();
      const search = this.historyEl.createEl("input", { type: "search", attr: { placeholder: t("chat_searchHistory"), "aria-label": t("chat_searchHistory") } });
      const list = this.historyEl.createDiv("pdftk-chat-history-list");
      const render = () => {
        list.empty();
        const query = search.value.toLowerCase().trim();
        const matches = entries.filter((item) => (item.title + " " + item.path).toLowerCase().includes(query));
        if (!matches.length) list.createDiv({ text: t("chat_noHistory"), cls: "pdftk-chat-history-empty" });
        for (const item of matches) {
          const row = list.createEl("button", { cls: "pdftk-chat-history-item" });
          row.createSpan({ text: item.title });
          row.createEl("small", { text: item.updated.slice(0, 10) });
          row.setAttr("title", item.path);
          row.onclick = async () => {
            if (this.restoring) return;
            this.stop();
            const saving = this.persist();
            this.restoring = true;
            try {
              await saving;
              await this.restoreConversation(item.path);
              await this.persist(true);
              this.historyEl.hidden = true; this.historyRevision++;
              this.inputEl.focus();
            } catch (err) { new Notice(t("chat_restoreFailed", { msg: errMsg(err) })); }
            finally { this.restoring = false; }
          };
        }
      };
      search.oninput = render;
      render(); search.focus();
    } catch (err) {
      if (revision === this.historyRevision) this.historyEl.setText(t("chat_restoreFailed", { msg: errMsg(err) }));
    }
  }

  private refreshSelectionFiles() {
    let changed = false;
    for (const [ctx, file] of this.selectionFiles) {
      if (ctx.filePath !== file.path || ctx.fileName !== file.name) {
        ctx.filePath = file.path;
        ctx.fileName = file.name;
        changed = true;
      }
    }
    if (changed) this.renderSelection();
  }
}
