import { spawn, ChildProcess } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/*
 * Run a local AI CLI ("harness") with the prompt on stdin and stream its output.
 * Supported: Claude Code (`claude -p`), OpenAI Codex (`codex exec`), or any custom shell command.
 * No API keys: this reuses whatever the CLI is already logged in with.
 */

export type LlmProvider = "claude" | "codex" | "custom";

export interface LlmSettings {
  llmProvider: LlmProvider;
  llmClaudePath: string;
  llmCodexPath: string;
  llmCustomCommand: string;
  llmModel: string;
  llmExtraPath: string;
  llmMaxChars: number;
}

export interface RunResult {
  code: number | null;
  stderr: string;
  /** full text produced (assembled from chunks or from the CLI's final-message output) */
  text: string;
}

export interface RunHandle {
  done: Promise<RunResult>;
  kill: () => void;
}

const isWin = process.platform === "win32";

function existingDirs(list: string[]): string[] {
  const out: string[] = [];
  for (const d of list) {
    try {
      if (d && fs.existsSync(d) && fs.statSync(d).isDirectory()) out.push(d);
    } catch {
      /* ignore */
    }
  }
  return out;
}

/** Obsidian is launched without the user's shell PATH; add the usual places CLIs live. */
export function buildPath(extra: string): string {
  const home = os.homedir();
  const sep = isWin ? ";" : ":";
  const current = process.env.PATH || process.env.Path || "";
  const have = new Set(current.split(sep).filter(Boolean));
  const candidates: string[] = extra
    .split(/\r?\n|;/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (isWin) {
    candidates.push(
      path.join(process.env.APPDATA || "", "npm"),
      path.join(home, ".local", "bin"),
      path.join(process.env.LOCALAPPDATA || "", "Programs", "claude"),
      path.join(home, ".claude", "local"),
      path.join(home, ".bun", "bin"),
      path.join(home, ".volta", "bin"),
      path.join(home, ".cargo", "bin"),
      path.join(home, "scoop", "shims"),
    );
  } else {
    candidates.push(
      "/usr/local/bin",
      "/opt/homebrew/bin",
      "/opt/homebrew/sbin",
      path.join(home, ".local", "bin"),
      path.join(home, ".npm-global", "bin"),
      path.join(home, ".claude", "local"),
      path.join(home, ".bun", "bin"),
      path.join(home, ".volta", "bin"),
      path.join(home, ".cargo", "bin"),
      path.join(home, ".codex", "bin"),
    );
    // nvm / fnm node versions
    for (const base of [path.join(home, ".nvm", "versions", "node"), path.join(home, ".fnm", "node-versions")]) {
      try {
        for (const v of fs.readdirSync(base)) candidates.push(path.join(base, v, "bin"), path.join(base, v, "installation", "bin"));
      } catch {
        /* no nvm */
      }
    }
  }
  const add = existingDirs(candidates).filter((d) => !have.has(d));
  return [...add, current].filter(Boolean).join(sep);
}

function quote(s: string): string {
  if (!/[\s"']/.test(s)) return s;
  return isWin ? `"${s.replace(/"/g, '""')}"` : `'${s.replace(/'/g, `'\\''`)}'`;
}

export interface Command {
  /** full shell command line */
  line: string;
  /** file the CLI writes its final answer to (codex), read after exit */
  lastMessageFile?: string;
  /** parse stdout lines as Claude Code stream-json */
  streamJson?: boolean;
}

export function buildCommand(s: LlmSettings, opts: { plainText?: boolean } = {}): Command {
  const model = s.llmModel.trim();
  switch (s.llmProvider) {
    case "claude": {
      const exe = s.llmClaudePath.trim() || "claude";
      const args = ["-p"];
      if (opts.plainText) args.push("--output-format", "text");
      else args.push("--output-format", "stream-json", "--verbose", "--include-partial-messages");
      if (model) args.push("--model", model);
      return { line: [quote(exe), ...args].join(" "), streamJson: !opts.plainText };
    }
    case "codex": {
      const exe = s.llmCodexPath.trim() || "codex";
      const out = path.join(os.tmpdir(), `pdf-toolkit-codex-${Date.now()}.txt`);
      const args = ["exec", "--skip-git-repo-check", "-o", quote(out)];
      if (model) args.push("--model", model);
      return { line: [quote(exe), ...args].join(" "), lastMessageFile: out };
    }
    default: {
      const line = (s.llmCustomCommand || "").split("{model}").join(model);
      return { line };
    }
  }
}

export function runLlm(
  s: LlmSettings,
  prompt: string,
  cwd: string,
  onChunk: (text: string) => void,
  opts: { plainText?: boolean } = {},
): RunHandle {
  const cmd = buildCommand(s, opts);
  const envPath = buildPath(s.llmExtraPath || "");
  const env = { ...process.env, PATH: envPath, Path: envPath };
  let child: ChildProcess;
  try {
    child = spawn(cmd.line, { shell: true, cwd, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  } catch (e) {
    return { done: Promise.resolve({ code: -1, stderr: String(e), text: "" }), kill: () => undefined };
  }

  let stderr = "";
  let text = "";
  let sawDelta = false;
  let pending = "";

  const handleJsonLine = (line: string) => {
    const s = line.trim();
    if (!s) return;
    let obj: unknown;
    try {
      obj = JSON.parse(s);
    } catch {
      // not JSON: show it raw
      text += s + "\n";
      onChunk(s + "\n");
      return;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const o = obj as any;
    if (o.type === "stream_event") {
      const ev = o.event;
      if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta" && typeof ev.delta.text === "string") {
        sawDelta = true;
        text += ev.delta.text;
        onChunk(ev.delta.text);
      }
    } else if (o.type === "assistant" && !sawDelta) {
      const parts = o.message?.content;
      if (Array.isArray(parts)) {
        for (const p of parts) {
          if (p?.type === "text" && typeof p.text === "string") {
            text += p.text;
            onChunk(p.text);
          }
        }
      }
    } else if (o.type === "result") {
      if (!text && typeof o.result === "string") {
        text = o.result;
        onChunk(o.result);
      }
      if (o.is_error && typeof o.result === "string") stderr += o.result + "\n";
    }
  };

  child.stdout?.on("data", (buf: Buffer) => {
    const chunk = buf.toString("utf8");
    if (cmd.streamJson) {
      pending += chunk;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? "";
      for (const l of lines) handleJsonLine(l);
    } else {
      text += chunk;
      onChunk(chunk);
    }
  });
  child.stderr?.on("data", (buf: Buffer) => {
    stderr += buf.toString("utf8");
  });

  const done = new Promise<RunResult>((resolve) => {
    child.on("error", (err) => resolve({ code: -1, stderr: stderr + String(err), text }));
    child.on("close", (code) => {
      if (cmd.streamJson && pending.trim()) handleJsonLine(pending);
      if (cmd.lastMessageFile) {
        try {
          if (fs.existsSync(cmd.lastMessageFile)) {
            const final = fs.readFileSync(cmd.lastMessageFile, "utf8").trim();
            fs.unlinkSync(cmd.lastMessageFile);
            if (final) text = final;
          }
        } catch {
          /* ignore */
        }
      }
      resolve({ code, stderr, text });
    });
  });

  try {
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(prompt, "utf8");
  } catch {
    /* ignore */
  }

  const kill = () => {
    try {
      if (isWin && child.pid) spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
      else child.kill("SIGTERM");
    } catch {
      /* ignore */
    }
  };
  return { done, kill };
}

/** Roughly detect "command not found" so the UI can give a useful hint. */
export function looksLikeNotFound(stderr: string, code: number | null): boolean {
  return /not recognized|not found|ENOENT|No such file/i.test(stderr) || code === 127 || code === 9009;
}
