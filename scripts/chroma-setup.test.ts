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

await assert.rejects(
  ensureChroma(mkdtempSync(join(tmpdir(), "aira-chroma-win-")), { platform: "win32", runner }),
  /not supported on Windows/,
);

console.log("chroma setup tests: OK");
