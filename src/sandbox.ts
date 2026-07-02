import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { ConfigError, FileExistsError, SandboxViolationError } from "./errors.js";

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
// Bytes, not chars: 100 UTF-16 chars of CJK is ~300 bytes, over common
// 255-byte filename limits.
const MAX_SEGMENT_BYTES = 100;

/**
 * Make one attacker-controlled path segment (a filename, issue key, or page
 * id) safe to use as a single directory entry. Never trusted for containment
 * — that's assertContained's job — but ensures a segment can't smuggle
 * separators, traversal, or reserved names.
 */
export function sanitizeSegment(raw: string): string {
  let s = raw.normalize("NFC");
  // Path separators, control chars, and Windows-illegal punctuation.
  s = s.replace(/[/\\\u0000-\u001f\u007f:*?"<>|]/g, "_");
  // Leading/trailing dots and whitespace (hidden files, Windows quirks).
  s = s.replace(/^[\s.]+|[\s.]+$/g, "");
  // No runs of dots — kills ".." while leaving "v1.2.png" alone.
  s = s.replace(/\.{2,}/g, "_");
  if (WINDOWS_RESERVED.test(s)) s = "_" + s;
  if (Buffer.byteLength(s, "utf8") > MAX_SEGMENT_BYTES) {
    const ext = path.extname(s).slice(0, 20);
    const budget = MAX_SEGMENT_BYTES - Buffer.byteLength(ext, "utf8");
    let base = s.slice(0, s.length - ext.length);
    while (Buffer.byteLength(base, "utf8") > budget) base = base.slice(0, -1);
    s = (base || "attachment") + ext;
  }
  return s || "attachment";
}

export interface RootOptions {
  env?: Record<string, string | undefined>;
  cwd?: string;
}

/**
 * ATTACHMENT_MCP_DIR override, else project-local .claude/attachments when
 * cwd looks like a real workspace, else the per-user cache dir (hosts like
 * Claude Desktop launch MCP servers with cwd=/).
 */
export function resolveSandboxRoot(options: RootOptions = {}): string {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();

  const override = env.ATTACHMENT_MCP_DIR?.trim();
  if (override) {
    if (!path.isAbsolute(override)) {
      throw new ConfigError(
        "ATTACHMENT_MCP_DIR must be an absolute path (the server's working directory is host-dependent)",
      );
    }
    return path.resolve(override);
  }

  const fsRoot = path.parse(cwd).root;
  if (cwd !== fsRoot && cwd !== os.homedir()) {
    return path.join(cwd, ".claude", "attachments");
  }
  return defaultCacheDir(env);
}

function defaultCacheDir(env: Record<string, string | undefined>): string {
  const home = os.homedir();
  switch (process.platform) {
    case "darwin":
      return path.join(home, "Library", "Caches", "atlassian-attachments-mcp");
    case "win32":
      return path.join(
        env.LOCALAPPDATA ?? path.join(home, "AppData", "Local"),
        "atlassian-attachments-mcp",
        "Cache",
      );
    default:
      return path.join(
        env.XDG_CACHE_HOME ?? path.join(home, ".cache"),
        "atlassian-attachments-mcp",
      );
  }
}

/**
 * The single directory downloads are confined to. All write paths are built
 * from sanitized segments and verified (realpath-based) to stay inside.
 */
export class Sandbox {
  #realRoot: string | undefined;

  constructor(readonly root: string) {}

  /** Create the root and self-gitignore it so it never pollutes a repo. */
  async init(): Promise<void> {
    await fs.mkdir(this.root, { recursive: true });
    try {
      await fs.writeFile(path.join(this.root, ".gitignore"), "*\n", {
        flag: "wx",
      });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    this.#realRoot = await fs.realpath(this.root);
    if (this.#realRoot !== this.root) {
      // A symlinked root relocates downloads; containment still holds against
      // the canonical path, but say so where the user can see it.
      console.error(
        `atlassian-attachments-mcp: sandbox root ${this.root} resolves to ${this.#realRoot}`,
      );
    }
  }

  /**
   * Resolve a write target from raw segments (last one is the filename).
   * Sanitizes every segment, creates parent dirs, enforces containment and
   * the no-overwrite default. Returns the absolute path to write to.
   */
  async prepareWrite(
    segments: string[],
    options: { overwrite?: boolean } = {},
  ): Promise<string> {
    if (segments.length === 0) {
      throw new SandboxViolationError("No path segments provided");
    }
    const target = path.join(this.root, ...segments.map(sanitizeSegment));
    await this.#assertContained(target);

    await fs.mkdir(path.dirname(target), { recursive: true });

    const existing = await lstatOrNull(target);
    if (existing?.isSymbolicLink()) {
      throw new SandboxViolationError(
        `Refusing to write through a symlink: ${target}`,
      );
    }
    if (existing && !options.overwrite) {
      throw new FileExistsError(target, await this.#dedupe(target));
    }
    return target;
  }

  /** Path shown to agents: relative to the root, for compact tool output. */
  relative(absolute: string): string {
    return path.relative(this.root, absolute);
  }

  async #assertContained(target: string): Promise<void> {
    if (!this.#realRoot) {
      throw new SandboxViolationError("Sandbox not initialized");
    }
    // realpath the nearest existing ancestor so symlinked directories can't
    // relocate a not-yet-existing target outside the root.
    let probe = path.dirname(target);
    while (true) {
      try {
        const real = await fs.realpath(probe);
        const rel = path.relative(this.#realRoot, real);
        if (rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) {
          throw new SandboxViolationError(
            `Path escapes the sandbox root: ${target}`,
          );
        }
        return;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        const parent = path.dirname(probe);
        if (parent === probe) {
          throw new SandboxViolationError(
            `Path has no existing ancestor: ${target}`,
          );
        }
        probe = parent;
      }
    }
  }

  async #dedupe(target: string): Promise<string> {
    const dir = path.dirname(target);
    const ext = path.extname(target);
    const base = path.basename(target, ext);
    for (let n = 2; n < 1000; n++) {
      const candidate = path.join(dir, `${base}-${n}${ext}`);
      if (!(await lstatOrNull(candidate))) return candidate;
    }
    throw new SandboxViolationError(`Cannot find a free name for ${target}`);
  }
}

async function lstatOrNull(p: string) {
  try {
    return await fs.lstat(p);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}
