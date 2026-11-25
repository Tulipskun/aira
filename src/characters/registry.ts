import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export type Character = {
  id: string;
  name: string;
  aliases: string[];
  promptFile: string;
  enabled: boolean;
};

const ROOT = resolve(import.meta.dirname, "..", "..");
const DIRECTORY = join(ROOT, "characters");

function validate(value: unknown, file: string): Character {
  if (!value || typeof value !== "object") throw new Error("Invalid character definition: " + file);
  const item = value as Record<string, unknown>;
  if (typeof item.id !== "string" || !/^[a-z0-9_-]{1,32}$/.test(item.id)) throw new Error("Invalid character id: " + file);
  if (typeof item.name !== "string" || !item.name.trim()) throw new Error("Invalid character name: " + file);
  if (typeof item.promptFile !== "string" || !item.promptFile.trim()) throw new Error("Invalid promptFile: " + file);
  const aliases = Array.isArray(item.aliases) ? item.aliases.filter((entry): entry is string => typeof entry === "string") : [];
  return { id: item.id, name: item.name, aliases: [item.name, ...aliases], promptFile: resolve(DIRECTORY, item.promptFile), enabled: item.enabled !== false };
}

export function loadCharacters(): Character[] {
  const files = readdirSync(DIRECTORY).filter((file) => file.endsWith(".json")).sort();
  const characters = files.map((file) => validate(JSON.parse(readFileSync(join(DIRECTORY, file), "utf8")), file)).filter((item) => item.enabled);
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const character of characters) {
    if (ids.has(character.id)) throw new Error("Duplicate character id: " + character.id);
    ids.add(character.id);
    for (const alias of character.aliases) {
      const normalized = alias.toLocaleLowerCase();
      if (names.has(normalized)) throw new Error("Duplicate character alias: " + alias);
      names.add(normalized);
    }
  }
  if (!ids.has("isla")) throw new Error("The Isla character definition is required.");
  return characters;
}

export function characterSessionKey(sessionKey: string, characterId: string): string {
  return characterId === "isla" ? sessionKey : sessionKey + ":character:" + characterId;
}

export function loadCharacterPrompt(character: Character): string {
  return readFileSync(character.promptFile, "utf8").trim();
}

export function findMentionedCharacters(text: string, characters: Character[]): Character[] {
  const normalized = text.toLocaleLowerCase();
  return characters.filter((character) => character.aliases.some((alias) => normalized.includes(alias.toLocaleLowerCase())));
}

export function resolveCharacterSelection(characters: Character[], mentioned: Character[], selectedIds: string[]): Character[] {
  const byId = new Map(characters.map((character) => [character.id, character]));
  const chosen = [...mentioned, ...selectedIds.map((id) => byId.get(id)).filter((item): item is Character => Boolean(item))]
    .filter((character, index, all) => all.findIndex((item) => item.id === character.id) === index)
    .slice(0, 2);
  const isla = characters.find((character) => character.id === "isla");
  if (!isla) throw new Error("The Isla character definition is required.");
  return [isla, ...chosen.filter((character) => character.id !== "isla")].slice(0, 2);
}
