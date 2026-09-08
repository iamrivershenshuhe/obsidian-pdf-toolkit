// Node smoke test for src/pdf/ops.ts (no Obsidian runtime needed).
import * as fs from "fs";
import * as ops from "../src/pdf/ops";
import { parsePageRange, parsePageOrder } from "../src/util";
import { PDFDocument, StandardFonts } from "@cantoo/pdf-lib";

async function makeSample(n: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= n; i++) {
    const p = doc.addPage([595.28, 841.89]);
    p.drawText(`Sample page ${i}`, { x: 60, y: 760, size: 28, font });
  }
  doc.setTitle("Smoke Sample");
  doc.setAuthor("tester");
  return doc.save();
}

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
  const sample = await makeSample(6);
  const load = () => ops.loadDoc(sample);

  await check("parsePageRange", async () => JSON.stringify([parsePageRange("1-2,5,6-", 6), parsePageRange("odd", 6), parsePageRange("all", 6)]));
  await check("parsePageOrder", async () => JSON.stringify(parsePageOrder("3,1,2,6-4", 6)));
  await check("extract 2-3", async () => (await ops.loadDoc(await ops.extractPages(await load(), [1, 2]))).getPageCount() + " pages");
  await check("delete 1", async () => (await ops.loadDoc(await ops.deletePages(await load(), [0]))).getPageCount() + " pages");
  await check("rotate 90", async () => (await ops.loadDoc(await ops.rotatePages(await load(), [0], 90))).getPage(0).getRotation().angle + " deg");
  await check("reverse", async () => (await ops.loadDoc(await ops.reversePages(await load()))).getPageCount() + " pages");
  await check("blank after 6 x2", async () => (await ops.loadDoc(await ops.insertBlankPages(await load(), 6, 2))).getPageCount() + " pages");
  await check("duplicate", async () => (await ops.loadDoc(await ops.duplicatePages(await load(), [0, 1]))).getPageCount() + " pages");
  await check("merge", async () => (await ops.loadDoc(await ops.mergeDocs([sample, sample]))).getPageCount() + " pages");
  await check("splitEvery 4", async () => (await ops.splitEvery(await load(), 4)).length + " files");
  await check("applyPagePlan", async () => {
    const out = await ops.applyPagePlan(await load(), [
      { srcIndex: 5, rotate: 90, deleted: false },
      { srcIndex: 0, rotate: 0, deleted: true },
      { srcIndex: 2, rotate: 180, deleted: false },
    ]);
    const d = await ops.loadDoc(out);
    return `${d.getPageCount()} pages, rot ${d.getPage(0).getRotation().angle}/${d.getPage(1).getRotation().angle}`;
  });
  await check("watermark latin", async () => (await ops.addWatermark(await load(), { text: "DRAFT", fontSize: 60, opacity: 0.3, angle: 45, color: "#ff0000", tile: true, pages: [0, 1] }, fonts)).byteLength + " bytes");
  await check("watermark CJK via TTC", async () => (await ops.addWatermark(await load(), { text: "機密文件", fontSize: 60, opacity: 0.3, angle: 30, color: "#0000ff", tile: false, pages: [0] }, fonts)).byteLength + " bytes");
  await check("header/footer", async () => {
    const out = await ops.addHeaderFooter(await load(), { headerLeft: "{title}", headerCenter: "", headerRight: "{date}", footerLeft: "", footerCenter: "第 {page} / {total} 頁", footerRight: "{file}", fontSize: 10, margin: 28, startNumber: 1, color: "#333333", pages: [0, 1, 2, 3, 4, 5], fileName: "smoke" }, fonts);
    fs.writeFileSync(__dirname + "/smoke-out.pdf", out);
    return out.byteLength + " bytes (written smoke-out.pdf)";
  });
  await check("crop", async () => {
    const d = await ops.loadDoc(await ops.cropPages(await load(), { top: 50, bottom: 50, left: 20, right: 20, pages: [0] }));
    const s = d.getPage(0).getSize();
    return `${s.width.toFixed(1)}x${s.height.toFixed(1)}`;
  });
  await check("resize to Letter", async () => {
    const d = await ops.loadDoc(await ops.resizePages(await load(), { width: 612, height: 792, mode: "contain", pages: [0, 1, 2, 3, 4, 5] }));
    const s = d.getPage(0).getSize();
    return `${s.width}x${s.height}, ${d.getPageCount()} pages`;
  });
  await check("nup 4", async () => (await ops.loadDoc(await ops.nUp(await load(), { per: 4, sheet: [595.28, 841.89], landscape: true }))).getPageCount() + " sheets");
  let protectedBytes: Uint8Array = new Uint8Array();
  await check("protect", async () => {
    protectedBytes = await ops.protect(await load(), { userPassword: "open", ownerPassword: "own", printing: true, modifying: false, copying: false, annotating: true, fillingForms: true });
    return protectedBytes.byteLength + " bytes";
  });
  await check("load protected w/o password throws EncryptedError", async () => {
    try {
      await ops.loadDoc(protectedBytes);
      throw new Error("did not throw");
    } catch (e) {
      if (e instanceof ops.EncryptedError) return "EncryptedError";
      throw e;
    }
  });
  await check("unlock with password", async () => {
    const d = await ops.loadDoc(protectedBytes, { password: "open" });
    const out = await ops.unlock(d);
    const re = await ops.loadDoc(out);
    return `encrypted=${re.isEncrypted}, ${re.getPageCount()} pages`;
  });
  await check("wrong password", async () => {
    try {
      await ops.loadDoc(protectedBytes, { password: "nope" });
      throw new Error("did not throw");
    } catch (e) {
      return (e as Error).message;
    }
  });
  await check("metadata", async () => {
    const d = await ops.loadDoc(await ops.setMetadata(await load(), { title: "新標題", author: "A", subject: "S", keywords: "a, b", creator: "c", producer: "p" }));
    return JSON.stringify(ops.getMetadata(d));
  });
  await check("info", async () => JSON.stringify(ops.getInfo(await load(), false)).slice(0, 120));
  await check("attach", async () => (await ops.loadDoc(await ops.attachFile(await load(), new TextEncoder().encode("hello"), "note.txt", "text/plain", "d"))).getPageCount());
  await check("form create+describe+fill+flatten", async () => {
    const d = await PDFDocument.create();
    const p = d.addPage();
    const form = d.getForm();
    const tf = form.createTextField("name");
    tf.addToPage(p, { x: 50, y: 700, width: 200, height: 24 });
    const cb = form.createCheckBox("agree");
    cb.addToPage(p, { x: 50, y: 650, width: 20, height: 20 });
    const dd = form.createDropdown("color");
    dd.addOptions(["red", "green"]);
    dd.addToPage(p, { x: 50, y: 600, width: 120, height: 24 });
    const bytes = await d.save();
    const loaded = await ops.loadDoc(bytes);
    const desc = ops.describeFields(loaded);
    const filled = await ops.fillFields(loaded, { name: "River", agree: true, color: "green" }, false);
    const re = await ops.loadDoc(filled);
    const after = ops.describeFields(re);
    const flat = await ops.fillFields(await ops.loadDoc(filled), {}, true);
    const flatDesc = ops.describeFields(await ops.loadDoc(flat));
    return `${desc.length} fields; after fill: ${JSON.stringify(after.map((f) => f.value))}; after flatten: ${flatDesc.length} fields`;
  });
  await check("imagesToPdf (png)", async () => {
    // 1x1 red PNG
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==", "base64");
    const d = await ops.loadDoc(await ops.imagesToPdf([{ data: new Uint8Array(png), ext: "png" }, { data: new Uint8Array(png), ext: "png" }], [595.28, 841.89]));
    return d.getPageCount() + " pages";
  });
  await check("optimize", async () => (await ops.optimize(await load())).byteLength + " bytes");
  await check("extractFromTtc header", async () => {
    const p = "C:\\Windows\\Fonts\\msjh.ttc";
    if (!fs.existsSync(p)) return "skipped (no msjh.ttc)";
    const ttf = ops.extractFromTtc(new Uint8Array(fs.readFileSync(p)));
    const tag = ttf.slice(0, 4);
    return `first bytes ${Array.from(tag).map((b) => b.toString(16).padStart(2, "0")).join(" ")}, ${ttf.byteLength} bytes`;
  });

  console.log(failures ? `\n${failures} FAILED` : "\nALL OK");
  process.exit(failures ? 1 : 0);
})();
