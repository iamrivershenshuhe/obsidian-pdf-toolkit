/*
 * Parse the reference list of a paper out of per-page text, and detect
 * citations ([12], [3, 5-7], (Smith et al., 2020)) under the cursor.
 * Pure functions — no Obsidian dependencies — so they can be unit tested.
 */

export interface RefEntry {
  /** "12" for numbered lists; for author-year lists a generated key like "smith2020" */
  key: string;
  /** citation number when the list is numbered */
  num?: number;
  text: string;
  title?: string;
  year?: string;
  firstAuthor?: string;
  doi?: string;
  arxiv?: string;
  url?: string;
  /** 1-based page where the entry starts */
  page: number;
}

export interface RefList {
  entries: RefEntry[];
  numbered: boolean;
  /** 1-based page where the references section starts */
  startPage: number;
}

const HEADING_RE = /^\s*(?:\d+\.?\s*)?(references|bibliography|reference list|works cited|literature cited|參考文獻|参考文献|引用文獻)\s*:?\s*$/i;

function cleanText(s: string): string {
  return s
    .replace(/-\n(?=[a-z])/g, "") // de-hyphenate line breaks
    .replace(/\s*\n\s*/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function enrich(e: RefEntry): RefEntry {
  const t = e.text;
  const doi = t.match(/\b(10\.\d{4,9}\/[^\s"<>,;]+)/i);
  if (doi) e.doi = doi[1].replace(/[.,;)\]]+$/, "");
  const arx = t.match(/arxiv[:\s]*(\d{4}\.\d{4,5}(?:v\d+)?)/i) || t.match(/arxiv\.org\/abs\/(\d{4}\.\d{4,5}(?:v\d+)?)/i);
  if (arx) e.arxiv = arx[1];
  const url = t.match(/https?:\/\/[^\s"<>)\]]+/i);
  if (url) e.url = url[0].replace(/[.,;]+$/, "");
  const year = t.match(/\b(19|20)\d{2}[a-z]?\b/);
  if (year) e.year = year[0];
  // first author surname: first capitalised word (skip initials like "A.")
  const fa = t.match(/^(?:\[\d+\]\s*|\d+\.\s*)?([A-Z][A-Za-z'’\-]{1,}(?=[,\s]))/);
  if (fa) e.firstAuthor = fa[1];
  // title: quoted, else the segment after "(year)." (APA), else the segment after the first ". " (numbered IEEE-like)
  const quoted = t.match(/[“"]([^”"]{8,})[”"]/);
  if (quoted) e.title = quoted[1].replace(/[,.]$/, "").trim();
  else {
    const apa = t.match(/\(\s*(?:19|20)\d{2}[a-z]?\s*\)\.?\s*([^.]{8,}?)\.\s/);
    if (apa) e.title = apa[1].trim();
    else {
      const parts = t.replace(/^(?:\[\d+\]\s*|\d+\.\s*)/, "").split(/\.\s+/);
      if (parts.length >= 2 && parts[1].length >= 8) e.title = parts[1].replace(/[,.]$/, "").trim();
    }
  }
  return e;
}

/** Find the references section and split it into entries. */
export function parseReferences(pages: string[]): RefList | null {
  // Search from the end for the heading; the last "References" heading wins.
  let startPage = -1;
  let startLine = -1;
  for (let p = pages.length - 1; p >= 0 && startPage < 0; p--) {
    const lines = pages[p].split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      if (HEADING_RE.test(lines[i])) {
        startPage = p;
        startLine = i;
        break;
      }
    }
  }
  if (startPage < 0) return null;

  // Collect lines after the heading, remembering the page of each line.
  const lines: { text: string; page: number }[] = [];
  for (let p = startPage; p < pages.length; p++) {
    const ls = pages[p].split("\n");
    for (let i = p === startPage ? startLine + 1 : 0; i < ls.length; i++) lines.push({ text: ls[i], page: p + 1 });
  }
  // Stop at an appendix heading if there is one.
  const stop = lines.findIndex((l) => /^\s*(appendix|supplementary material|acknowledg(e)?ments?)\b/i.test(l.text));
  const body = stop > 0 ? lines.slice(0, stop) : lines;

  const numberedStart = /^\s*(?:\[(\d{1,3})\]|(\d{1,3})\.)\s+(?=\S)/;
  const starts = body.filter((l) => numberedStart.test(l.text)).length;
  const entries: RefEntry[] = [];

  if (starts >= 3) {
    let cur: { num: number; page: number; buf: string[] } | null = null;
    const flush = () => {
      if (!cur) return;
      const text = cleanText(cur.buf.join("\n"));
      if (text.length > 10) entries.push(enrich({ key: String(cur.num), num: cur.num, text, page: cur.page }));
      cur = null;
    };
    let expected = 1;
    for (const l of body) {
      const m = l.text.match(numberedStart);
      const num = m ? parseInt(m[1] ?? m[2], 10) : NaN;
      // accept a new entry only if its number is plausible (next or close) to avoid page numbers / years
      if (m && !isNaN(num) && (num === expected || (cur && num === cur.num + 1) || entries.length === 0)) {
        flush();
        cur = { num, page: l.page, buf: [l.text.replace(numberedStart, "")] };
        expected = num + 1;
      } else if (cur) cur.buf.push(l.text);
    }
    flush();
    return { entries, numbered: true, startPage: startPage + 1 };
  }

  // Author-year list: entries start with "Surname, X." or "Surname X." and contain a year.
  const authorStart = /^\s*[A-Z][A-Za-z'’\-]+,?\s+(?:[A-Z]\.|[A-Z][a-z]+)/;
  let cur: { page: number; buf: string[] } | null = null;
  const flush = () => {
    if (!cur) return;
    const text = cleanText(cur.buf.join("\n"));
    if (text.length > 10) {
      const e = enrich({ key: "", text, page: cur.page });
      e.key = `${(e.firstAuthor ?? "ref").toLowerCase()}${e.year ?? ""}`;
      entries.push(e);
    }
    cur = null;
  };
  const YEAR = /\b(?:19|20)\d{2}[a-z]?\b/;
  for (const l of body) {
    const last = cur ? cur.buf[cur.buf.length - 1] ?? "" : "";
    const prevEnded = !cur || /[.)\]]\s*$/.test(last) || /https?:\/\/\S+$/.test(last) || /\b10\.\d{4,9}\/\S+$/.test(last);
    const curHasYear = !!cur && YEAR.test(cur.buf.join(" "));
    const looksLikeStart = authorStart.test(l.text) && YEAR.test(l.text.slice(0, 140));
    if (looksLikeStart && (prevEnded || curHasYear)) {
      flush();
      cur = { page: l.page, buf: [l.text] };
    } else if (cur) cur.buf.push(l.text);
    else cur = { page: l.page, buf: [l.text] };
  }
  flush();
  return entries.length >= 3 ? { entries, numbered: false, startPage: startPage + 1 } : null;
}

/* ------------------------------------------------------------------ */
/* Citation detection around a caret offset                             */
/* ------------------------------------------------------------------ */

export interface Citation {
  /** matched text, e.g. "[3, 5-7]" or "(Smith et al., 2020)" */
  raw: string;
  start: number;
  end: number;
  numbers?: number[];
  authorYear?: { surname: string; year: string }[];
}

function expandNumbers(inner: string): number[] {
  const out: number[] = [];
  for (const part of inner.split(/[,;]/)) {
    const m = part.trim().match(/^(\d{1,3})\s*[-–—]\s*(\d{1,3})$/);
    if (m) {
      const a = parseInt(m[1], 10);
      const b = parseInt(m[2], 10);
      if (b >= a && b - a < 30) for (let i = a; i <= b; i++) out.push(i);
    } else if (/^\d{1,3}$/.test(part.trim())) out.push(parseInt(part.trim(), 10));
  }
  return out;
}

const BRACKET_RE = /\[(\d{1,3}(?:\s*[-–—]\s*\d{1,3})?(?:\s*[,;]\s*\d{1,3}(?:\s*[-–—]\s*\d{1,3})?)*)\]/g;
const AUTHOR_YEAR_RE = /\(((?:[A-Z][A-Za-z'’\-]+(?:\s+(?:et al\.?|and|&)\s*[A-Z]?[A-Za-z'’\-]*)*,?\s*(?:19|20)\d{2}[a-z]?(?:\s*[;,]\s*)?)+)\)/g;

/** Find a citation that contains character offset `pos` in `text`. */
export function citationAt(text: string, pos: number): Citation | null {
  for (const m of text.matchAll(BRACKET_RE)) {
    const s = m.index ?? 0;
    const e = s + m[0].length;
    if (pos >= s && pos <= e) {
      const numbers = expandNumbers(m[1]);
      if (numbers.length) return { raw: m[0], start: s, end: e, numbers };
    }
  }
  for (const m of text.matchAll(AUTHOR_YEAR_RE)) {
    const s = m.index ?? 0;
    const e = s + m[0].length;
    if (pos >= s && pos <= e) {
      const pairs: { surname: string; year: string }[] = [];
      for (const part of m[1].split(/;/)) {
        const sm = part.match(/([A-Z][A-Za-z'’\-]+)/);
        const ym = part.match(/(?:19|20)\d{2}[a-z]?/);
        if (sm && ym) pairs.push({ surname: sm[1], year: ym[0] });
      }
      if (pairs.length) return { raw: m[0], start: s, end: e, authorYear: pairs };
    }
  }
  return null;
}

/** Resolve a citation to entries of the parsed list. */
export function resolveCitation(list: RefList, c: Citation): RefEntry[] {
  if (c.numbers && list.numbered) {
    return c.numbers.map((n) => list.entries.find((e) => e.num === n)).filter((e): e is RefEntry => !!e);
  }
  if (c.authorYear) {
    const out: RefEntry[] = [];
    for (const { surname, year } of c.authorYear) {
      const y = year.replace(/[a-z]$/, "");
      const hit = list.entries.find((e) => e.text.slice(0, 120).toLowerCase().includes(surname.toLowerCase()) && e.text.includes(y));
      if (hit) out.push(hit);
    }
    return out;
  }
  return [];
}

export function scholarUrl(e: RefEntry): string {
  const q = e.title && e.title.length > 12 ? e.title : e.text.slice(0, 200);
  return `https://scholar.google.com/scholar?q=${encodeURIComponent(q)}`;
}
