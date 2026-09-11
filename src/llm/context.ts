import type { ChatContext } from "../ui/chat";

/** Share the text budget across sources so a long first passage cannot hide later ones. */
export function combineContexts(contexts: ChatContext[], maxChars: number): ChatContext {
  if (!contexts.length) throw new Error("No context supplied");
  const max = Math.max(2000, Number.isFinite(maxChars) ? maxChars : 60000);
  const labels = contexts.map((ctx, i) => `[Source ${i + 1}: ${ctx.fileName} | ${ctx.filePath} | p.${ctx.page} | ${ctx.mode}]\n`);
  const budget = Math.max(0, max - labels.join("\n\n").length);
  if (budget < contexts.length) throw new Error("Too many source labels for the context limit. Remove some passages or increase the context limit.");
  const share = Math.floor(budget / contexts.length);
  return {
    ...contexts[0],
    text: contexts.map((ctx, i) => labels[i] + ctx.text.slice(0, share)).join("\n\n"),
    truncated: contexts.some((ctx) => ctx.truncated || ctx.text.length > share),
  };
}

export function sameContext(a: ChatContext, b: ChatContext): boolean {
  return a.filePath === b.filePath && a.page === b.page && a.text === b.text;
}
