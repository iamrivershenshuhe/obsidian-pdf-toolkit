import { App, Modal, Setting, TFile, FuzzySuggestModal, Notice } from "obsidian";
import { t } from "../i18n";

/* ------------------------------------------------------------------ */
/* Generic form modal                                                   */
/* ------------------------------------------------------------------ */

export type FieldSpec =
  | { kind: "text"; key: string; label: string; desc?: string; value?: string; placeholder?: string; password?: boolean }
  | { kind: "textarea"; key: string; label: string; desc?: string; value?: string; placeholder?: string; rows?: number }
  | { kind: "number"; key: string; label: string; desc?: string; value?: number; min?: number; max?: number; step?: number }
  | { kind: "toggle"; key: string; label: string; desc?: string; value?: boolean }
  | { kind: "dropdown"; key: string; label: string; desc?: string; value?: string; options: Record<string, string> }
  | { kind: "heading"; label: string }
  | { kind: "note"; label: string };

export type FormValues = Record<string, string | number | boolean>;

/**
 * Build a modal from a list of field specs and resolve with the values on submit,
 * or null on cancel.
 */
export function formModal(
  app: App,
  title: string,
  fields: FieldSpec[],
  submitLabel = t("ok"),
): Promise<FormValues | null> {
  return new Promise((resolve) => {
    const m = new FormModal(app, title, fields, submitLabel, resolve);
    m.open();
  });
}

class FormModal extends Modal {
  private values: FormValues = {};
  private resolved = false;

  constructor(
    app: App,
    private title: string,
    private fields: FieldSpec[],
    private submitLabel: string,
    private resolve: (v: FormValues | null) => void,
  ) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass("pdf-toolkit-modal");
    contentEl.createEl("h2", { text: this.title });
    for (const f of this.fields) {
      if (f.kind === "heading") {
        new Setting(contentEl).setName(f.label).setHeading();
        continue;
      }
      if (f.kind === "note") {
        contentEl.createEl("p", { text: f.label, cls: "pdf-toolkit-note" });
        continue;
      }
      const s = new Setting(contentEl).setName(f.label);
      if (f.desc) s.setDesc(f.desc);
      switch (f.kind) {
        case "text":
          this.values[f.key] = f.value ?? "";
          s.addText((tx) => {
            tx.setValue(f.value ?? "")
              .setPlaceholder(f.placeholder ?? "")
              .onChange((v) => (this.values[f.key] = v));
            if (f.password) tx.inputEl.type = "password";
            tx.inputEl.addEventListener("keydown", (e) => {
              if (e.key === "Enter") this.submit();
            });
          });
          break;
        case "textarea":
          this.values[f.key] = f.value ?? "";
          s.addTextArea((ta) => {
            ta.setValue(f.value ?? "")
              .setPlaceholder(f.placeholder ?? "")
              .onChange((v) => (this.values[f.key] = v));
            ta.inputEl.rows = f.rows ?? 4;
            ta.inputEl.addClass("pdf-toolkit-textarea");
          });
          break;
        case "number":
          this.values[f.key] = f.value ?? 0;
          s.addText((tx) => {
            tx.inputEl.type = "number";
            if (f.min !== undefined) tx.inputEl.min = String(f.min);
            if (f.max !== undefined) tx.inputEl.max = String(f.max);
            if (f.step !== undefined) tx.inputEl.step = String(f.step);
            tx.setValue(String(f.value ?? 0)).onChange((v) => (this.values[f.key] = Number(v)));
            tx.inputEl.addEventListener("keydown", (e) => {
              if (e.key === "Enter") this.submit();
            });
          });
          break;
        case "toggle":
          this.values[f.key] = f.value ?? false;
          s.addToggle((tg) => tg.setValue(f.value ?? false).onChange((v) => (this.values[f.key] = v)));
          break;
        case "dropdown":
          this.values[f.key] = f.value ?? Object.keys(f.options)[0];
          s.addDropdown((dd) =>
            dd
              .addOptions(f.options)
              .setValue(f.value ?? Object.keys(f.options)[0])
              .onChange((v) => (this.values[f.key] = v)),
          );
          break;
      }
    }
    new Setting(contentEl)
      .addButton((b) => b.setButtonText(t("cancel")).onClick(() => this.close()))
      .addButton((b) =>
        b
          .setButtonText(this.submitLabel)
          .setCta()
          .onClick(() => this.submit()),
      );
    // focus first input
    const first = contentEl.querySelector<HTMLInputElement>("input, textarea, select");
    first?.focus();
  }

  private submit() {
    this.resolved = true;
    this.resolve({ ...this.values });
    this.close();
  }

  onClose() {
    this.contentEl.empty();
    if (!this.resolved) this.resolve(null);
  }
}

