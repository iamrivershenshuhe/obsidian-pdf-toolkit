import { FileView, FuzzySuggestModal, Notice, TFile, normalizePath } from "obsidian";
import type PdfToolkitPlugin from "../main";
import { extractText } from "../pdf/pdfjs";
import { getMetadata } from "../pdf/ops";
import { t } from "../i18n";
import { ensureFolder, folderOf, joinPath } from "../util";

/*
 * Paper-reading helpers: a companion Markdown note per PDF built around the
 * three-pass method (Keshav / Andrew Ng), plus "quote selection to note".
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

export interface QuoteInfo {
  text: string;
  page: number;
  link: string;
}

const HIGHLIGHT_MARKER = "<!-- pdf-toolkit:highlights -->";

const COLOR_EMOJI: Record<string, string> = {
  "#ffe11a": "🟡",
  "#7ee787": "🟢",
  "#79c0ff": "🔵",
  "#ff7eb6": "🩷",
  "#ffa657": "🟠",
  "#f85149": "🔴",
  "#1f6feb": "🔵",
  "#111111": "⚫",
};

export function readingNotePath(plugin: PdfToolkitPlugin, file: TFile): string {
  const folder = plugin.settings.readingFolder ? normalizePath(plugin.settings.readingFolder) : folderOf(file);
  return joinPath(folder, `${file.basename}.reading.md`);
}

export function getReadingNote(plugin: PdfToolkitPlugin, file: TFile): TFile | null {
  const f = plugin.app.vault.getAbstractFileByPath(readingNotePath(plugin, file));
  return f instanceof TFile ? f : null;
}

/** Build a markdown link to a page (and, when possible, the exact selected text) using Obsidian's own helpers. */
export function selectionLink(view: FileView, file: TFile, page: number, pageDiv: HTMLElement | null): string {
  const child = (view as Any).viewer?.child;
  try {
    if (child && typeof child.getMarkdownLink === "function") {
      let sub = `#page=${page}`;
      if (pageDiv && typeof child.getTextSelectionRangeStr === "function") {
        const s = child.getTextSelectionRangeStr(pageDiv);
        if (s) sub += `&selection=${s}`;
      }
      return child.getMarkdownLink(sub, `p.${page}`);
    }
  } catch {
    /* fall through */
  }
  return `[[${file.path}#page=${page}|p.${page}]]`;
}

/* ------------------------------------------------------------------ */
/* Template                                                             */
/* ------------------------------------------------------------------ */

function extractAbstract(pages: string[]): string {
  const text = pages.slice(0, 2).join("\n");
  const m = text.match(/\babstract\b[\s.:—-]*/i);
  if (!m || m.index === undefined) return "";
  let body = text.slice(m.index + m[0].length);
  const end = body.search(/\n\s*(?:(?:1|I)[.\s]+)?(?:introduction|keywords?|index terms|ccs concepts)\b/i);
  if (end > 0) body = body.slice(0, end);
  body = body.replace(/-\n(?=[a-z])/g, "").replace(/\s*\n\s*/g, " ").trim();
  if (body.length > 2500) body = body.slice(0, 2500) + "…";
  return body;
}

function extractCaptions(pages: string[]): { page: number; label: string; text: string }[] {
  const out: { page: number; label: string; text: string }[] = [];
  const seen = new Set<string>();
  const re = /^\s*((?:Fig\.?|Figure|Table|TABLE|FIGURE|圖|表)\s*\.?\s*(\d+))\s*[.:：\-—]?\s*(.{4,})$/;
  pages.forEach((txt, i) => {
    for (const line of txt.split("\n")) {
      const m = line.match(re);
      if (!m) continue;
      const label = m[1].replace(/\s+/g, " ").replace(/^Fig\.?/i, "Figure").replace(/^TABLE/, "Table").replace(/^FIGURE/, "Figure");
      const key = label.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      let caption = m[3].trim();
      if (caption.length > 160) caption = caption.slice(0, 160) + "…";
      out.push({ page: i + 1, label, text: caption });
    }
  });
  return out;
}

