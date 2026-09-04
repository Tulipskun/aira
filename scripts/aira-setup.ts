import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { stdin, stdout } from "node:process";
import { join, resolve } from "node:path";

export const DEFAULT_MODELS = {
  GEMINI1_MODEL: "gemini-3.1-flash-lite",
  GEMINI2_MODEL: "gemini-3.5-flash-lite",
  GEMINI_EMBEDDING2_MODEL: "gemini-embedding-2",
} as const;

export function normalizeApiKeys(input: string): string {
  return input
    .split(",")
    .map((key) => key.trim())
    .filter(Boolean)
    .join(",");
}

export function shouldConfigureModels(input: string): boolean {
  return input.trim().toLowerCase() === "y";
}

function quoteEnvValue(value: string): string {
  if (/^[A-Za-z0-9_./:@+,-]+$/.test(value)) return value;
  return JSON.stringify(value);
}

export function updateEnvFile(file: string, values: Record<string, string>): void {
  let content = existsSync(file) ? readFileSync(file, "utf8") : "";
  const lines = content.split("\n");
  const updated = new Set<string>();

  const result = lines.map((line) => {
    const match = line.match(/^(\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*=).*$/);
    if (!match || !(match[2] in values)) return line;
    const key = match[2];
    updated.add(key);
    return `${match[1]}${key}=${quoteEnvValue(values[key])}`;
  });

  for (const [key, value] of Object.entries(values)) {
    if (!updated.has(key)) result.push(`${key}=${quoteEnvValue(value)}`);
  }

  content = result.join("\n");
  if (!content.endsWith("\n")) content += "\n";
  writeFileSync(file, content);
}

function readEnvValue(file: string, key: string): string {
  if (!existsSync(file)) return "";
  const line = readFileSync(file, "utf8")
    .split("\n")
    .find((entry) => new RegExp(`^\\s*${key}\\s*=`).test(entry));
  if (!line) return "";
  const value = line.replace(/^\s*[^=]+\s*=\s*/, "").trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function promptLine(question: string, defaultValue = ""): Promise<string> {
  const suffix = defaultValue ? ` [${defaultValue}]` : "";
  const rl = createInterface({ input: stdin, output: stdout });
  return new Promise((resolve) => {
    rl.question(`${question}${suffix}: `, (answer) => {
      rl.close();
      resolve(answer.trim() || defaultValue);
    });
  });
}

function promptSecret(question: string, hasExistingValue: boolean): Promise<string> {
  if (!stdin.isTTY || !stdout.isTTY) return promptLine(question, hasExistingValue ? "" : "");

  stdout.write(`${question}${hasExistingValue ? " [Enter เพื่อคงค่าเดิม]" : ""}: `);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");

  return new Promise((resolve) => {
    let value = "";
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === "\u0003") {
          stdin.setRawMode(false);
          stdin.pause();
          stdout.write("^C\n");
          process.exit(130);
        }
        if (char === "\r" || char === "\n") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off("data", onData);
          stdout.write("\n");
          resolve(value.trim());
          return;
        }
        if (char === "\u007f" || char === "\b") {
          if (value.length > 0) {
            value = value.slice(0, -1);
            stdout.write("\b \b");
          }
          continue;
        }
        value += char;
        stdout.write("*");
      }
    };
    stdin.on("data", onData);
  });
}

async function promptRequired(question: string, existingValue = "", secret = false): Promise<string> {
  while (true) {
    const value = secret
      ? await promptSecret(question, Boolean(existingValue))
      : await promptLine(question, existingValue);
    if (value || existingValue) return value || existingValue;
    console.log("กรุณาระบุค่า");
  }
}

export async function runSetup(root: string): Promise<number> {
  const envFile = resolve(root, ".env");
  const token = await promptRequired("กรุณาใส่ Discord token", readEnvValue(envFile, "ISLA_TOKEN"), true);
  const ownerId = await promptRequired("กรุณาใส่ owner id", readEnvValue(envFile, "DISCORD_OWNER_ID"));
  const existingKeys = readEnvValue(envFile, "GEMINI_API_KEY");
  const keyInput = await promptSecret("กรุณาใส่ API key(s) คั่นด้วย (,) -> ระบบ trim ช่องว่างอัตโนมัติ", Boolean(existingKeys));
  const apiKeys = normalizeApiKeys(keyInput) || existingKeys;
  if (!apiKeys) {
    console.log("กรุณาระบุ API key อย่างน้อย 1 ค่า");
    return 1;
  }

  const values: Record<string, string> = {
    ISLA_TOKEN: token,
    DISCORD_OWNER_ID: ownerId,
    GEMINI_API_KEY: apiKeys,
  };

  const modelChoice = await promptLine("ต้องการตั้ง model name หรือไม่ (y/N default=N)", "N");
  if (shouldConfigureModels(modelChoice)) {
    values.GEMINI1_MODEL = await promptLine("Gemini 1 model", readEnvValue(envFile, "GEMINI1_MODEL") || DEFAULT_MODELS.GEMINI1_MODEL);
    values.GEMINI2_MODEL = await promptLine("Gemini 2 model", readEnvValue(envFile, "GEMINI2_MODEL") || DEFAULT_MODELS.GEMINI2_MODEL);
    values.GEMINI_EMBEDDING2_MODEL = await promptLine("Gemini Embedding 2 model", readEnvValue(envFile, "GEMINI_EMBEDDING2_MODEL") || DEFAULT_MODELS.GEMINI_EMBEDDING2_MODEL);
  }

  updateEnvFile(envFile, values);
  console.log(`[AIRA] Saved configuration to ${join(root, ".env")}`);
  console.log("[AIRA] Run: aira start");
  return 0;
}

if (import.meta.main) process.exit(await runSetup(resolve(import.meta.dir, "..")));
