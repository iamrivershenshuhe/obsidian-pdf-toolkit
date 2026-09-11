import { deflateSync, inflateSync } from "zlib";
import { createHash } from "crypto";

const hash = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
interface Edit { before: Uint8Array; after: Uint8Array; beforeHash: string; afterHash: string }
/** Session-only compressed PDF snapshots. Commit stack changes only after successful writes. */
export class EditHistory {
  busy = false;
  private undo: Edit[] = [];
  private redo: Edit[] = [];
  get canUndo() { return !!this.undo.length; }
  get canRedo() { return !!this.redo.length; }
  clear() { this.undo = []; this.redo = []; }
  record(before: Uint8Array, after: Uint8Array) {
    const beforeHash = hash(before), afterHash = hash(after);
    if (beforeHash === afterHash) return;
    if (this.undo.length && this.undo[this.undo.length - 1].afterHash !== beforeHash) this.clear();
    this.redo = [];
    this.undo.push({ before: deflateSync(before), after: deflateSync(after), beforeHash, afterHash });
    let size = this.undo.reduce((n, e) => n + e.before.length + e.after.length, 0);
    while (this.undo.length > 1 && (this.undo.length > 20 || size > 32 * 1024 * 1024)) {
      const removed = this.undo.shift()!; size -= removed.before.length + removed.after.length;
    }
  }
  async apply(direction: "undo" | "redo", current: Uint8Array, write: (bytes: Uint8Array) => Promise<void>) {
    const from = direction === "undo" ? this.undo : this.redo;
    const to = direction === "undo" ? this.redo : this.undo;
    const entry = from[from.length - 1];
    if (!entry) return false;
    if (hash(current) !== (direction === "undo" ? entry.afterHash : entry.beforeHash)) {
      this.clear();
      throw new Error("PDF changed outside this edit history; undo was stopped to preserve those changes.");
    }
    await write(inflateSync(direction === "undo" ? entry.before : entry.after));
    from.pop(); to.push(entry);
    return true;
  }
}
const histories = new WeakMap<object, WeakMap<object, EditHistory>>();
export function historyFor(owner: object, file: object): EditHistory {
  let files = histories.get(owner);
  if (!files) { files = new WeakMap(); histories.set(owner, files); }
  let history = files.get(file);
  if (!history) { history = new EditHistory(); files.set(file, history); }
  return history;
}
export function sameBytes(a: Uint8Array, b: Uint8Array) { return hash(a) === hash(b); }