function checklist(items: string): string {
  return items
    .split("|")
    .map((s) => `- [ ] ${s.trim()}`)
    .join("\n");
}

function numbered(items: string): string {
  return items
    .split("|")
    .map((s, i) => `${i + 1}. ${s.trim()}\n   - `)
    .join("\n");
}

function yaml(s: string): string {
  return `"${s.replace(/"/g, '\\"')}"`;
}

export interface TemplateVars extends Record<string, string> {
  title: string;
  authors: string;
  keywords: string;
  subject: string;
  pages: string;
  source: string;
  file: string;
  path: string;
  date: string;
  abstract: string;
  figures: string;
  highlights: string;
  three_pass: string;
  ng_questions: string;
}

/** Everything a template can reference. Extracts text/abstract/captions from the PDF. */
export async function collectTemplateVars(plugin: PdfToolkitPlugin, file: TFile): Promise<TemplateVars> {
  const L = await plugin.loadPdf(file);
  const meta = L ? getMetadata(L.doc) : { title: "", author: "", subject: "", keywords: "", creator: "", producer: "" };
  const pageCount = L ? L.doc.getPageCount() : 0;
  let pages: string[] = [];
  if (L) {
    try {
      pages = await extractText(L.bytes, L.password);
    } catch {
      /* scanned or broken text layer */
    }
  }
  const clean = (s: string) => s.replace(/"/g, "”").replace(/\s+/g, " ").trim();
  const title = clean(meta.title || file.basename);
  const captions = extractCaptions(pages);
  const link = (p: number) => `[[${file.path}#page=${p}|p.${p}]]`;
  const figures = captions.length ? captions.map((c) => `- ${link(c.page)} **${c.label}** — ${c.text}`).join("\n") : `- ${t("rn_none")}`;
  const threePass = [
    `## ${t("rn_pass1")}`,
    checklist(t("rn_pass1_items")),
    "",
    `## ${t("rn_pass2")}`,
    checklist(t("rn_pass2_items")),
    "",
    `## ${t("rn_pass3")}`,
    checklist(t("rn_pass3_items")),
  ].join("\n");
  const ng = [`## ${t("rn_questions")}`, numbered(t("rn_q_items"))].join("\n");
  return {
    title,
    authors: clean(meta.author),
    keywords: clean(meta.keywords),
    subject: clean(meta.subject),
    pages: String(pageCount),
    source: `[[${file.path}]]`,
    file: file.basename,
    path: file.path,
    date: new Date().toISOString().slice(0, 10),
    abstract: extractAbstract(pages) || t("rn_none"),
    figures,
    highlights: HIGHLIGHT_MARKER,
    three_pass: threePass,
    ng_questions: ng,
  };
}

/** The built-in three-pass / Andrew Ng template, with {{placeholders}}. */
export function builtinTemplate(): string {
  return [
    "---",
    `source: "{{source}}"`,
    `title: "{{title}}"`,
    `authors: "{{authors}}"`,
    `keywords: "{{keywords}}"`,
    "pages: {{pages}}",
    "year: ",
    "venue: ",
    "status: pass-1",
    "rating: ",
    "created: {{date}}",
    "tags:",
    "  - paper",
    "---",
    "",
    "# {{title}}",
    "",
    `> [!abstract] ${t("rn_abstract")}`,
    "> {{abstract}}",
    "",
    "{{three_pass}}",
    "",
    "{{ng_questions}}",
    "",
    `## ${t("rn_figures")}`,
    "{{figures}}",
    "",
    `## ${t("rn_highlights")}`,
    "{{highlights}}",
    "",
    `## ${t("rn_refs")}`,
    "- [ ] ",
    "",
    `## ${t("rn_summary")}`,
    "",
    "",
  ].join("\n");
}

/** Replace {{name}} placeholders (case-insensitive, spaces allowed). Unknown names are left as-is. */
export function renderTemplate(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\{\{\s*([a-zA-Z_][\w]*)\s*\}\}/g, (m, name: string) => {
    const key = name.toLowerCase();
    return key in vars ? vars[key] : m;
  });
}

