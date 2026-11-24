import { ChromaClient, type Where } from "chromadb";
import { embed } from "./embedding.js";
import { config } from "../config.js";
import { LEGACY_SESSION_KEY, userSessionKey } from "../session-keys.js";

const chromaUrl = process.env.CHROMA_URL ?? "http://127.0.0.1:8000";
const parsedUrl = new URL(chromaUrl);
const client = new ChromaClient({
  host: parsedUrl.hostname,
  port: Number(parsedUrl.port || (parsedUrl.protocol === "https:" ? 443 : 80)),
  ssl: parsedUrl.protocol === "https:",
});
const collectionName = process.env.CHROMA_COLLECTION ?? "aira_memories";

type Primitive = string | number | boolean | null;
export type Memory = {
  id: string;
  text: string;
  userId?: string;
  timestamp?: string;
  sessionKey?: string;
  metadata?: Record<string, Primitive>;
  score?: number;
};

export function similarityOf(distance: number | null | undefined, space: "l2" | "cosine" | "ip" | "unknown" = "l2"): number {
  if (distance === null || distance === undefined || !Number.isFinite(distance)) return 1;
  if (space === "cosine" || space === "ip") return 1 - distance;
  return 1 - distance / 2;
}

async function collection() {
  return client.getOrCreateCollection({ name: collectionName, embeddingFunction: null });
}

export async function saveMemory(memory: Memory): Promise<void> {
  const vector = await embed(memory.text, "document");
  await saveMemoryVector(memory, vector);
}

export async function saveMemoryVector(memory: Memory, vector: number[]): Promise<void> {
  await (await collection()).upsert({
    ids: [memory.id],
    embeddings: [vector],
    documents: [memory.text],
    metadatas: [{
      ...(memory.userId && { userId: memory.userId }),
      ...(memory.timestamp && { timestamp: memory.timestamp }),
      ...(memory.sessionKey && { sessionKey: memory.sessionKey }),
      ...memory.metadata,
    }],
  });
}

export async function searchMemories(text: string, limit = 5, sessionKey?: string): Promise<Memory[]> {
  return searchMemoriesByVector(await embed(text, "query"), limit, sessionKey);
}

function primitiveMetadata(value: unknown): Record<string, Primitive> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const result: Record<string, Primitive> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item === null || typeof item === "string" || typeof item === "number" || typeof item === "boolean") result[key] = item;
  }
  return Object.keys(result).length ? result : undefined;
}

export async function searchMemoriesByVector(vector: number[], limit = 5, sessionKey?: string): Promise<Memory[]> {
  const result = await (await collection()).query({
    queryEmbeddings: [vector],
    nResults: limit,
    ...(sessionKey ? { where: { sessionKey } as Where } : {}),
    include: ["documents", "metadatas", "distances"],
  });
  const ids = result.ids?.[0] ?? [];
  const documents = result.documents?.[0] ?? [];
  const metadatas = result.metadatas?.[0] ?? [];
  const distances = result.distances?.[0] ?? [];
  return ids.map((id, index) => ({
    id,
    text: documents[index] ?? "",
    userId: typeof metadatas[index]?.userId === "string" ? metadatas[index]!.userId : undefined,
    timestamp: typeof metadatas[index]?.timestamp === "string" ? metadatas[index]!.timestamp : undefined,
    sessionKey: typeof metadatas[index]?.sessionKey === "string" ? metadatas[index]!.sessionKey : undefined,
    metadata: primitiveMetadata(metadatas[index]),
    score: similarityOf(distances[index]),
  }));
}

export async function recallMemories(
  vector: number[],
  sessionKey: string,
  limit = config.memory.maxResults,
  minSimilarity = config.memory.minSimilarity,
): Promise<Memory[]> {
  if (!limit) return [];
  const found = await searchMemoriesByVector(vector, limit, sessionKey);
  return found.filter((memory) => (memory.score ?? 1) >= minSimilarity);
}

export async function isDuplicateMemory(
  vector: number[],
  sessionKey: string | undefined,
  minSimilarity = config.memory.dedupeSimilarity,
): Promise<Memory | null> {
  if (!sessionKey) return null;
  const found = await searchMemoriesByVector(vector, 1, sessionKey);
  const top = found[0];
  return top && (top.score ?? 1) >= minSimilarity ? top : null;
}

export async function chromaHeartbeat(): Promise<void> {
  await client.heartbeat();
}

