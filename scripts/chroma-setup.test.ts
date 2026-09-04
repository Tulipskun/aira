import { strict as assert } from "node:assert";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromaExecutable, detectPackageManager, ensureChroma, type CommandRunner } from "./chroma-setup.js";

const commands: string[] = [];
const available = new Set(["apt-get", "python3"]);
const root = mkdtempSync(join(tmpdir(), "aira-chroma-"));

const runner: CommandRunner = (command, args) => {
  commands.push(`${command} ${args.join(" ")}`);
  if (command === "sh" && args[0] === "-lc") {
    const name = args[1].match(/command -v '([^']+)'/)?.[1];
    return name && available.has(name)
      ? { status: 0, stdout: `/usr/bin/${name}\n`, stderr: "" }
      : { status: 1, stdout: "", stderr: "" };
  }
  if (command === "/usr/bin/python3" && args[0] === "-m" && args[1] === "venv") {
    mkdirSync(resolve(args[2], "bin"), { recursive: true });
    writeFileSync(resolve(args[2], "bin/python"), "fake-python");
    return { status: 0, stdout: "", stderr: "" };
  }
  if (command.endsWith("/bin/python") && args[0] === "-m" && args[1] === "pip") {
    if (args[2] === "--version") {
      return { status: 0, stdout: "pip 25.0\n", stderr: "" };
    }
    writeFileSync(chromaExecutable(root), "#!/bin/sh\nexit 0\n");
    chmodSync(chromaExecutable(root), 0o755);
    return { status: 0, stdout: "", stderr: "" };
  }
  return { status: 0, stdout: "", stderr: "" };
};

assert.equal(detectPackageManager("linux", runner), "apt-get");
assert.equal(detectPackageManager("darwin", runner), undefined);

const installed = await ensureChroma(root, { platform: "linux", runner });
assert.equal(installed, chromaExecutable(root));
assert.ok(commands.some((value) => value.includes("python3 -m venv")));
assert.ok(commands.some((value) => value.includes("-m pip install chromadb")));

const commandCount = commands.length;
const reused = await ensureChroma(root, { platform: "linux", runner });
assert.equal(reused, installed);
assert.equal(commands.length, commandCount);

const brokenRoot = mkdtempSync(join(tmpdir(), "aira-chroma-no-pip-"));
mkdirSync(resolve(brokenRoot, ".aira/chroma-venv/bin"), { recursive: true });
writeFileSync(resolve(brokenRoot, ".aira/chroma-venv/bin/python"), "fake-python");
const brokenCommands: string[] = [];
let pipReady = false;
const brokenRunner: CommandRunner = (command, args) => {
  brokenCommands.push(`${command} ${args.join(" ")}`);
  if (command.endsWith("/bin/python") && args[0] === "-m" && args[1] === "pip" && args[2] === "--version") {
    return pipReady
      ? { status: 0, stdout: "pip 25.0\n", stderr: "" }
      : { status: 1, stdout: "", stderr: "No module named pip" };
  }
  if (command.endsWith("/bin/python") && args[0] === "-m" && args[1] === "ensurepip") {
    pipReady = true;
    return { status: 0, stdout: "Successfully installed pip\n", stderr: "" };
  }
  if (command.endsWith("/bin/python") && args[0] === "-m" && args[1] === "pip" && args[2] === "install") {
    writeFileSync(chromaExecutable(brokenRoot), "#!/bin/sh\nexit 0\n");
    chmodSync(chromaExecutable(brokenRoot), 0o755);
    return { status: 0, stdout: "", stderr: "" };
  }
  return { status: 0, stdout: "", stderr: "" };
};

const recovered = await ensureChroma(brokenRoot, { platform: "linux", runner: brokenRunner });
assert.equal(recovered, chromaExecutable(brokenRoot));
assert.ok(brokenCommands.some((value) => value.includes("-m ensurepip --upgrade")));
assert.ok(brokenCommands.some((value) => value.includes("-m pip --version")));
assert.ok(brokenCommands.some((value) => value.includes("-m pip install chromadb")));

const fallbackRoot = mkdtempSync(join(tmpdir(), "aira-chroma-pip-fallback-"));
mkdirSync(resolve(fallbackRoot, ".aira/chroma-venv/bin"), { recursive: true });
writeFileSync(resolve(fallbackRoot, ".aira/chroma-venv/bin/python"), "fake-python");
const fallbackCommands: string[] = [];
const fallbackRunner: CommandRunner = (command, args) => {
  fallbackCommands.push(`${command} ${args.join(" ")}`);
  if (command === "sh" && args[0] === "-lc") {
    const name = args[1].match(/command -v '([^']+)'/)?.[1];
    return name === "python3"
      ? { status: 0, stdout: "/usr/bin/python3\n", stderr: "" }
      : { status: 1, stdout: "", stderr: "" };
  }
  if (command === "/usr/bin/python3" && args[0] === "-m" && args[1] === "pip" && args[2] === "--version") {
    return { status: 0, stdout: "pip 25.0\n", stderr: "" };
  }
  if (command.endsWith("/bin/python") && args[0] === "-m" && args[1] === "pip" && args[2] === "--version") {
    return { status: 1, stdout: "", stderr: "No module named pip" };
  }
  if (command.endsWith("/bin/python") && args[0] === "-m" && args[1] === "ensurepip") {
    return { status: 1, stdout: "", stderr: "ensurepip is disabled" };
  }
  if (command === "/usr/bin/python3" && args[0] === "-m" && args[1] === "pip" && args[2] === "--python") {
    pipReady = true;
    return { status: 0, stdout: "Successfully installed pip\n", stderr: "" };
  }
  if (command.endsWith("/bin/python") && args[0] === "-m" && args[1] === "pip" && args[2] === "install") {
    writeFileSync(chromaExecutable(fallbackRoot), "#!/bin/sh\nexit 0\n");
    chmodSync(chromaExecutable(fallbackRoot), 0o755);
    return { status: 0, stdout: "", stderr: "" };
  }
  return { status: 0, stdout: "", stderr: "" };
};

const fallbackInstalled = await ensureChroma(fallbackRoot, { platform: "linux", runner: fallbackRunner });
assert.equal(fallbackInstalled, chromaExecutable(fallbackRoot));
assert.ok(fallbackCommands.some((value) => value.includes("/usr/bin/python3 -m pip --python")));

await assert.rejects(
  ensureChroma(mkdtempSync(join(tmpdir(), "aira-chroma-win-")), { platform: "win32", runner }),
  /not supported on Windows/,
);

console.log("chroma setup tests: OK");