/* ------------------------------------------------------------------ */
/* Password prompt                                                      */
/* ------------------------------------------------------------------ */

export async function promptPassword(app: App, fileName: string): Promise<string | null> {
  const r = await formModal(app, fileName, [
    { kind: "note", label: t("passwordNeeded") },
    { kind: "text", key: "pw", label: t("password"), password: true },
  ]);
  return r ? String(r.pw) : null;
}

/* ------------------------------------------------------------------ */
/* Page range prompt                                                    */
/* ------------------------------------------------------------------ */

export async function promptPageRange(app: App, title: string, total: number, extra: FieldSpec[] = [], def = "all") {
  return formModal(app, title, [
    { kind: "text", key: "range", label: t("pageRange"), desc: t("pageRangeHint", { n: total }), value: def },
    ...extra,
  ]);
}

/* ------------------------------------------------------------------ */
/* Multi-file picker (ordered)                                          */
/* ------------------------------------------------------------------ */

export function pickFilesOrdered(
  app: App,
  title: string,
  hint: string,
  candidates: TFile[],
  preselected: TFile[],
  minCount: number,
  searchPlaceholder: string,
  extraFields: FieldSpec[] = [],
): Promise<{ files: TFile[]; values: FormValues } | null> {
  return new Promise((resolve) => new FilePickerModal(app, title, hint, candidates, preselected, minCount, searchPlaceholder, extraFields, resolve).open());
}

class FilePickerModal extends Modal {
  private selected: TFile[];
  private query = "";
  private listEl!: HTMLElement;
  private resultsEl!: HTMLElement;
  private values: FormValues = {};
  private resolved = false;

  constructor(
    app: App,
    private title: string,
    private hint: string,
    private candidates: TFile[],
    preselected: TFile[],
    private minCount: number,
    private searchPlaceholder: string,
    private extraFields: FieldSpec[],
    private resolve: (r: { files: TFile[]; values: FormValues } | null) => void,
  ) {
    super(app);
    this.selected = [...preselected];
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass("pdf-toolkit-modal", "pdf-toolkit-picker");
    contentEl.createEl("h2", { text: this.title });
    contentEl.createEl("p", { text: this.hint, cls: "pdf-toolkit-note" });

    const search = contentEl.createEl("input", { type: "text", placeholder: this.searchPlaceholder });
    search.addClass("pdf-toolkit-search");
    search.addEventListener("input", () => {
      this.query = search.value.toLowerCase();
      this.renderResults();
    });
    this.resultsEl = contentEl.createDiv("pdf-toolkit-results");
    this.listEl = contentEl.createDiv("pdf-toolkit-selected");

    for (const f of this.extraFields) {
      if (f.kind === "dropdown") {
        this.values[f.key] = f.value ?? Object.keys(f.options)[0];
        new Setting(contentEl).setName(f.label).addDropdown((dd) =>
          dd.addOptions(f.options).setValue(String(this.values[f.key])).onChange((v) => (this.values[f.key] = v)),
        );
      } else if (f.kind === "text") {
        this.values[f.key] = f.value ?? "";
        new Setting(contentEl).setName(f.label).addText((tx) => tx.setValue(f.value ?? "").onChange((v) => (this.values[f.key] = v)));
      } else if (f.kind === "toggle") {
        this.values[f.key] = f.value ?? false;
        new Setting(contentEl).setName(f.label).addToggle((tg) => tg.setValue(f.value ?? false).onChange((v) => (this.values[f.key] = v)));
      }
    }

    new Setting(contentEl)
      .addButton((b) => b.setButtonText(t("cancel")).onClick(() => this.close()))
      .addButton((b) =>
        b
          .setButtonText(t("ok"))
          .setCta()
          .onClick(() => {
            if (this.selected.length < this.minCount) {
              new Notice(this.minCount > 1 ? t("mergeNeedTwo") : t("imgpdfNeedOne"));
              return;
            }
            this.resolved = true;
            this.resolve({ files: [...this.selected], values: { ...this.values } });
            this.close();
          }),
      );
    this.renderResults();
    this.renderSelected();
    search.focus();
  }