export async function migrateMemorySessions(): Promise<{ backfilled: number; unattributed: number; alreadyKeyed: number }> {
  const col = await collection();
  const all = await col.get({ include: ["metadatas", "embeddings", "documents"] });
  const ids = all.ids;
  const metadatas = (all.metadatas ?? []) as (Record<string, Primitive> | null)[];
  const embeddings = all.embeddings ?? [];
  const documents = all.documents ?? [];

  const pending: { id: string; metadata: Record<string, Primitive>; index: number }[] = [];
  let alreadyKeyed = 0;
  let unattributed = 0;
  ids.forEach((id, index) => {
    const metadata = metadatas[index];
    if (metadata?.sessionKey) { alreadyKeyed += 1; return; }
    const userId = typeof metadata?.userId === "string" ? metadata.userId : "";
    if (!userId) unattributed += 1;
    pending.push({
      id,
      metadata: { ...(metadata ?? {}), sessionKey: userId ? userSessionKey(userId) : LEGACY_SESSION_KEY },
      index,
    });
  });
  if (!pending.length) return { backfilled: 0, unattributed: 0, alreadyKeyed };

  const complete = embeddings.length === ids.length;
  if (complete) {
    await col.upsert({
      ids: pending.map((item) => item.id),
      metadatas: pending.map((item) => item.metadata),
      documents: pending.map((item) => documents[item.index] ?? ""),
      embeddings: pending.map((item) => embeddings[item.index] as number[]),
    });
  } else {
    for (const item of pending) {
      await col.upsert({
        ids: [item.id],
        metadatas: [item.metadata],
        documents: [documents[item.index] ?? ""],
        ...(embeddings[item.index] ? { embeddings: [embeddings[item.index] as number[]] } : {}),
      });
    }
  }
  return { backfilled: pending.length, unattributed, alreadyKeyed };
}

export type MemoryFilter = { userId?: string; sessionKey?: string; ids?: string[]; limit?: number };

function memoryWhere(filter: MemoryFilter): Where {
  if (!filter.userId && !filter.sessionKey) throw new Error("memoryWhere needs a userId or sessionKey");
  const clauses: Where[] = [
    ...(filter.userId ? [{ userId: filter.userId } as Where] : []),
    ...(filter.sessionKey ? [{ sessionKey: filter.sessionKey } as Where] : []),
  ];
  if (clauses.length === 1) return clauses[0]!;
  return { $and: clauses } as unknown as Where;
}

function toMemory(id: string, document: string | null | undefined, metadata: Record<string, Primitive> | null | undefined): Memory {
  return {
    id,
    text: document ?? "",
    userId: typeof metadata?.userId === "string" ? metadata.userId : undefined,
    timestamp: typeof metadata?.timestamp === "string" ? metadata.timestamp : undefined,
    sessionKey: typeof metadata?.sessionKey === "string" ? metadata.sessionKey : undefined,
    metadata: metadata ?? undefined,
  };
}

async function resolveMemoryIds(filter: MemoryFilter): Promise<string[]> {
  const col = await collection();
  if (filter.ids?.length) {
    const found = await col.get({ ids: filter.ids, include: ["metadatas"] });
    if (!filter.userId && !filter.sessionKey) return found.ids;
    const metadatas = found.metadatas ?? [];
    return found.ids.filter((id, index) => {
      const meta = metadatas[index] as Record<string, Primitive> | null | undefined;
      if (filter.userId && meta?.userId !== filter.userId) return false;
      if (filter.sessionKey && meta?.sessionKey !== filter.sessionKey) return false;
      return true;
    });
  }
  const found = await col.get({ ...(filter.userId || filter.sessionKey ? { where: memoryWhere(filter) } : {}), include: [] });
  return found.ids;
}

function hasMemoryFilter(filter: MemoryFilter): boolean {
  return Boolean(filter.userId || filter.sessionKey || filter.ids?.length);
}

export async function countMemories(filter: MemoryFilter = {}): Promise<number> {
  if (!hasMemoryFilter(filter)) return (await collection()).count();
  return (await resolveMemoryIds(filter)).length;
}

export async function listMemories(filter: MemoryFilter = {}): Promise<Memory[]> {
  let ids = await resolveMemoryIds(filter);
  if (filter.limit) ids = ids.slice(-filter.limit);
  if (!ids.length) return [];
  const found = await (await collection()).get({ ids, include: ["documents", "metadatas"] });
  const documents = found.documents ?? [];
  const metadatas = found.metadatas ?? [];
  return found.ids.map((id, index) => toMemory(id, documents[index], metadatas[index] as Record<string, Primitive> | null | undefined));
}

export async function deleteMemories(filter: MemoryFilter = {}): Promise<number> {
  if (!hasMemoryFilter(filter)) throw new Error("deleteMemories refuses to delete everything without a filter -- pass --all explicitly");
  const ids = await resolveMemoryIds(filter);
  if (!ids.length) return 0;
  await (await collection()).delete({ ids });
  return ids.length;
}

export async function clearMemories(): Promise<number> {
  const col = await collection();
  const total = await col.count();
  if (!total) return 0;
  const { ids } = await col.get({ include: [] });
  await col.delete({ ids });
  return ids.length;
}
