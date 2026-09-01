/**
 * Register (or update) the bot's slash commands.
 *
 * `/isla` has existed since `c9c778f` but was created by a throwaway script, so a fresh deploy had
 * no way to recreate it — and a subcommand the handler knows about but Discord never offered is a
 * feature that does not exist. This script is the missing piece, and it is idempotent, so it can be
 * re-run after every change to `ISLA_SUBCOMMANDS`.
 *
 *   bun run scripts/register-commands.ts            # write
 *   bun run scripts/register-commands.ts --dry-run  # show what would change, touch nothing
 *
 * Two Discord rules this script exists to respect, both learned from a real 400:
 *  - `PUT /applications/{app.id}/commands` is **replace-all for global commands**, so every other
 *    command is carried over from the GET response instead of being deleted.
 *  - A subcommand option (type 1) is **mutually exclusive with every other option type**, so the
 *    original free-text `/isla <args>` cannot coexist with `/isla join-group`. The text moved under
 *    `/isla say <args>`; the bare form is gone, and `handleSay` still answers it if a client sends it.
 *
 * Access fields (`default_member_permissions`, `dm_permission`) are copied from whatever is live
 * rather than invented here: this script changes what the command *offers*, not who may use it.
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

/**
 * Only the fields this script owns, in a fixed key order.
 *
 * Two reasons this is not a `JSON.stringify` of the object:
 *  - Discord adds computed fields (`id`, `version`, `application_id`) we never send, and
 *  - Discord returns option keys in a **different order** than the payload was sent in (`type`
 *    before `name`), so a raw stringify of an identical command never compares equal and the script
 *    would PUT on every run.
 * Recursing into `options` is what makes a subcommand's own arguments part of the comparison.
 */
function comparable(command: Record<string, unknown>): string {
  return JSON.stringify({
    name: command.name,
    description: command.description,
    default_member_permissions: command.default_member_permissions ?? null,
    dm_permission: command.dm_permission ?? null,
    options: ((command.options ?? []) as Record<string, unknown>[]).map(optionShape),
  });
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

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const application = await api<{ id: string }>("GET", "/applications/@me");
  const existing = await api<RemoteCommand[]>("GET", `/applications/${application.id}/commands`);
  const current = existing.find((command) => command.name === ISLA_COMMAND_NAME);
  const others = existing.filter((command) => command.name !== ISLA_COMMAND_NAME);

  const command = {
    ...islaCommandPayload(),
    // Preserve live access settings; a command registration should not quietly change permissions.
    default_member_permissions: current?.default_member_permissions ?? null,
    dm_permission: current?.dm_permission ?? true,
  };

  if (current && comparable(current as unknown as Record<string, unknown>) === comparable(command)) {
    console.log(`[COMMANDS] /${ISLA_COMMAND_NAME} already up to date (id ${current.id})`);
    return;
  }

  console.log(
    `[COMMANDS] ${current ? "updating" : "creating"} /${ISLA_COMMAND_NAME} with ` +
    `${(command.options ?? []).length} option(s)/subcommand(s)` +
    `${others.length ? `, preserving ${others.length} other command(s)` : ""}`,
  );
  if (dryRun) {
    console.log("[COMMANDS] --dry-run: nothing sent");
    console.log(JSON.stringify(command, null, 2));
    return;
  }

  // Replace-all, so unknown commands must be carried over or they disappear.
  const written = await api<RemoteCommand[]>("PUT", `/applications/${application.id}/commands`, [...others, command]);
  const saved = written.find((item) => item.name === ISLA_COMMAND_NAME);
  console.log(`[COMMANDS] done: ${written.length} global command(s), /${ISLA_COMMAND_NAME} = ${saved?.id ?? "MISSING"}`);
}

await main();
