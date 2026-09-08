// Node smoke test for src/pdf/annotations.ts
import * as fs from "fs";
import * as ann from "../src/pdf/annotations";
import * as ops from "../src/pdf/ops";
import { PDFDocument, StandardFonts } from "@cantoo/pdf-lib";

const fonts: ops.FontProvider = {
  customFontBytes: async () => {
    const p = "C:\\Windows\\Fonts\\msjh.ttc";
    return fs.existsSync(p) ? new Uint8Array(fs.readFileSync(p)) : null;
  },
};

let failures = 0;
async function check(name: string, fn: () => Promise<unknown>) {
  try {
    const r = await fn();
    console.log(`ok   ${name}${r !== undefined ? " -> " + String(r) : ""}`);
  } catch (e) {
    failures++;
    console.log(`FAIL ${name}: ${(e as Error).stack ?? e}`);
  }
}

(async () => {
  const base = await PDFDocument.create();
  const font = await base.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= 2; i++) {
    const p = base.addPage([595.28, 841.89]);
    p.drawText(`Annotation sample page ${i}`, { x: 60, y: 760, size: 24, font });
    p.drawText("The quick brown fox jumps over the lazy dog.", { x: 60, y: 700, size: 14, font });
  }
  const sample = await base.save();

  const doc = await ops.loadDoc(sample);
  const red = { r: 1, g: 0, b: 0 };
  const yellow = { r: 1, g: 0.88, b: 0.1 };
  const meta = { author: "River" };
  const nms: string[] = [];

  await check("highlight", async () => {
    nms.push(ann.addTextMarkup(doc, 0, [{ x1: 60, y1: 716, x2: 380, y2: 716, x3: 60, y3: 696, x4: 380, y4: 696 }], "Highlight", yellow, 1, meta));
    return nms[nms.length - 1];
  });
  await check("underline", async () => ann.addTextMarkup(doc, 0, [{ x1: 60, y1: 786, x2: 400, y2: 786, x3: 60, y3: 756, x4: 400, y4: 756 }], "Underline", red, 1, meta));
  await check("strikeout", async () => ann.addTextMarkup(doc, 1, [{ x1: 60, y1: 716, x2: 380, y2: 716, x3: 60, y3: 696, x4: 380, y4: 696 }], "StrikeOut", red, 1, meta));
  await check("ink", async () => ann.addInk(doc, 0, [[100, 600, 150, 650, 200, 600, 250, 650]], red, 3, 1, meta));
  await check("square", async () => ann.addShape(doc, 0, [300, 500, 450, 600], "Square", { r: 0, g: 0, b: 1 }, 2, 1, meta));
  await check("circle", async () => ann.addShape(doc, 0, [100, 400, 250, 500], "Circle", { r: 0, g: 0.5, b: 0 }, 2, 1, meta));
  await check("note", async () => ann.addNote(doc, 0, 480, 760, yellow, { ...meta, contents: "這是一個便利貼 note" }));
  await check("freetext latin", async () => ann.addFreeText(doc, 0, [60, 350, 300, 300], "Hello free text box that should wrap onto several lines nicely", 12, red, fonts, meta));
  await check("freetext CJK", async () => ann.addFreeText(doc, 1, [60, 600, 260, 560], "中文文字框測試，這一行應該會自動換行到下一行。", 12, { r: 0, g: 0, b: 0 }, fonts, meta));

  let bytes = await ops.saveDoc(doc);
  fs.writeFileSync(__dirname + "/annots-out.pdf", bytes);

  await check("list page 1", async () => {
    const d = await ops.loadDoc(bytes);
    const list = ann.listAnnotations(d, 0);
    return list.map((a) => a.subtype).join(",") + ` (${list.length})`;
  });
  await check("hit test", async () => {
    const d = await ops.loadDoc(bytes);
    const hits = ann.annotationsAt(d, 0, 320, 550);
    return hits.map((a) => a.subtype).join(",");
  });
  await check("remove by nm (survives save/reload)", async () => {
    const d = await ops.loadDoc(bytes);
    const before = ann.listAnnotations(d, 0).length;
    const ok = ann.removeAnnotation(d, 0, { nm: nms[0] });
    bytes = await ops.saveDoc(d);
    const d2 = await ops.loadDoc(bytes);
    const after = ann.listAnnotations(d2, 0).length;
    return `${ok}, ${before} -> ${after}`;
  });
  await check("remove by ref", async () => {
    const d = await ops.loadDoc(bytes);
    const list = ann.listAnnotations(d, 0);
    const ok = ann.removeAnnotation(d, 0, { ref: list[0].ref });
    const d2 = await ops.loadDoc(await ops.saveDoc(d));
    return `${ok}, ${list.length} -> ${ann.listAnnotations(d2, 0).length}`;
  });
  await check("clear page", async () => {
    const d = await ops.loadDoc(bytes);
    const n = ann.clearAnnotations(d, 0);
    const d2 = await ops.loadDoc(await ops.saveDoc(d));
    return `${n} removed, left ${ann.listAnnotations(d2, 0).length}`;
  });
  await check("pdf.js can parse annotations", async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    let pdfjs: any;
    try {
      pdfjs = require("pdfjs-dist/legacy/build/pdf.mjs");
    } catch {
      return "skipped (pdfjs-dist not installed)";
    }
    const task = pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(__dirname + "/annots-out.pdf")) });
    const pdf = await task.promise;
    const page = await pdf.getPage(1);
    const annots = await page.getAnnotations();
    return annots.map((a: any) => a.subtype + (a.hasAppearance ? "+AP" : "")).join(",");
  });

  console.log(failures ? `\n${failures} FAILED` : "\nALL OK");
  process.exit(failures ? 1 : 0);
})();
