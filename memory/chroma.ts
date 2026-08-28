import { ChromaClient } from "chromadb";
import { embed } from "./embedding";

const client = new ChromaClient({
  host: process.env.CHROMA_HOST ?? "localhost",
  port: Number(process.env.CHROMA_PORT ?? 8000),
  ssl: process.env.CHROMA_SSL === "true",
});
const collectionName = process.env.CHROMA_COLLECTION ?? "aira_memories";

export type Memory = {
  id: string;
  text: string;
  userId?: string;
  timestamp?: string;
  metadata?: Record<string, string | number | boolean | null>;
};

async function collection() {
  return client.getOrCreateCollection({ name: collectionName });
}

export async function saveMemory(memory: Memory): Promise<void> {
  const vector = await embed(memory.text);
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
  const vector = await embed(text);
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
    userId: typeof metadatas[index]?.userId === "string" ? metadatas[index]!.userId as string : undefined,
    timestamp: typeof metadatas[index]?.timestamp === "string" ? metadatas[index]!.timestamp as string : undefined,
    metadata: metadatas[index] ?? undefined,
  }));
}

export async function chromaHeartbeat(): Promise<void> {
  await client.heartbeat();
}
