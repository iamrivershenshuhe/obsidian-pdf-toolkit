// Minimal stub of the parts of "obsidian" that util.ts touches, for Node smoke tests.
export class TFile {}
export class TFolder {}
export class Notice {
  constructor(public msg: string) {}
}
export function normalizePath(p: string) {
  return p.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/|\/$/g, "");
}
export async function loadPdfJs() {
  throw new Error("pdf.js not available in Node smoke test");
}
