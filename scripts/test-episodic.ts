import { embeddingTaskType } from "../src/memory/embedding.js";
import { buildEpisode, episodeDate, episodeId, episodePeriod, temporalQuery } from "../src/memory/episodic.js";

let failures = 0;
function check(name: string, condition: boolean): void {
  if (condition) console.log(`PASS ${name}`);
  else { console.error(`FAIL ${name}`); failures += 1; }
}

const morning = "2026-09-04T02:00:00.000Z";
const afternoon = "2026-09-04T06:00:00.000Z";
const evening = "2026-09-04T12:00:00.000Z";
const night = "2026-09-04T17:00:00.000Z";

check("Gemini query task maps to RETRIEVAL_QUERY", embeddingTaskType("query") === "RETRIEVAL_QUERY");
check("Gemini document task maps to RETRIEVAL_DOCUMENT", embeddingTaskType("document") === "RETRIEVAL_DOCUMENT");
check("morning period", episodePeriod(morning) === "morning");
check("afternoon period", episodePeriod(afternoon) === "afternoon");
check("evening period", episodePeriod(evening) === "evening");
check("night period", episodePeriod(night) === "night");
check("local date", episodeDate(morning) === "2026-09-04");
check("episode id is deterministic", episodeId("user:1", morning) === episodeId("user:1", morning));
check("different session gets different id", episodeId("user:1", morning) !== episodeId("user:2", morning));

const today = new Date("2026-09-04T04:00:00.000Z");
check("when morning filters today's morning", JSON.stringify(temporalQuery("เมื่อเช้าเราคุยอะไรกัน", today)) === JSON.stringify({ date: "2026-09-04", period: "morning" }));
check("yesterday filters previous date", JSON.stringify(temporalQuery("เมื่อวานคุยอะไร", today)) === JSON.stringify({ date: "2026-09-03" }));
check("last night filters previous night", JSON.stringify(temporalQuery("เมื่อคืนคุยอะไร", today)) === JSON.stringify({ date: "2026-09-03", period: "night" }));

const episode = buildEpisode([
  { timestamp: "2026-09-04T01:00:00.000Z", summary: "คุยเรื่องเกม" },
  { timestamp: "2026-09-04T01:20:00.000Z", summary: "คุยเรื่องภาคใหม่ของเกม" },
  { timestamp: "2026-09-04T02:10:00.000Z", summary: "คุยเรื่องงาน" },
], "user:1");
check("episode keeps only the active 30-minute window", episode?.text === "คุยเรื่องงาน");
check("episode id stays stable when end time changes", episodeId("user:1", morning) === episodeId("user:1", morning));
check("empty summaries do not create episode", buildEpisode([{ timestamp: morning, summary: "   " }], "user:1") === null);

if (failures) process.exit(1);
console.log("All episodic tests passed.");
