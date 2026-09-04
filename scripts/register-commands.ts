/**
 * Register (or update) the bot's slash commands.
 *
 * Registration is intentionally a separate operation. Do not call this from bot startup/restart;
 * Discord command registration is a deployment/configuration action, not a runtime action.
 *
 *   bun run scripts/register-commands.ts            # write
 *   bun run scripts/register-commands.ts --dry-run  # show what would change, touch nothing
 *
 * `PUT /applications/{app.id}/commands` is replace-all for global commands, so every other command
 * is carried over from the GET response instead of being deleted.
 *
 * Access fields (`default_member_permissions`, `dm_permission`) are copied from whatever is live
 * rather than invented here: this script changes what the command offers, not who may use it.
 */
import "dotenv/config";
import { ISLA_COMMAND_NAME, ISLA_SUBCOMMANDS, islaCommandPayload } from "../src/bot/interactions.js";

const token = process.env.ISLA_TOKEN;
if (!token) throw new Error("ISLA_TOKEN is required");

const API = "https://discord.com/api/v10";

type RemoteCommand = {
  id?: string;
  name: string;
  description?: string;
  default_member_permissions?: string | null;
  dm_permission?: boolean;
};

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${method} ${path} -> ${response.status} ${text.slice(0, 400)}`);
  }
  return (await response.json()) as T;
}

type OptionShape = {
  name: unknown;
  description: unknown;
  type: unknown;
  required: unknown;
  options: OptionShape[];
};

function optionShape(option: Record<string, unknown>): OptionShape {
  return {
    name: option.name,
    description: option.description,
    type: option.type,
    required: option.required ?? false,
    options: ((option.options ?? []) as Record<string, unknown>[]).map(optionShape),
  };
}

function comparable(command: Record<string, unknown>): string {
  return JSON.stringify({
    name: command.name,
    description: command.description,
    default_member_permissions: command.default_member_permissions ?? null,
    dm_permission: command.dm_permission ?? null,
    options: ((command.options ?? []) as Record<string, unknown>[]).map(optionShape),
  });
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const application = await api<{ id: string }>("GET", "/applications/@me");
  const existing = await api<RemoteCommand[]>("GET", `/applications/${application.id}/commands`);
  const current = existing.find((command) => command.name === ISLA_COMMAND_NAME);
  const others = existing.filter((command) => command.name !== ISLA_COMMAND_NAME);

  const command = {
    ...islaCommandPayload(),
    default_member_permissions: current?.default_member_permissions ?? null,
    dm_permission: current?.dm_permission ?? true,
  };

  if (current && comparable(current as unknown as Record<string, unknown>) === comparable(command)) {
    console.log(`[COMMANDS] /${ISLA_COMMAND_NAME} already up to date (id ${current.id})`);
    return;
  }

  console.log(
    `[COMMANDS] ${current ? "updating" : "creating"} /${ISLA_COMMAND_NAME} with ` +
    `${(command.options ?? []).length} subcommand(s)` +
    `${others.length ? `, preserving ${others.length} other command(s)` : ""}`,
  );
  if (dryRun) {
    console.log("[COMMANDS] --dry-run: nothing sent");
    console.log(JSON.stringify(command, null, 2));
    return;
  }

  const written = await api<RemoteCommand[]>("PUT", `/applications/${application.id}/commands`, [...others, command]);
  const saved = written.find((item) => item.name === ISLA_COMMAND_NAME);
  console.log(`[COMMANDS] done: ${written.length} global command(s), /${ISLA_COMMAND_NAME} = ${saved?.id ?? "MISSING"}`);
}

await main();
