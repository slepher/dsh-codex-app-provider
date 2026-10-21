import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import { resolveCodexCommand } from "../lib/command.js";

/** Build a fake file system from a path set. */
function files(paths) {
  const set = new Set(paths);
  return { isFile: path => set.has(path), readText: path => { throw new Error(`no text for ${path}`); } };
}

const PREFIX = join("C:", "Users", "probe", "AppData", "Roaming", "npm");

test("a configured command is never second-guessed", () => {
  const resolved = resolveCodexCommand({ configured: " C:\\tools\\codex.exe ", env: { PATH: "" }, platform: "win32" });
  assert.deepEqual(resolved, { program: "C:\\tools\\codex.exe", prefixArgs: [], source: "configured" });
});

test("a directly spawnable codex on PATH wins over shims", () => {
  const exe = join(PREFIX, "codex.exe");
  const resolved = resolveCodexCommand({
    platform: "win32",
    env: { PATH: ["C:\\nowhere", PREFIX].join(";") },
    ...files([exe]),
  });
  assert.deepEqual(resolved, { program: exe, prefixArgs: [], source: "path" });
});

test("a Windows npm shim resolves to the JavaScript entry it launches", () => {
  const shim = join(PREFIX, "codex.cmd");
  const script = join(PREFIX, "node_modules", "@openai", "codex", "bin", "codex.js");
  const shimText = [
    "@ECHO off",
    "endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & \"%_prog%\" \"%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js\" %*",
  ].join("\r\n");
  const resolved = resolveCodexCommand({
    platform: "win32",
    env: { PATH: PREFIX },
    isFile: path => path === shim,
    readText: path => { assert.equal(path, shim); return shimText; },
    listDirs: () => [],
    nodePath: "C:\\node\\node.exe",
  });
  assert.equal(resolved.source, "npm-shim");
  assert.equal(resolved.program, "C:\\node\\node.exe");
  assert.deepEqual(resolved.prefixArgs, [script]);
});

test("a shim prefers the native binary its package ships", () => {
  const shim = join(PREFIX, "codex.cmd");
  const packageRoot = join(PREFIX, "node_modules", "@openai", "codex");
  const script = join(packageRoot, "bin", "codex.js");
  const vendor = join(packageRoot, "node_modules", "@openai", "codex-win32-x64", "vendor");
  const triple = "x86_64-pc-windows-msvc";
  const native = join(vendor, triple, "bin", "codex.exe");
  const shimText = `"%_prog%" "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*`;
  const resolved = resolveCodexCommand({
    platform: "win32",
    env: { PATH: PREFIX },
    isFile: path => path === shim || path === native,
    readText: () => shimText,
    listDirs: path => (path === vendor ? [triple] : []),
    nodePath: "C:\\node\\node.exe",
  });
  assert.deepEqual(resolved, { program: native, prefixArgs: [], source: "native" });
});

test("a repeated resolution reuses the cached answer", () => {
  const shim = join(PREFIX, "codex.cmd");
  const cache = new Map();
  let probes = 0;
  const options = {
    platform: "win32",
    env: { PATH: PREFIX },
    cache,
    isFile: path => { probes += 1; return path === shim; },
    readText: () => `"%_prog%" "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*`,
    listDirs: () => [],
    nodePath: "C:\\node\\node.exe",
  };
  const first = resolveCodexCommand(options);
  const scans = probes;
  const second = resolveCodexCommand(options);
  assert.equal(second, first, "the cached object is returned unchanged");
  assert.equal(probes, scans, "the second call performs no file probes");
});

test("a POSIX codex script is used directly", () => {
  const binary = join("/usr", "local", "bin", "codex");
  const resolved = resolveCodexCommand({
    platform: "linux",
    env: { PATH: ["/usr/bin", "/usr/local/bin"].join(":") },
    isFile: path => path === binary,
  });
  assert.deepEqual(resolved, { program: binary, prefixArgs: [], source: "path" });
});

test("no candidate falls back to the bare command name", () => {
  const resolved = resolveCodexCommand({ platform: "linux", env: { PATH: "/usr/bin" }, isFile: () => false });
  assert.deepEqual(resolved, { program: "codex", prefixArgs: [], source: "fallback" });
});

test("a shim without a node script is skipped", () => {
  const shim = join(PREFIX, "codex.cmd");
  const resolved = resolveCodexCommand({
    platform: "win32",
    env: { PATH: PREFIX },
    isFile: path => path === shim,
    readText: () => "rem nothing useful",
  });
  assert.equal(resolved.source, "fallback");
});
