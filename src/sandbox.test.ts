import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  resolveSandboxRoot,
  sanitizeSegment,
  Sandbox,
} from "./sandbox.js";
import {
  ConfigError,
  FileExistsError,
  SandboxViolationError,
} from "./errors.js";

describe("sanitizeSegment", () => {
  it("neutralizes path separators and traversal", () => {
    const out = sanitizeSegment("../../etc/passwd");
    expect(out).not.toMatch(/[/\\]/);
    expect(out).not.toContain("..");
  });

  it("strips control characters and null bytes", () => {
    expect(sanitizeSegment("evil\u0000name\u001f.png")).toBe("evil_name_.png");
  });

  it("leaves ordinary filenames alone", () => {
    expect(sanitizeSegment("screenshot v1.2 (final).png")).toBe(
      "screenshot v1.2 (final).png",
    );
  });

  it("guards Windows reserved names", () => {
    expect(sanitizeSegment("CON.txt")).toBe("_CON.txt");
    expect(sanitizeSegment("com1")).toBe("_com1");
  });

  it("truncates long names but keeps the extension", () => {
    const out = sanitizeSegment("x".repeat(300) + ".png");
    expect(out.length).toBeLessThanOrEqual(100);
    expect(out.endsWith(".png")).toBe(true);
  });

  it("truncates by bytes, not characters", () => {
    const out = sanitizeSegment("\u{5b57}".repeat(200) + ".png");
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(100);
    expect(out.endsWith(".png")).toBe(true);
  });

  it("strips leading dots so nothing hides", () => {
    expect(sanitizeSegment(".env")).toBe("env");
  });

  it("falls back when nothing survives", () => {
    expect(sanitizeSegment("...")).toBe("attachment");
    expect(sanitizeSegment("")).toBe("attachment");
  });
});

describe("resolveSandboxRoot", () => {
  it("uses ATTACHMENT_MCP_DIR when set", () => {
    expect(
      resolveSandboxRoot({
        env: { ATTACHMENT_MCP_DIR: "/somewhere/else" },
        cwd: "/a/project",
      }),
    ).toBe("/somewhere/else");
  });

  it("rejects a relative ATTACHMENT_MCP_DIR", () => {
    expect(() =>
      resolveSandboxRoot({
        env: { ATTACHMENT_MCP_DIR: "relative/dir" },
        cwd: "/a/project",
      }),
    ).toThrow(ConfigError);
  });

  it("defaults to project-local .claude/attachments for a sane cwd", () => {
    expect(resolveSandboxRoot({ env: {}, cwd: "/a/project" })).toBe(
      path.join("/a/project", ".claude", "attachments"),
    );
  });

  it("falls back to a cache dir when cwd is the filesystem root", () => {
    const root = resolveSandboxRoot({ env: {}, cwd: path.parse("/").root });
    expect(root).toContain("atlassian-attachments-mcp");
    expect(root).not.toContain(".claude");
  });

  it("falls back to a cache dir when cwd is the home directory", () => {
    const root = resolveSandboxRoot({ env: {}, cwd: os.homedir() });
    expect(root).toContain("atlassian-attachments-mcp");
  });
});

describe("Sandbox", () => {
  let dir: string;
  let sandbox: Sandbox;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "sandbox-test-"));
    sandbox = new Sandbox(path.join(dir, "root"));
    await sandbox.init();
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("self-gitignores its root", async () => {
    const gi = await fs.readFile(
      path.join(sandbox.root, ".gitignore"),
      "utf8",
    );
    expect(gi).toBe("*\n");
  });

  it("does not clobber an existing .gitignore", async () => {
    await fs.writeFile(path.join(sandbox.root, ".gitignore"), "custom\n");
    await sandbox.init();
    expect(
      await fs.readFile(path.join(sandbox.root, ".gitignore"), "utf8"),
    ).toBe("custom\n");
  });

  it("builds sanitized nested write paths", async () => {
    const target = await sandbox.prepareWrite([
      "example.atlassian.net",
      "PROJ-123",
      "10001-report.pdf",
    ]);
    expect(target).toBe(
      path.join(
        sandbox.root,
        "example.atlassian.net",
        "PROJ-123",
        "10001-report.pdf",
      ),
    );
    await fs.writeFile(target, "data");
  });

  it("keeps traversal-shaped segments inside the root", async () => {
    const target = await sandbox.prepareWrite(["PROJ-1", "../../../escape.txt"]);
    expect(target.startsWith(sandbox.root + path.sep)).toBe(true);
  });

  it("refuses to overwrite by default and suggests a deduped path", async () => {
    const target = await sandbox.prepareWrite(["PROJ-1", "file.txt"]);
    await fs.writeFile(target, "v1");
    const err = await sandbox
      .prepareWrite(["PROJ-1", "file.txt"])
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FileExistsError);
    expect((err as FileExistsError).suggestedPath).toBe(
      path.join(sandbox.root, "PROJ-1", "file-2.txt"),
    );
  });

  it("overwrites when explicitly asked", async () => {
    const target = await sandbox.prepareWrite(["PROJ-1", "file.txt"]);
    await fs.writeFile(target, "v1");
    await expect(
      sandbox.prepareWrite(["PROJ-1", "file.txt"], { overwrite: true }),
    ).resolves.toBe(target);
  });

  it("refuses to write through a symlinked directory that escapes", async () => {
    const outside = path.join(dir, "outside");
    await fs.mkdir(outside);
    await fs.symlink(outside, path.join(sandbox.root, "link"));
    await expect(
      sandbox.prepareWrite(["link", "file.txt"]),
    ).rejects.toThrow(SandboxViolationError);
  });

  it("refuses to write onto a symlinked file", async () => {
    const outside = path.join(dir, "victim.txt");
    await fs.writeFile(outside, "precious");
    await fs.symlink(outside, path.join(sandbox.root, "file.txt"));
    await expect(sandbox.prepareWrite(["file.txt"])).rejects.toThrow(
      SandboxViolationError,
    );
  });
});
