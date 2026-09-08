import { loadPdfJs } from "obsidian";

/* Thin wrapper over the pdf.js build that ships with Obsidian. */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PdfJs = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type PdfJsDoc = any;

let lib: PdfJs | null = null;

async function pdfjs(): Promise<PdfJs> {
  if (!lib) lib = await loadPdfJs();
  return lib;
}

export async function openWithPdfJs(bytes: Uint8Array, password?: string): Promise<PdfJsDoc> {
  const p = await pdfjs();
  // pdf.js transfers the buffer to its worker, so hand it a copy.
  const task = p.getDocument({ data: new Uint8Array(bytes), password });
  return task.promise;
}

/** Extract text per page. Uses hasEOL hints and y-position changes to keep lines. */
export async function extractText(bytes: Uint8Array, password?: string): Promise<string[]> {
  const doc = await openWithPdfJs(bytes, password);
  const pages: string[] = [];
  try {
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      let out = "";
      let lastY: number | null = null;
      let lastX = 0;
      for (const item of content.items) {
        if (!("str" in item)) continue;
        const [, , , , x, y] = item.transform as number[];
        if (lastY !== null && Math.abs(y - lastY) > 2) {
          out += "\n";
        } else if (lastY !== null && x - lastX > 1 && out && !out.endsWith(" ") && !out.endsWith("\n")) {
          // Horizontal gap on the same line → probable word boundary.
          const gap = x - lastX;
          if (gap > item.height * 0.25) out += " ";
        }
        out += item.str;
        if (item.hasEOL) out += "\n";
        lastY = y;
        lastX = x + (item.width ?? 0);
      }
      pages.push(out.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim());
      page.cleanup();
    }
  } finally {
    await doc.destroy();
  }
  return pages;
}

export interface RenderOptions {
  /** Output width in CSS px (thumbnail mode). Mutually exclusive with scale. */
  width?: number;
  /** Scale factor relative to 72 dpi. */
  scale?: number;
}

/** Render one page (1-based) to a canvas. */
export async function renderPageToCanvas(doc: PdfJsDoc, pageNumber: number, o: RenderOptions): Promise<HTMLCanvasElement> {
  const page = await doc.getPage(pageNumber);
  const base = page.getViewport({ scale: 1 });
  const scale = o.width ? o.width / base.width : (o.scale ?? 1);
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext("2d")!;
  await page.render({ canvasContext: ctx, viewport }).promise;
  page.cleanup();
  return canvas;
}

export function canvasToPngBytes(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) return reject(new Error("toBlob failed"));
      blob.arrayBuffer().then((ab) => resolve(new Uint8Array(ab)), reject);
    }, "image/png");
  });
}

/** Render every page to PNG bytes, calling `onPage` as each one completes. */
export async function renderPagesToPng(
  bytes: Uint8Array,
  scale: number,
  pages: number[],
  onPage: (index: number, png: Uint8Array) => Promise<void>,
  password?: string,
): Promise<void> {
  const doc = await openWithPdfJs(bytes, password);
  try {
    for (const i of pages) {
      const canvas = await renderPageToCanvas(doc, i + 1, { scale });
      await onPage(i, await canvasToPngBytes(canvas));
      canvas.width = 0;
      canvas.height = 0;
    }
  } finally {
    await doc.destroy();
  }
}
