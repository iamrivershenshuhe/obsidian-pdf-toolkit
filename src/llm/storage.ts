import type { DataAdapter } from "obsidian";
import type { ChatContext, CtxMode } from "../ui/chat";
import type { LlmProvider } from "./runner";

export interface SavedMessage {
  role: "user" | "assistant";
  content: string;
  question?: string;
  sourcePath?: string;
  sourcesText?: string;
}
export interface SavedChat {
  version: 1;
  id: string;
  path: string;
  title: string;
  updated: string;
  messages: SavedMessage[];
  selections: ChatContext[];
  mode: CtxMode;
  draft: string;
  pendingShortcuts?: { label: string; prompt: string; mode: CtxMode }[];
  provider: LlmProvider;
  model: string;
  effort: string;
  reference?: { text: string; label: string } | null;
}
export interface HistoryEntry { path: string; title: string; updated: string }

export function safeVaultPath(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  if (!normalized || normalized.startsWith("/") || normalized.split("/").some((part) => part === ".." || part === "." || !part || part.includes(":"))) throw new Error("Use a relative folder inside the vault");
  return normalized;
}

export async function writeJson(adapter: DataAdapter, path: string, data: unknown) {
  path = safeVaultPath(path);
  const parts = path.split("/").slice(0, -1);
  for (let i = 1; i <= parts.length; i++) {
    const folder = parts.slice(0, i).join("/");
    if (!await adapter.exists(folder)) await adapter.mkdir(folder);
  }
  await adapter.write(path, JSON.stringify(data, null, 2));
}

export function chatMarkdown(chat: SavedChat): string {
  const sections = [`# ${chat.title.replace(/[\r\n]/g, " ")}`, `<!-- PDF Toolkit conversation · ${chat.id} · generated from the companion JSON -->`, `Updated: ${chat.updated}`, `Provider: ${chat.provider} · Model: ${chat.model || "default"} · Effort: ${chat.effort || "default"}`];
  for (const msg of chat.messages) {
    sections.push(`## ${msg.role === "user" ? "You" : "AI"}\n\n${msg.content}`);
    if (msg.sourcesText) sections.push(`### Sources\n\n${msg.sourcesText.split("\n").map((line) => `> ${line}`).join("\n")}`);
  }
  if (chat.draft.trim()) sections.push(`## Draft\n\n${chat.draft}`);
  return sections.join("\n\n") + "\n";
}

export class ChatHistoryStore {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private adapter: DataAdapter, private indexPath: string) {}
  async index(): Promise<{ last: string; entries: HistoryEntry[] }> {
    if (!await this.adapter.exists(this.indexPath)) return { last: "", entries: [] };
    const data = JSON.parse(await this.adapter.read(this.indexPath));
    if (!Array.isArray(data.entries) || typeof data.last !== "string") throw new Error("Invalid conversation index");
    return data;
  }
  async load(path: string): Promise<SavedChat> {
    if (!path.endsWith(".chat.json")) throw new Error("Invalid conversation file extension");
    const data = JSON.parse(await this.adapter.read(safeVaultPath(path)));
    if (data.version !== 1 || !Array.isArray(data.messages) || !Array.isArray(data.selections) || typeof data.id !== "string" || typeof data.draft !== "string") throw new Error("Invalid saved conversation");
    if (!["selection", "page", "document", "reference"].includes(data.mode) || !data.messages.every((m: SavedMessage) => m && ["user", "assistant"].includes(m.role) && typeof m.content === "string") || !data.selections.every((c: ChatContext) => c && typeof c.text === "string" && typeof c.filePath === "string" && typeof c.fileName === "string" && Number.isFinite(c.page))) throw new Error("Invalid conversation contents");
    return { ...data, path };
  }
  save(chat: SavedChat): Promise<void> {
    if (!chat.path.endsWith(".chat.json")) return Promise.reject(new Error("Invalid conversation file extension"));
    const snapshot = JSON.parse(JSON.stringify(chat)) as SavedChat;
    const job = this.queue.catch(() => {}).then(async () => {
      const index = await this.index();
      await writeJson(this.adapter, snapshot.path, snapshot);
      await this.adapter.write(snapshot.path.replace(/\.chat\.json$/, ".md"), chatMarkdown(snapshot));
      index.entries = [{ path: snapshot.path, title: snapshot.title, updated: snapshot.updated }, ...index.entries.filter((entry) => entry.path !== snapshot.path)];
      index.last = snapshot.path;
      await writeJson(this.adapter, this.indexPath, index);
    });
    this.queue = job;
    return job;
  }
  async flush() { await this.queue; }
}
