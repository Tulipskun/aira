import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const venvChroma = resolve(root, ".aira/chroma-venv/bin/chroma");
const chroma = existsSync(venvChroma) ? venvChroma : "chroma";

let chromaProcess: ReturnType<typeof spawn> | undefined;
let airaProcess: ReturnType<typeof spawn> | undefined;
let shuttingDown = false;

function startChroma() {
  chromaProcess = spawn(chroma, [
    "run",
    "--path", resolve(root, ".aira/chroma"),
    "--host", "127.0.0.1",
    "--port", "8000",
  ], { cwd: root, stdio: "inherit" });
  chromaProcess.once("exit", (code, signal) => {
    if (!shuttingDown) {
      console.error(`[SUPERVISOR] Chroma exited (${signal ?? code}); stopping Aira.`);
      airaProcess?.kill("SIGTERM");
    }
  });
}

async function waitForChroma(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch("http://127.0.0.1:8000/api/v2/heartbeat");
      if (response.ok) return;
    } catch {}
    await Bun.sleep(250);
  }
  throw new Error("Chroma did not become ready within 30 seconds");
}

function startAira() {
  airaProcess = spawn("bun", ["run", "bot.ts"], {
    cwd: root,
    stdio: "inherit",
    env: process.env,
  });
  airaProcess.once("exit", (code, signal) => {
    if (!shuttingDown) {
      console.error(`[SUPERVISOR] Aira exited (${signal ?? code}); shutting down.`);
      shutdown(1);
    }
  });
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  airaProcess?.kill("SIGTERM");
  chromaProcess?.kill("SIGTERM");
  setTimeout(() => process.exit(code), 1_000).unref();
}

process.once("SIGINT", () => shutdown(0));
process.once("SIGTERM", () => shutdown(0));

console.log("[SUPERVISOR] Starting Chroma...");
startChroma();
await waitForChroma();
console.log("[SUPERVISOR] Chroma ready.");
console.log("[SUPERVISOR] Starting Aira...");
startAira();
