import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { LlmProvider } from "./runner";

export interface ModelOption { id: string; label: string; efforts: string[] }
export interface ProviderProfile { model: string; effort: string }
export const EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

export function parseModelOptions(text: string): ModelOption[] {
  return text.split(/\r?\n/).filter((line) => line.trim()).map((line) => {
    const [id, label, levels] = line.split("|").map((part) => part.trim());
    return { id, label: label || id, efforts: (levels || "").split(",").map((v) => v.trim()).filter((v) => EFFORTS.includes(v)) };
  }).filter((item) => !!item.id);
}

export function getModelOptions(provider: LlmProvider, configured = ""): ModelOption[] {
  const options = new Map<string, ModelOption>();
  if (provider === "codex") {
    try {
      const cache = JSON.parse(fs.readFileSync(path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "models_cache.json"), "utf8"));
      for (const model of cache.models ?? []) {
        if (typeof model.slug !== "string" || model.visibility === "hide") continue;
        options.set(model.slug, { id: model.slug, label: model.display_name || model.slug,
          efforts: (model.supported_reasoning_levels ?? []).map((level: { effort: string }) => level.effort).filter((level: string) => EFFORTS.includes(level)) });
      }
    } catch { /* CLI default and configured models remain available without a cache. */ }
  }
  if (provider === "claude") {
    for (const family of ["fable", "opus", "sonnet", "haiku"]) {
      options.set(family, { id: family, label: family[0].toUpperCase() + family.slice(1), efforts: family === "haiku" ? [] : ["low", "medium", "high", "xhigh", "max"] });
    }
  }
  for (const item of parseModelOptions(configured)) options.set(item.id, item);
  return Array.from(options.values());
}
