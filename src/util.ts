import { App, Notice, TFile, TFolder, normalizePath } from "obsidian";
import { t } from "./i18n";

/** Parse a 1-based page range string into sorted unique 0-based indices. */
export function parsePageRange(input: string, total: number): number[] {
  const s = input.trim().toLowerCase();
  if (!s || s === "all" || s === "*") return range(0, total);
  if (s === "odd") return range(0, total).filter((i) => i % 2 === 0);
  if (s === "even") return range(0, total).filter((i) => i % 2 === 1);
  const set = new Set<number>();
  for (const partRaw of s.split(/[,\s]+/)) {
    const part = partRaw.trim();
    if (!part) continue;
    const m = part.match(/^(\d*)\s*-\s*(\d*)$/);
    if (m) {
      const a = m[1] ? parseInt(m[1], 10) : 1;
      const b = m[2] ? parseInt(m[2], 10) : total;
      if (isNaN(a) || isNaN(b) || a < 1 || b < a || a > total) throw new Error(t("invalidRange"));
      for (let i = a; i <= Math.min(b, total); i++) set.add(i - 1);
    } else if (/^\d+$/.test(part)) {
      const n = parseInt(part, 10);
      if (n < 1 || n > total) throw new Error(t("invalidRange"));
      set.add(n - 1);
    } else {
      throw new Error(t("invalidRange"));
    }
  }
  if (set.size === 0) throw new Error(t("invalidRange"));
  return [...set].sort((a, b) => a - b);
}

/** Parse a page order string (1-based, may repeat, may be descending) into 0-based indices, preserving order. */
export function parsePageOrder(input: string, total: number): number[] {
  const out: number[] = [];
  for (const part of input.trim().split(/[,\s]+/)) {
    if (!part) continue;
    const m = part.match(/^(\d*)-(\d*)$/);
    if (m) {
      const a = m[1] ? parseInt(m[1], 10) : 1;
      const b = m[2] ? parseInt(m[2], 10) : total;
      if (a < 1 || b < 1 || a > total || b > total) throw new Error(t("invalidRange"));
      if (a <= b) for (let i = a; i <= b; i++) out.push(i - 1);
      else for (let i = a; i >= b; i--) out.push(i - 1);
    } else if (/^\d+$/.test(part)) {
      const n = parseInt(part, 10);
      if (n < 1 || n > total) throw new Error(t("invalidRange"));
      out.push(n - 1);
    } else throw new Error(t("invalidRange"));
  }
  if (!out.length) throw new Error(t("invalidRange"));
  return out;
}

export function range(a: number, b: number): number[] {
  const r: number[] = [];
  for (let i = a; i < b; i++) r.push(i);
  return r;
}

export function isPdf(file: unknown): file is TFile {
  return file instanceof TFile && file.extension.toLowerCase() === "pdf";
}

export function isImage(file: unknown): file is TFile {
  return file instanceof TFile && /^(png|jpg|jpeg)$/i.test(file.extension);
}

export function folderOf(file: TFile): string {
  return file.parent ? file.parent.path : "";
}

export function joinPath(folder: string, name: string): string {
  return normalizePath(folder && folder !== "/" ? `${folder}/${name}` : name);
}

/** Return a path that does not exist yet by appending " 1", " 2", … */
export function uniquePath(app: App, folder: string, base: string, ext: string): string {
  let p = joinPath(folder, `${base}.${ext}`);
  let i = 1;
  while (app.vault.getAbstractFileByPath(p)) {
    p = joinPath(folder, `${base} ${i}.${ext}`);
    i++;
  }
  return p;
}

export async function ensureFolder(app: App, folder: string): Promise<void> {
  if (!folder || folder === "/") return;
  const norm = normalizePath(folder);
  const existing = app.vault.getAbstractFileByPath(norm);
  if (existing instanceof TFolder) return;
  if (existing) throw new Error(`Not a folder: ${norm}`);
  await app.vault.createFolder(norm);
}

export function sanitizeName(s: string): string {
  return s.replace(/[\\/:*?"<>|]/g, "_").trim() || "untitled";
}

export function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const h = hex.replace("#", "").trim();
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const n = parseInt(full, 16);
  if (isNaN(n) || full.length !== 6) return { r: 0.5, g: 0.5, b: 0.5 };
  return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 };
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

export function notice(msg: string, ms = 5000): Notice {
  return new Notice(msg, ms);
}

export function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

export function toArrayBuffer(u8: Uint8Array): ArrayBuffer {
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;
}

export function todayStr(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Points for common paper sizes (portrait). */
export const PAPER_SIZES: Record<string, [number, number]> = {
  A3: [841.89, 1190.55],
  A4: [595.28, 841.89],
  A5: [419.53, 595.28],
  B5: [498.9, 708.66],
  Letter: [612, 792],
  Legal: [612, 1008],
  Tabloid: [792, 1224],
};

export type DarkMode = "off" | "invert" | "soft" | "dim";
export const DARK_MODES: DarkMode[] = ["off", "invert", "soft", "dim"];