export function listTemplates(plugin: PdfToolkitPlugin): TFile[] {
  const folder = plugin.settings.templatesFolder.trim();
  if (!folder) return [];
  const norm = normalizePath(folder);
  return plugin.app.vault
    .getMarkdownFiles()
    .filter((f) => f.path.startsWith(norm + "/"))
    .sort((a, b) => a.basename.localeCompare(b.basename));
}

export type TemplateChoice = "builtin" | TFile;

interface TemplateItem {
  label: string;
  value: TemplateChoice;
}

/** Ask the user which template to use. Resolves null when cancelled. */
export function pickTemplate(plugin: PdfToolkitPlugin): Promise<TemplateChoice | null> {
  const files = listTemplates(plugin);
  const items: TemplateItem[] = [{ label: t("tpl_builtin"), value: "builtin" }, ...files.map((f) => ({ label: f.basename, value: f as TemplateChoice }))];
  return new Promise((resolve) => {
    let done = false;
    const m = new (class extends FuzzySuggestModal<TemplateItem> {
      getItems() {
        return items;
      }
      getItemText(i: TemplateItem) {
        return i.label;
      }
      onChooseItem(i: TemplateItem) {
        done = true;
        resolve(i.value);
      }
      onClose() {
        super.onClose();
        window.setTimeout(() => {
          if (!done) resolve(null);
        }, 50);
      }
    })(plugin.app);
    m.setPlaceholder(t("tpl_choose"));
    m.open();
  });
}

/** Resolve the configured default template ("ask" prompts the user). */
async function resolveTemplate(plugin: PdfToolkitPlugin, choice?: TemplateChoice | "ask"): Promise<TemplateChoice | null> {
  const pref = choice ?? plugin.settings.defaultTemplate;
  if (pref === "ask") return pickTemplate(plugin);
  if (pref === "builtin" || !pref) return "builtin";
  if (pref instanceof TFile) return pref;
  const f = plugin.app.vault.getAbstractFileByPath(normalizePath(pref));
  return f instanceof TFile ? f : "builtin";
}

/** Write the built-in template into the templates folder so it can be customised. */
export async function exportBuiltinTemplate(plugin: PdfToolkitPlugin): Promise<TFile> {
  const folder = plugin.settings.templatesFolder.trim() || "Templates";
  await ensureFolder(plugin.app, folder);
  if (!plugin.settings.templatesFolder.trim()) {
    plugin.settings.templatesFolder = folder;
    await plugin.saveSettings();
  }
  let p = joinPath(folder, "PDF reading template.md");
  let i = 1;
  while (plugin.app.vault.getAbstractFileByPath(p)) p = joinPath(folder, `PDF reading template ${i++}.md`);
  const note = await plugin.app.vault.create(p, builtinTemplate());
  new Notice(t("tpl_exported", { name: note.path }));
  return note;
}

/* ------------------------------------------------------------------ */
/* Public actions                                                       */
/* ------------------------------------------------------------------ */

export async function ensureReadingNote(plugin: PdfToolkitPlugin, file: TFile, choice?: TemplateChoice | "ask"): Promise<TFile | null> {
  const existing = getReadingNote(plugin, file);
  if (existing) return existing;
  const tpl = await resolveTemplate(plugin, choice);
  if (!tpl) return null;
  const path = readingNotePath(plugin, file);
  await ensureFolder(plugin.app, path.slice(0, path.lastIndexOf("/") > 0 ? path.lastIndexOf("/") : 0));
  const n = new Notice(t("working"), 0);
  try {
    const vars = await collectTemplateVars(plugin, file);
    const source = tpl === "builtin" ? builtinTemplate() : await plugin.app.vault.read(tpl);
    const note = await plugin.app.vault.create(path, renderTemplate(source, vars));
    new Notice(t("rn_created", { name: note.name }));
    return note;
  } finally {
    n.hide();
  }
}

