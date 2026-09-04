import { ChromaClient, type Where } from "chromadb";
import { embed } from "./embedding.js";
import { config } from "../config.js";
import { getHistory, type HistoryMessage } from "../sql/history.js";
import { thaiTimestamp } from "../gemini/time.js";

export type EpisodePeriod = "morning" | "afternoon" | "evening" | "night";

export type Episode = {
  id: string;
  text: string;
  sessionKey: string;
  date: string;
  period: EpisodePeriod;
  startTime: string;
  endTime: string;
  topic?: string;
  score?: number;
};

const chromaUrl = process.env.CHROMA_URL ?? "http://127.0.0.1:8000";
const parsedUrl = new URL(chromaUrl);
const client = new ChromaClient({
  host: parsedUrl.hostname,
  port: Number(parsedUrl.port || (parsedUrl.protocol === "https:" ? 443 : 80)),
  ssl: parsedUrl.protocol === "https:",
});

function localParts(timestamp: string): { date: string; hour: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: config.display.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(timestamp));
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "00";
  return { date: `${get("year")}-${get("month")}-${get("day")}`, hour: Number(get("hour")) };
}

export function episodePeriod(timestamp: string): EpisodePeriod {
  const { hour } = localParts(timestamp);
  if (hour >= 5 && hour < 12) return "morning";
  if (hour >= 12 && hour < 17) return "afternoon";
  if (hour >= 17 && hour < 22) return "evening";
  return "night";
}

export function episodeDate(timestamp: string): string {
  return localParts(timestamp).date;
}

function shiftLocalDate(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return shifted.toISOString().slice(0, 10);
}

