import { ItemView, MarkdownRenderer, Notice, WorkspaceLeaf, setIcon } from "obsidian";
import type PdfToolkitPlugin from "../main";
import { Keys, t } from "../i18n";
import { RunHandle, SlashCommand, buildCommand, listSlashCommands, looksLikeNotFound, runLlm } from "../llm/runner";
import { appendAiAnswer } from "./reading";
import { errMsg } from "../util";

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
    this.targetEl = row1.createDiv("pdftk-chat-target");
    const newBtn = row1.createEl("button", { cls: "clickable-icon pdftk-chat-icon" });
    setIcon(newBtn, "plus");
    newBtn.setAttr("aria-label", t("chat_new"));
    newBtn.setAttr("title", t("chat_new"));
    newBtn.onclick = () => this.newChat();

    const ctxRow = head.createDiv("pdftk-chat-ctx");
    ctxRow.createSpan({ text: t("chat_context") + ": " });
    this.modeSelect = ctxRow.createEl("select", { cls: "dropdown" });
    for (const m of ["selection", "page", "document", "reference"] as CtxMode[]) this.modeSelect.createEl("option", { value: m, text: t(("ctx_" + m) as Keys) });
    this.modeSelect.value = this.mode;
    this.modeSelect.onchange = () => (this.mode = this.modeSelect.value as CtxMode);

    this.quickEl = head.createDiv("pdftk-chat-quick");
    this.renderQuick();

    this.logEl = root.createDiv("pdftk-chat-log");

    const inputWrap = root.createDiv("pdftk-chat-inputwrap");
    this.slashEl = inputWrap.createDiv("pdftk-chat-slash");
    this.slashEl.hide();
    const inputRow = inputWrap.createDiv("pdftk-chat-input");
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
    this.inputEl.addEventListener("input", () => this.updateSlash());
    this.sendBtn = inputRow.createEl("button", { cls: "mod-cta pdftk-chat-send" });
    this.setSendState(false);
    this.sendBtn.onclick = () => {
      if (this.running) this.stop();
      else void this.send(this.inputEl.value);
    };

    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.refreshTarget()));
    this.registerEvent(this.app.workspace.on("file-open", () => this.refreshTarget()));
    this.refreshTarget();
  }

  async onClose() {
    this.stop();
  }

  private setSendState(running: boolean) {
    this.sendBtn.empty();
    setIcon(this.sendBtn, running ? "square" : "send");
    this.sendBtn.setAttr("aria-label", running ? t("chat_stop") : t("chat_send"));
    this.sendBtn.toggleClass("is-running", running);
  }

  /** Built-in + user-defined prompt buttons (re-rendered when settings change). */
  private renderQuick() {
    const s = this.plugin.settings;
    const list: { label: string; mode: CtxMode; prompt: string }[] = [];
    if (!s.hideBuiltinPrompts) for (const q of QUICK) list.push({ label: t(q.key), mode: q.mode, prompt: q.prompt });
    for (const p of s.customPrompts) if (p.name.trim() && p.prompt.trim()) list.push({ label: p.name.trim(), mode: p.mode, prompt: p.prompt });
    const key = JSON.stringify(list);
    if (key === this.quickKey) return;
    this.quickKey = key;
    this.quickEl.empty();
    for (const q of list) {
      const b = this.quickEl.createEl("button", { text: q.label, cls: "pdftk-chat-chip" });
      b.setAttr("title", q.prompt);
      b.onclick = () => {
        this.mode = q.mode;
        this.modeSelect.value = q.mode;
        void this.send(q.prompt, q.label);
      };
    }
  }

  private refreshTarget() {
    this.renderQuick();
    const tb = this.plugin.chatTarget();
    const provider = this.plugin.settings.llmProvider;
    const cmd = buildCommand(this.plugin.settings, { plainText: true }).line.split(" ")[0];
    const who = provider === "custom" ? t("llm_custom") : cmd;
    this.targetEl.setText(tb?.file ? `📄 ${tb.file.name}   ·   ${who}${this.sessionId ? " ⟳" : ""}` : t("chat_noPdf"));
  }

  private newChat() {
    this.stop();
    this.messages = [];
    this.logEl.empty();
    this.sessionId = null;
    this.refCtx = null;
    if (this.mode === "reference") {
      this.mode = "page";
      this.modeSelect.value = "page";
    }
    this.refreshTarget();
    this.inputEl.focus();
  }

  private stop() {
    if (this.running) {
      this.running.kill();
      this.running = null;
    }
    this.setSendState(false);
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
    const el = this.logEl.createDiv(`pdftk-chat-msg is-${role}`);
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
    void MarkdownRenderer.render(this.app, msg.content, msg.bodyEl, tb?.file?.path ?? "", this).then(() => {
      this.logEl.scrollTop = this.logEl.scrollHeight;
    });
  }

  private async toNote(msg: Msg) {
    const tb = this.plugin.chatTarget();
    if (!tb?.file) {
      new Notice(t("chat_noPdf"));
      return;
    }
    try {
      await appendAiAnswer(this.plugin, tb.file, msg.question ?? "", msg.content);
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
    const q = (question ?? this.plugin.settings.refQuestion).trim() || t("ref_defaultQuestion");
    void this.send(q, `${label}: ${q}`);
  }

  private async buildContext(): Promise<ChatContext | null> {
    if (this.mode === "reference") {
      if (!this.refCtx) {
        new Notice(t("chat_noRef"));
        return null;
      }
      const tb = this.plugin.chatTarget();
      return {
        fileName: tb?.file?.name ?? "",
        filePath: tb?.file?.path ?? "",
        page: tb?.currentPage() ?? 1,
        total: tb?.pageCount() ?? 0,
        mode: "reference",
        text: `Reference entry (${this.refCtx.label}):\n${this.refCtx.text}`,
        truncated: false,
      };
    }
    let ctx = await this.plugin.getChatContext(this.mode);
    if (!ctx) {
      new Notice(t("chat_noPdf"));
      return null;
    }
    if (this.mode === "selection" && !ctx.text) {
      new Notice(t("chat_noSelection"));
      ctx = await this.plugin.getChatContext("page");
    }
    return ctx;
  }

  private buildPrompt(ctx: ChatContext, question: string, includeHistory: boolean): string {
    const modeLabel =
      ctx.mode === "selection"
        ? "selected passage"
        : ctx.mode === "page"
          ? `page ${ctx.page} of ${ctx.total}`
          : ctx.mode === "reference"
            ? "one entry of the reference list, cited in the paper being read"
            : `full text (${ctx.total} pages)`;
    const contextBlock = [`=== PAPER CONTEXT: "${ctx.fileName}" — ${modeLabel}${ctx.truncated ? " (truncated)" : ""} ===`, ctx.text || "(no text)", "=== END CONTEXT ==="].join("\n");
    const history = includeHistory
      ? this.messages
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
    const q = question.trim();
    if (!q || this.running) return;
    this.slashEl.hide();
    const ctx = await this.buildContext();
    if (!ctx) return;
    this.inputEl.value = "";
    const isClaude = this.plugin.settings.llmProvider === "claude";
    let resume = isClaude && this.sessionId ? this.sessionId : undefined;

    this.addMessage("user", label ?? q, q);
    const reply = this.addMessage("assistant", "", label ?? q);
    this.setSendState(true);
    const cwd = this.plugin.vaultPath();

    const attempt = (plainText: boolean, resumeId: string | undefined, history: boolean) => {
      reply.content = "";
      const prompt = this.buildPrompt(ctx, q, history);
      const handle = runLlm(
        this.plugin.settings,
        prompt,
        cwd,
        (chunk) => {
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
      let failed = res.code !== 0 && !res.text.trim();
      if (failed && resume && this.running) {
        // the session may have expired: start a fresh one with the history inlined
        resume = undefined;
        this.sessionId = null;
        res = await attempt(false, undefined, true);
        failed = res.code !== 0 && !res.text.trim();
      }
      if (failed && isClaude && !looksLikeNotFound(res.stderr, res.code) && this.running) {
        // CLI without stream-json flags → plain text mode
        res = await attempt(true, undefined, true);
        failed = res.code !== 0 && !res.text.trim();
      }
      if (!this.running) return; // stopped by the user
      if (res.sessionId) this.sessionId = res.sessionId;
      if (res.text.trim()) reply.content = res.text;
      if (failed) {
        const cmd = buildCommand(this.plugin.settings, { plainText: true }).line.split(" ")[0];
        reply.content = looksLikeNotFound(res.stderr, res.code)
          ? `> [!error] ${t("chat_notFound", { cmd })}`
          : `> [!error] ${t("chat_failed", { code: String(res.code), err: res.stderr.trim().slice(0, 800) })}`;
      }
    } catch (e) {
      reply.content = `> [!error] ${errMsg(e)}`;
    } finally {
      this.running = null;
      this.setSendState(false);
      this.renderMarkdown(reply);
      this.refreshTarget();
      this.inputEl.focus();
    }
  }
}