export async function openReadingNote(plugin: PdfToolkitPlugin, file: TFile, choice?: TemplateChoice | "ask"): Promise<void> {
  const note = await ensureReadingNote(plugin, file, choice);
  if (!note) return;
  // Reuse a leaf that already shows the note, otherwise open it beside the PDF.
  let target = null as Any;
  plugin.app.workspace.iterateAllLeaves((leaf) => {
    if (!target && leaf.view instanceof FileView && leaf.view.file === note) target = leaf;
  });
  if (target) {
    plugin.app.workspace.setActiveLeaf(target, { focus: true });
    return;
  }
  const leaf = plugin.app.workspace.getLeaf("split", "vertical");
  await leaf.openFile(note);
}

/** Append a reference entry as a to-do under the "References to follow" heading. */
export async function appendReference(plugin: PdfToolkitPlugin, file: TFile, entry: { num?: number; text: string; doi?: string; arxiv?: string }, scholar: string): Promise<void> {
  const note = await ensureReadingNote(plugin, file);
  if (!note) return;
  const label = entry.num !== undefined ? `[${entry.num}] ` : "";
  const extra = entry.doi ? ` · [DOI](https://doi.org/${entry.doi})` : entry.arxiv ? ` · [arXiv](https://arxiv.org/abs/${entry.arxiv})` : "";
  const line = `- [ ] ${label}${entry.text} — [Scholar](${scholar})${extra}`;
  await plugin.app.vault.process(note, (data) => {
    if (data.includes(entry.text)) return data;
    const heading = `\n## ${t("rn_refs")}`;
    const idx = data.indexOf(heading);
    if (idx < 0) return data.replace(/\s*$/, "") + `\n\n## ${t("rn_refs")}\n${line}\n`;
    const after = idx + heading.length;
    const rest = data.slice(after);
    const next = rest.search(/\n## /);
    const insertAt = next < 0 ? data.length : after + next;
    let section = data.slice(after, insertAt).replace(/\n- \[ \]\s*(?=\n|$)/g, ""); // drop the empty placeholder
    section = section.replace(/\s*$/, "") + `\n${line}\n`;
    return data.slice(0, after) + section + data.slice(insertAt).replace(/^\n+/, "\n");
  });
  new Notice(t("ref_added", { name: note.basename }));
}

/** Append an AI answer (question + answer) to the reading note's highlights section. */
export async function appendAiAnswer(plugin: PdfToolkitPlugin, file: TFile, question: string, answer: string): Promise<void> {
  const note = await ensureReadingNote(plugin, file);
  if (!note) return;
  const body = answer
    .trim()
    .split("\n")
    .map((l) => `> ${l}`)
    .join("\n");
  const block = [`> [!note] 🤖 ${question.trim().replace(/\s+/g, " ").slice(0, 200)}`, body, ""].join("\n");
  await plugin.app.vault.process(note, (data) => insertInHighlights(data, block));
  new Notice(t("chat_added", { name: note.basename }));
}

function insertInHighlights(data: string, block: string): string {
  const idx = data.indexOf(HIGHLIGHT_MARKER);
  if (idx < 0) return data.replace(/\s*$/, "") + `\n\n## ${t("rn_highlights")}\n${HIGHLIGHT_MARKER}\n\n${block}\n`;
  const after = idx + HIGHLIGHT_MARKER.length;
  const rest = data.slice(after);
  const next = rest.search(/\n## /);
  const insertAt = next < 0 ? data.length : after + next;
  const before = data.slice(0, insertAt).replace(/\s*$/, "");
  return `${before}\n\n${block}\n${data.slice(insertAt).replace(/^\n+/, "\n")}`;
}

export async function appendQuote(plugin: PdfToolkitPlugin, file: TFile, q: QuoteInfo, comment?: string, colorHex?: string): Promise<void> {
  const note = await ensureReadingNote(plugin, file);
  if (!note) return;
  const emoji = colorHex ? COLOR_EMOJI[colorHex.toLowerCase()] ?? "" : "";
  const quoted = q.text
    .split("\n")
    .map((l) => `> ${l}`)
    .join("\n");
  const block = [`> [!quote] ${emoji ? emoji + " " : ""}${q.link}`, quoted, ...(comment?.trim() ? [">", `> 💬 ${comment.trim()}`] : []), ""].join("\n");
  await plugin.app.vault.process(note, (data) => insertInHighlights(data, block));
  new Notice(t("quote_added", { name: note.basename }));
}