  private renderResults() {
    this.resultsEl.empty();
    const q = this.query;
    const list = this.candidates
      .filter((f) => !this.selected.includes(f))
      .filter((f) => !q || f.path.toLowerCase().includes(q))
      .slice(0, 60);
    for (const f of list) {
      const row = this.resultsEl.createDiv("pdf-toolkit-row");
      row.createSpan({ text: f.path });
      row.addEventListener("click", () => {
        this.selected.push(f);
        this.renderResults();
        this.renderSelected();
      });
    }
  }

  private renderSelected() {
    this.listEl.empty();
    this.listEl.createEl("h4", { text: t("mergeSelected", { n: this.selected.length }) });
    this.selected.forEach((f, i) => {
      const row = this.listEl.createDiv("pdf-toolkit-row pdf-toolkit-row-selected");
      row.createSpan({ text: `${i + 1}. ${f.path}`, cls: "pdf-toolkit-grow" });
      const up = row.createEl("button", { text: "↑", attr: { "aria-label": t("moveUp") } });
      up.disabled = i === 0;
      up.onclick = () => {
        [this.selected[i - 1], this.selected[i]] = [this.selected[i], this.selected[i - 1]];
        this.renderSelected();
      };
      const down = row.createEl("button", { text: "↓", attr: { "aria-label": t("moveDown") } });
      down.disabled = i === this.selected.length - 1;
      down.onclick = () => {
        [this.selected[i + 1], this.selected[i]] = [this.selected[i], this.selected[i + 1]];
        this.renderSelected();
      };
      const rm = row.createEl("button", { text: "✕", attr: { "aria-label": t("remove") } });
      rm.onclick = () => {
        this.selected.splice(i, 1);
        this.renderResults();
        this.renderSelected();
      };
    });
  }

  onClose() {
    this.contentEl.empty();
    if (!this.resolved) this.resolve(null);
  }
}

/* ------------------------------------------------------------------ */
/* Single file picker (fuzzy)                                           */
/* ------------------------------------------------------------------ */

export function pickOneFile(app: App, placeholder: string, candidates: TFile[]): Promise<TFile | null> {
  return new Promise((resolve) => {
    let done = false;
    const m = new (class extends FuzzySuggestModal<TFile> {
      getItems() {
        return candidates;
      }
      getItemText(f: TFile) {
        return f.path;
      }
      onChooseItem(f: TFile) {
        done = true;
        resolve(f);
      }
      onClose() {
        super.onClose();
        setTimeout(() => {
          if (!done) resolve(null);
        }, 50);
      }
    })(app);
    m.setPlaceholder(placeholder);
    m.open();
  });
}

/* ------------------------------------------------------------------ */
/* Info display                                                         */
/* ------------------------------------------------------------------ */

export function showInfoModal(app: App, title: string, rows: [string, string][]) {
  const m = new (class extends Modal {
    onOpen() {
      const { contentEl } = this;
      contentEl.addClass("pdf-toolkit-modal");
      contentEl.createEl("h2", { text: title });
      const table = contentEl.createEl("table", { cls: "pdf-toolkit-info" });
      for (const [k, v] of rows) {
        const tr = table.createEl("tr");
        tr.createEl("th", { text: k });
        tr.createEl("td", { text: v });
      }
      new Setting(contentEl)
        .addButton((b) =>
          b.setButtonText(t("infoCopy")).onClick(async () => {
            const md = [`# ${title}`, "", "| | |", "|---|---|", ...rows.map(([k, v]) => `| ${k} | ${v.replace(/\|/g, "\\|")} |`)].join("\n");
            await navigator.clipboard.writeText(md);
            new Notice(t("copied"));
          }),
        )
        .addButton((b) => b.setButtonText(t("close")).setCta().onClick(() => this.close()));
    }
    onClose() {
      this.contentEl.empty();
    }
  })(app);
  m.open();
}