export function episodeId(sessionKey: string, startTime: string): string {
  const input = `${sessionKey}\u0000${startTime}`;
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `episode-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export function temporalQuery(text: string, now = new Date()): { date?: string; period?: EpisodePeriod } {
  const query = text.toLowerCase();
  const today = episodeDate(now.toISOString());
  if (/(เมื่อเช้า|ตอนเช้า|เช้านี้|this morning)/u.test(query)) return { date: today, period: "morning" };
  if (/(เมื่อบ่าย|ตอนบ่าย|บ่ายนี้|this afternoon)/u.test(query)) return { date: today, period: "afternoon" };
  if (/(เมื่อเย็น|ตอนเย็น|เย็นนี้|this evening)/u.test(query)) return { date: today, period: "evening" };
  if (/(เมื่อคืน|ตอนกลางคืน|last night)/u.test(query)) return { date: shiftLocalDate(today, -1), period: "night" };
  if (/(คืนนี้|คืนนี้เอง|tonight)/u.test(query)) return { date: today, period: "night" };
  if (/(เมื่อวาน|วานนี้|yesterday)/u.test(query)) return { date: shiftLocalDate(today, -1) };
  if (/(วันนี้|วันนี้เอง|today)/u.test(query)) return { date: today };
  return {};
}

export function buildEpisode(
  summaries: Array<{ timestamp: string; summary: string }>,
  sessionKey: string,
): Episode | null {
  const usable = summaries
    .filter((item) => item.summary.trim())
    .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  if (!usable.length) return null;

  const selected: typeof usable = [usable[usable.length - 1]!];
  const gapMs = config.episode.gapMinutes * 60_000;
  for (let index = usable.length - 2; index >= 0; index -= 1) {
    const current = usable[index]!;
    const next = selected[0]!;
    if (episodeDate(current.timestamp) !== episodeDate(next.timestamp)) break;
    if (episodePeriod(current.timestamp) !== episodePeriod(next.timestamp)) break;
    if (Date.parse(next.timestamp) - Date.parse(current.timestamp) > gapMs) break;
    selected.unshift(current);
  }

  const first = selected[0]!;
  const last = selected[selected.length - 1]!;
  const period = episodePeriod(last.timestamp);
  const date = episodeDate(last.timestamp);
  return {
    id: episodeId(sessionKey, first.timestamp),
    text: selected.map((item) => item.summary.trim()).join(" "),
    sessionKey,
    date,
    period,
    startTime: first.timestamp,
    endTime: last.timestamp,
  };
}

async function collection() {
  return client.getOrCreateCollection({ name: config.episode.collection, embeddingFunction: null });
}

function similarityOf(distance: number | null | undefined): number {
  if (distance === null || distance === undefined || !Number.isFinite(distance)) return 1;
  return 1 - distance / 2;
}

function episodeWhere(sessionKey: string, temporal: { date?: string; period?: EpisodePeriod }): Where {
  const clauses: Where[] = [
    { sessionKey } as Where,
    ...(temporal.date ? [{ date: temporal.date } as Where] : []),
    ...(temporal.period ? [{ period: temporal.period } as Where] : []),
  ];
  if (clauses.length === 1) return clauses[0]!;
  return { $and: clauses } as unknown as Where;
}

export async function saveEpisode(episode: Episode): Promise<void> {
  const vector = await embed(episode.text, "document");
  await saveEpisodeVector(episode, vector);
}

export async function saveEpisodeVector(episode: Episode, vector: number[]): Promise<void> {
  await (await collection()).upsert({
    ids: [episode.id],
    embeddings: [vector],
    documents: [episode.text],
    metadatas: [{
      type: "episodic",
      sessionKey: episode.sessionKey,
      date: episode.date,
      period: episode.period,
      startTime: episode.startTime,
      endTime: episode.endTime,
    }],
  });
}

export async function buildRecentEpisode(sessionKey: string): Promise<Episode | null> {
  const history = getHistory(50, sessionKey);
  const summaries = history
    .filter((entry: HistoryMessage) => entry.role === "model" && Boolean(entry.summary?.trim()))
    .map((entry) => ({ timestamp: entry.timestamp, summary: entry.summary! }));
  return buildEpisode(summaries, sessionKey);
}

export async function recallEpisodes(
  vector: number[],
  sessionKey: string,
  queryText: string,
  limit = config.episode.maxResults,
  minSimilarity = config.episode.minSimilarity,
): Promise<Episode[]> {
  if (!limit) return [];
  const temporal = temporalQuery(queryText);
  const result = await (await collection()).query({
    queryEmbeddings: [vector],
    nResults: limit,
    where: episodeWhere(sessionKey, temporal),
    include: ["documents", "metadatas", "distances"],
  });
  const ids = result.ids?.[0] ?? [];
  const documents = result.documents?.[0] ?? [];
  const metadatas = result.metadatas?.[0] ?? [];
  const distances = result.distances?.[0] ?? [];
  return ids.map((id, index) => {
    const metadata = metadatas[index] as Record<string, unknown> | null | undefined;
    return {
      id,
      text: documents[index] ?? "",
      sessionKey: typeof metadata?.sessionKey === "string" ? metadata.sessionKey : sessionKey,
      date: typeof metadata?.date === "string" ? metadata.date : "",
      period: (typeof metadata?.period === "string" ? metadata.period : "night") as EpisodePeriod,
      startTime: typeof metadata?.startTime === "string" ? metadata.startTime : "",
      endTime: typeof metadata?.endTime === "string" ? metadata.endTime : "",
      score: similarityOf(distances[index]),
    };
  }).filter((episode) => (episode.score ?? 1) >= minSimilarity);
}

export function episodePromptMemory(episode: Episode): {
  text: string;
  timestamp: string;
  relevance: number;
  type: "episodic";
  period: EpisodePeriod;
  startTime: string;
  endTime: string;
} {
  return {
    text: episode.text,
    timestamp: thaiTimestamp(episode.startTime),
    relevance: Number((episode.score ?? 1).toFixed(2)),
    type: "episodic",
    period: episode.period,
    startTime: episode.startTime,
    endTime: episode.endTime,
  };
}

export async function episodicHeartbeat(): Promise<void> {
  await client.heartbeat();
}
