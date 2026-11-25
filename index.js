// Pterodactyl Node.js egg entrypoint. Bun is provided through NODE_PACKAGES=bun.
const { spawnSync, spawn } = require("node:child_process");
process.env.ISLA_TOKEN ||= process.env.DISCORD || "";
function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit", env: process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
try {
  run("bun", ["install", "--frozen-lockfile"]);
  if (!process.env.DISCORD && !process.env.ISLA_TOKEN) {
    throw new Error("Set the DISCORD environment variable in the server panel.");
  }
  run("bun", ["run", "scripts/register-commands.ts"]);
  const bot = spawn("bun", ["run", "start"], { stdio: "inherit", env: process.env });
  const stop = (signal) => { if (!bot.killed) bot.kill(signal); };
  process.once("SIGINT", () => stop("SIGINT"));
  process.once("SIGTERM", () => stop("SIGTERM"));
  bot.once("error", (error) => { console.error("[AIRA] Failed to start:", error.message); process.exitCode = 1; });
  bot.once("exit", (code, signal) => process.exit(code ?? (signal === "SIGINT" ? 130 : 1)));
} catch (error) {
  console.error("[AIRA]", error.message);
  process.exit(1);
}
