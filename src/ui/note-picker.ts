import { App, FuzzySuggestModal, Notice, TFile } from "obsidian";
import { t } from "../i18n";
import type { QuoteInfo } from "./reading";

export function pickNote(app: App): Promise<TFile | null> {
  return new Promise((resolve) => {
    let chosen = false;
    const modal = new class extends FuzzySuggestModal<TFile> {
      getItems() { return app.vault.getMarkdownFiles().sort((a, b) => b.stat.mtime - a.stat.mtime); }
      getItemText(file: TFile) { return file.path; }
      onChooseItem(file: TFile) { chosen = true; resolve(file); }
      onClose() { super.onClose(); window.setTimeout(() => { if (!chosen) resolve(null); }, 0); }
    }(app);
    modal.setPlaceholder(t("note_choose"));
    modal.open();
  });
}

export function quoteBlock(link: string, text: string): string {
  return `> [!quote] ${link}\n${text.trim().split(/\r?\n/).map((line) => `> ${line}`).join("\n")}\n`;
}

export async function quoteToChosenNote(app: App, source: TFile, quote: QuoteInfo) {
  const note = await pickNote(app);
  if (!note) return;
  // Generate relative links for the selected destination, not the currently open PDF view.
  const selection = quote.link.match(/&selection=([^\]|)\s]+)/)?.[1];
  const subpath = `#page=${quote.page}${selection ? `&selection=${selection}` : ""}`;
  const link = app.fileManager.generateMarkdownLink(source, note.path, subpath, `${source.basename} · p.${quote.page}`);
  await app.vault.process(note, (data) => data.trimEnd() + "\n\n" + quoteBlock(link, quote.text));
  new Notice(t("quote_added", { name: note.path }));
}
