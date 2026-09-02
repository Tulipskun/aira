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
  /**
   * Conversation stream this memory belongs to (`user:<id>` / `group:<channel>`). Memories are
   * retrieved by similarity inside ONE session, so this is what keeps a fact Yuuta told Isla out of
   * Farris's context. `userId` stays as *who it is about*; the two differ in a group session.
   */
  sessionKey?: string;
  metadata?: Record<string, Primitive>;
  /**
   * Cosine similarity to the query, 0..1, filled in by `searchMemoriesByVector` only.
   *
   * It exists because "the 8 nearest" is not the same question as "the relevant ones": without a
   * score a caller cannot tell a 0.81 match from a 0.32 one, and both were handed to the model as
   * fact. Absent on rows that were never searched (list/get/forget paths).
   */
  score?: number;
};

/**
 * Turn Chroma's reported distance into a cosine similarity.
 *
 * The collection's HNSW space is `l2` (Chroma's default), and Gemini's embeddings come back
 * unit-normalised (measured: norm 1.000000 on every stored row), so squared Euclidean distance and
 * cosine are two views of one number: `d² = 2 − 2·cos`. Chroma returns the squared value — verified
 * against a hand-recomputed L2² — so the square root some clients take is *not* the distance to use
 * here. Unknown spaces fall back to treating the value as cosine already, which is what a
 * `cosine`-space collection reports.
 */
export function similarityOf(distance: number | null | undefined, space: "l2" | "cosine" | "ip" | "unknown" = "l2"): number {
  if (distance === null || distance === undefined || !Number.isFinite(distance)) return 1;
  if (space === "cosine" || space === "ip") return 1 - distance;
  return 1 - distance / 2;
}

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
      ...(memory.sessionKey && { sessionKey: memory.sessionKey }),
      ...memory.metadata,
    }],
  });
}

export async function searchMemories(text: string, limit = 5, sessionKey?: string): Promise<Memory[]> {
  return searchMemoriesByVector(await embed(text), limit, sessionKey);
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
    // Scoped inside the session, so a private conversation's memories never surface in someone
    // else's context. Omitted only by callers that deliberately want the whole collection (tests,
    // the forget CLI's count).
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

/**
 * The pipeline's recall path: nearest neighbours **that actually clear a similarity bar**.
 *
 * `searchMemoriesByVector` alone was the wrong primitive for a chat prompt. It returns the top N
 * whatever they score, so while the collection held six rows every turn got six "memories" — and
 * the ones handed to Isla while a stranger was flirting with her were another user's marriage
 * proposals, at cosine 0.42–0.49, i.e. no better than chance. She then declined the newcomer by
 * quoting them. Returning nothing is a real answer, and a much better one than eight near-misses.
 */
export async function recallMemories(
  vector: number[],
  sessionKey: string,
  limit = config.memory.maxResults,
  minSimilarity = config.memory.minSimilarity,
): Promise<Memory[]> {
  if (!limit) return [];
  // Ask for the full window before filtering: Chroma ranks, so dropping low scores afterwards from
  // a larger candidate set cannot lose a good match that happened to sit at rank 7.
  const found = await searchMemoriesByVector(vector, limit, sessionKey);
  return found.filter((memory) => (memory.score ?? 1) >= minSimilarity);
}

/**
 * True when this session already holds a memory that says the same thing.
 *
 * Nothing deduplicated on write, so one marriage proposal became two rows within two minutes, and
 * each duplicate took a slot the model could have spent on something else. Embeddings are compared
 * rather than text because the model rephrases; `minSimilarity` is deliberately far above the recall
 * threshold — this is "same memory", not "related topic".
 */
export async function isDuplicateMemory(
  vector: number[],
  sessionKey: string | undefined,
  minSimilarity = config.memory.dedupeSimilarity,
): Promise<Memory | null> {
  // Unscoped is not "search everything": an unfiltered match would let one person's memory swallow
  // another's identical-sounding fact. No key means no dedupe, and the write proceeds.
  if (!sessionKey) return null;
  const found = await searchMemoriesByVector(vector, 1, sessionKey);
  const top = found[0];
  return top && (top.score ?? 1) >= minSimilarity ? top : null;
}


export async function chromaHeartbeat(): Promise<void> {
  await client.heartbeat();
}

/**
 * Give every pre-scoping memory a `sessionKey`.
 *
 * Memories were already tagged with `userId`, so the backfill is exact rather than a guess: a
 * private session key is derived from the author. A memory with no `userId` at all (only ever
 * writable by hand) goes to the same unattributed bucket history uses, and is never retrieved.
 *
 * Idempotent — rows that already carry the key are skipped, so a restart mid-migration is safe.
 * Embeddings are untouched (only metadata changes), so vectors stay comparable.
 */
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

  // Chroma's upsert requires every array to align by index, so a missing embedding cannot simply be
  // filtered out of one array — that would shift every later vector onto the wrong document. If any
  // is absent, fall back to one upsert per memory, which is slower but always correct.
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
  // A where-map may hold **exactly one operator** — `chromadb`'s `validateWhere` throws
  // "Expected 'where' to have exactly one operator" on a flat two-key map. So combining "this
  // person" with "inside this session" needs `$and`, which is also what makes the pair mean AND
  // rather than whichever single key the server happened to read first.
  //
  // `$and` itself requires at least two clauses, hence the length check rather than always wrapping.
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

/**
 * True when a filter names something. Every destructive call refuses without one, and
 * `sessionKey` now counts as a filter — a whole shared room is a legitimate target.
 */
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
