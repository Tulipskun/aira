import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const CONFIG_PATH = join(import.meta.dirname ?? ".", "data", "discord-config.json");

type DiscordConfig = {
  responseChannelId: string | null;
};

const DEFAULT_CONFIG: DiscordConfig = { responseChannelId: null };

async function loadConfig(): Promise<DiscordConfig> {
  try {
    const parsed = JSON.parse(await readFile(CONFIG_PATH, "utf8")) as Partial<DiscordConfig>;
    return {
      responseChannelId: typeof parsed.responseChannelId === "string" ? parsed.responseChannelId : null,
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

let config = await loadConfig();

async function saveConfig(): Promise<void> {
  await mkdir(dirname(CONFIG_PATH), { recursive: true });
  await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", "utf8");
}

export function getResponseChannelId(): string | null {
  return config.responseChannelId;
}

export async function setResponseChannelId(channelId: string): Promise<void> {
  config.responseChannelId = channelId;
  await saveConfig();
}

export async function unsetResponseChannelId(): Promise<void> {
  config.responseChannelId = null;
  await saveConfig();
}
