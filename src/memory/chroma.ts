import { ChromaClient, type Where } from "chromadb";
import { embed } from "./embedding.js";

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
  metadata?: Record<string, Primitive>;
};

async function collection() {
  return client.getOrCreateCollection({ name: collectionName, embeddingFunction: null });
}

export async function saveMemory(memory: Memory): Promise<void> {
  const vector = await embed(memory.text);
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
      ...memory.metadata,
    }],
  });
}

export async function searchMemories(text: string, limit = 5): Promise<Memory[]> {
  return searchMemoriesByVector(await embed(text), limit);
}

function primitiveMetadata(value: unknown): Record<string, Primitive> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const result: Record<string, Primitive> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item === null || typeof item === "string" || typeof item === "number" || typeof item === "boolean") result[key] = item;
  }
  return Object.keys(result).length ? result : undefined;
}

export async function searchMemoriesByVector(vector: number[], limit = 5): Promise<Memory[]> {
  const result = await (await collection()).query({
    queryEmbeddings: [vector],
    nResults: limit,
    include: ["documents", "metadatas", "distances"],
  });
  const ids = result.ids?.[0] ?? [];
  const documents = result.documents?.[0] ?? [];
  const metadatas = result.metadatas?.[0] ?? [];
  return ids.map((id, index) => ({
    id,
    text: documents[index] ?? "",
    userId: typeof metadatas[index]?.userId === "string" ? metadatas[index]!.userId : undefined,
    timestamp: typeof metadatas[index]?.timestamp === "string" ? metadatas[index]!.timestamp : undefined,
    metadata: primitiveMetadata(metadatas[index]),
  }));
}

export async function chromaHeartbeat(): Promise<void> {
  await client.heartbeat();
}

export type MemoryFilter = { userId?: string; ids?: string[]; limit?: number };

function memoryWhere(filter: MemoryFilter): Where {
  if (!filter.userId) throw new Error("memoryWhere needs a userId");
  return { userId: filter.userId };
}

function toMemory(id: string, document: string | null | undefined, metadata: Record<string, Primitive> | null | undefined): Memory {
  return {
    id,
    text: document ?? "",
    userId: typeof metadata?.userId === "string" ? metadata.userId : undefined,
    timestamp: typeof metadata?.timestamp === "string" ? metadata.timestamp : undefined,
    metadata: metadata ?? undefined,
  };
}

async function resolveMemoryIds(filter: MemoryFilter): Promise<string[]> {
  const col = await collection();
  if (filter.ids?.length) {
    const found = await col.get({ ids: filter.ids, include: ["metadatas"] });
    if (!filter.userId) return found.ids;
    const metadatas = found.metadatas ?? [];
    return found.ids.filter((id, index) => metadatas[index]?.userId === filter.userId);
  }
  const found = await col.get({ ...(filter.userId ? { where: memoryWhere(filter) } : {}), include: [] });
  return found.ids;
}

export async function countMemories(filter: MemoryFilter = {}): Promise<number> {
  if (!filter.userId && !filter.ids?.length) return (await collection()).count();
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
  if (!filter.userId && !filter.ids?.length) throw new Error("deleteMemories refuses to delete everything without a filter -- pass --all explicitly");
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
