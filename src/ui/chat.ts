import { ItemView, MarkdownRenderer, Notice, WorkspaceLeaf, setIcon } from "obsidian";
import type PdfToolkitPlugin from "../main";
import { Keys, t } from "../i18n";
import { RunHandle, buildCommand, looksLikeNotFound, runLlm } from "../llm/runner";
import { appendAiAnswer } from "./reading";
import { errMsg } from "../util";

export const CHAT_VIEW = "pdf-toolkit-chat";

export type CtxMode = "selection" | "page" | "document";

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

export class ChatView extends ItemView {
  private messages: Msg[] = [];
  private mode: CtxMode = "page";
  private running: RunHandle | null = null;
  private logEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private targetEl!: HTMLElement;
  private modeSelect!: HTMLSelectElement;
  private sendBtn!: HTMLButtonElement;
  private stopBtn!: HTMLButtonElement;
  private renderTimer: number | null = null;

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

  async onOpen() {
    const root = this.contentEl;
    root.empty();
    root.addClass("pdftk-chat");

    const head = root.createDiv("pdftk-chat-head");
    this.targetEl = head.createDiv("pdftk-chat-target");
    const ctxRow = head.createDiv("pdftk-chat-ctx");
    ctxRow.createSpan({ text: t("chat_context") + ": " });
    this.modeSelect = ctxRow.createEl("select", { cls: "dropdown" });
    for (const m of ["selection", "page", "document"] as CtxMode[]) this.modeSelect.createEl("option", { value: m, text: t(("ctx_" + m) as Keys) });
    this.modeSelect.value = this.mode;
    this.modeSelect.onchange = () => (this.mode = this.modeSelect.value as CtxMode);

    this.quickEl = head.createDiv("pdftk-chat-quick");
    this.renderQuick();

    this.logEl = root.createDiv("pdftk-chat-log");

    const inputRow = root.createDiv("pdftk-chat-input");
    this.inputEl = inputRow.createEl("textarea", { attr: { rows: "3", placeholder: t("chat_placeholder") } });
    this.inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        void this.send(this.inputEl.value);
      }
    });
    const btns = inputRow.createDiv("pdftk-chat-btns");
    this.sendBtn = btns.createEl("button", { cls: "mod-cta" });
    setIcon(this.sendBtn, "send");
    this.sendBtn.setAttr("aria-label", t("chat_send"));
    this.sendBtn.onclick = () => void this.send(this.inputEl.value);
    this.stopBtn = btns.createEl("button");
    setIcon(this.stopBtn, "square");
    this.stopBtn.setAttr("aria-label", t("chat_stop"));
    this.stopBtn.disabled = true;
    this.stopBtn.onclick = () => this.stop();
    const clear = btns.createEl("button");
    setIcon(clear, "trash-2");
    clear.setAttr("aria-label", t("chat_clear"));
    clear.onclick = () => this.clear();

    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.refreshTarget()));
    this.registerEvent(this.app.workspace.on("file-open", () => this.refreshTarget()));
    this.refreshTarget();
  }

  async onClose() {
    this.stop();
  }

  private quickEl!: HTMLElement;
  private quickKey = "";

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
    this.targetEl.setText(tb?.file ? `📄 ${tb.file.name}   ·   ${provider === "custom" ? t("llm_custom") : cmd}` : t("chat_noPdf"));
  }

  private clear() {
    this.stop();
    this.messages = [];
    this.logEl.empty();
  }

  private stop() {
    if (this.running) {
      this.running.kill();
      this.running = null;
    }
    this.setBusy(false);
  }

  private setBusy(b: boolean) {
    this.sendBtn.disabled = b;
    this.stopBtn.disabled = !b;
    this.inputEl.disabled = b;
  }

  /* ---------------------------------------------------------------- */

  private addMessage(role: Msg["role"], content: string, question?: string): Msg {
    const el = this.logEl.createDiv(`pdftk-chat-msg is-${role}`);
    const bodyEl = el.createDiv("pdftk-chat-body");
    const msg: Msg = { role, content, question, el, bodyEl };
    this.messages.push(msg);
    this.renderMsg(msg);
    if (role === "assistant") {
      const tools = el.createDiv("pdftk-chat-tools");
      const toNote = tools.createEl("button", { text: t("chat_toNote"), cls: "pdftk-chat-chip" });
      toNote.onclick = () => void this.toNote(msg);
      const copy = tools.createEl("button", { text: t("infoCopy").replace(/ as Markdown|為 Markdown/, ""), cls: "pdftk-chat-chip" });
      copy.onclick = () => void navigator.clipboard.writeText(msg.content).then(() => new Notice(t("copied")));
    }
    this.logEl.scrollTop = this.logEl.scrollHeight;
    return msg;
  }

  private renderMsg(msg: Msg) {
    if (!msg.bodyEl) return;
    msg.bodyEl.empty();
    const tb = this.plugin.chatTarget();
    void MarkdownRenderer.render(this.app, msg.content || (msg.role === "assistant" ? `*${t("chat_running")}*` : ""), msg.bodyEl, tb?.file?.path ?? "", this);
  }

  private scheduleRender(msg: Msg) {
    if (this.renderTimer !== null) return;
    this.renderTimer = window.setTimeout(() => {
      this.renderTimer = null;
      this.renderMsg(msg);
      this.logEl.scrollTop = this.logEl.scrollHeight;
    }, 150);
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

  private buildPrompt(ctx: ChatContext, question: string): string {
    const modeLabel = ctx.mode === "selection" ? "selected passage" : ctx.mode === "page" ? `page ${ctx.page} of ${ctx.total}` : `full text (${ctx.total} pages)`;
    const history = this.messages
      .filter((m) => m.content && m.role)
      .slice(-8)
      .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
      .join("\n\n");
    return [
      "You are a research assistant helping someone read an academic paper inside Obsidian.",
      "Rules: answer in the same language as the question (Traditional Chinese if the question is in Chinese; keep technical terms in English). Be concise and concrete. Use Markdown. When you refer to the paper, cite page numbers like (p.3). If the context does not contain the answer, say so instead of guessing. Do not use tools, do not read or modify files; just answer from the context below.",
      "",
      `=== PAPER CONTEXT: "${ctx.fileName}" — ${modeLabel}${ctx.truncated ? " (truncated)" : ""} ===`,
      ctx.text || "(no text)",
      "=== END CONTEXT ===",
      "",
      history ? `Conversation so far:\n${history}\n` : "",
      `Question: ${question}`,
    ].join("\n");
  }

  async send(question: string, label?: string) {
    const q = question.trim();
    if (!q || this.running) return;
    let ctx: ChatContext | null;
    try {
      ctx = await this.plugin.getChatContext(this.mode);
    } catch (e) {
      new Notice(t("failed", { msg: errMsg(e) }));
      return;
    }
    if (!ctx) {
      new Notice(t("chat_noPdf"));
      return;
    }
    if (this.mode === "selection" && !ctx.text) {
      new Notice(t("chat_noSelection"));
      ctx = await this.plugin.getChatContext("page");
      if (!ctx) return;
    }
    this.inputEl.value = "";
    const prompt = this.buildPrompt(ctx, q);
    this.addMessage("user", label ?? q);
    const reply = this.addMessage("assistant", "", label ?? q);
    this.setBusy(true);

    const cwd = this.plugin.vaultPath();
    const attempt = async (plainText: boolean) => {
      reply.content = "";
      const handle = runLlm(this.plugin.settings, prompt, cwd, (chunk) => {
        reply.content += chunk;
        this.scheduleRender(reply);
      }, { plainText });
      this.running = handle;
      return handle.done;
    };

    try {
      let res = await attempt(false);
      const failedCleanly = res.code !== 0 && !res.text.trim();
      if (failedCleanly && this.plugin.settings.llmProvider === "claude" && !looksLikeNotFound(res.stderr, res.code) && this.running) {
        // older/newer CLI without stream-json flags → plain text mode
        res = await attempt(true);
      }
      if (!this.running) return; // stopped by user
      if (res.text.trim()) reply.content = res.text;
      if (res.code !== 0 && !res.text.trim()) {
        const cmd = buildCommand(this.plugin.settings, { plainText: true }).line.split(" ")[0];
        reply.content = looksLikeNotFound(res.stderr, res.code)
          ? `> [!error] ${t("chat_notFound", { cmd })}`
          : `> [!error] ${t("chat_failed", { code: String(res.code), err: res.stderr.trim().slice(0, 800) })}`;
      }
    } catch (e) {
      reply.content = `> [!error] ${errMsg(e)}`;
    } finally {
      this.running = null;
      this.setBusy(false);
      if (this.renderTimer !== null) {
        window.clearTimeout(this.renderTimer);
        this.renderTimer = null;
      }
      this.renderMsg(reply);
      this.logEl.scrollTop = this.logEl.scrollHeight;
      this.inputEl.focus();
    }
  }
}
