import type { DataAdapter } from "obsidian";
import type { RefEntry } from "../pdf/references";
import type { LlmSettings } from "./runner";
import { fetchPaperEvidence, PaperEvidence, summarizeEvidence } from "./reference-summary";
import { writeJson } from "./storage";

export interface SavedSummary { evidence: PaperEvidence | null; text: string; status: "done" | "missing" | "error" | "pending"; updated: string }
export const summaryKey = (entry: RefEntry) => (entry.doi ? `doi:${entry.doi.toLowerCase()}` : entry.arxiv ? `arxiv:${entry.arxiv.replace(/v\d+$/, "")}` : entry.text.replace(/\s+/g, " ").trim());

/** One job per reference. Closing the hover UI never cancels or re-launches it. */
export class SummaryStore {
  private records: Record<string, SavedSummary> = Object.create(null);
  private ready: Promise<void> | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private jobs = new Map<string, Promise<SavedSummary>>();
  private controllers = new Map<string, AbortController>();
  private disposed = false;
  constructor(private adapter: DataAdapter, private path: string) {}
  private init() {
    return this.ready ??= (async () => {
      if (await this.adapter.exists(this.path)) {
        const data = JSON.parse(await this.adapter.read(this.path));
        if (data.version !== 1 || !data.records || typeof data.records !== "object") throw new Error("Invalid summary cache; automatic generation paused");
        this.records = Object.assign(Object.create(null), data.records);
        for (const record of Object.values(this.records)) {
          if (!record || typeof record.text !== "string" || !["done", "missing", "error", "pending"].includes(record.status)) throw new Error("Invalid saved summary");
          if (record.status === "pending") {
            record.status = "error";
            record.text = "Previous generation was interrupted. Use Regenerate to try again.";
          }
        }
      }
    })();
  }
  async get(entry: RefEntry) { await this.init(); return this.records[summaryKey(entry)] ?? null; }
  pending(entry: RefEntry) { return this.jobs.get(summaryKey(entry)); }
  private save() {
    const snapshot = JSON.parse(JSON.stringify({ version: 1, records: this.records }));
    const job = this.queue.catch(() => {}).then(() => writeJson(this.adapter, this.path, snapshot));
    this.queue = job;
    return job;
  }
  generate(entry: RefEntry, settings: LlmSettings, cwd: string, language: string, force = false): Promise<SavedSummary> {
    const key = summaryKey(entry);
    const existing = this.jobs.get(key);
    if (existing) return existing;
    const job = (async () => {
      await this.init();
      if (this.disposed) throw new Error("Summary service closed");
      if (!force && this.records[key]) return this.records[key];
      const controller = new AbortController();
      this.controllers.set(key, controller);
      this.records[key] = { evidence: null, text: "Generation in progress", status: "pending", updated: new Date().toISOString() };
      let record: SavedSummary;
      let evidence: PaperEvidence | null = null;
      try {
        await this.save();
        if (controller.signal.aborted) throw new Error("Cancelled");
        evidence = await fetchPaperEvidence(entry);
        if (controller.signal.aborted) throw new Error("Cancelled");
        const text = evidence?.abstract ? await summarizeEvidence(evidence, settings, cwd, language, controller.signal, () => {}, force) : "";
        record = { evidence, text, status: evidence?.abstract ? "done" : "missing", updated: new Date().toISOString() };
      } catch (error) {
        record = { evidence, text: String(error), status: "error", updated: new Date().toISOString() };
      } finally { this.controllers.delete(key); }
      this.records[key] = record;
      await this.save();
      return record;
    })().finally(() => this.jobs.delete(key));
    this.jobs.set(key, job);
    return job;
  }
  stop(entry: RefEntry) { this.controllers.get(summaryKey(entry))?.abort(); }
  dispose() { this.disposed = true; for (const controller of this.controllers.values()) controller.abort(); }
}
