import { ChromaClient } from "chromadb";
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
