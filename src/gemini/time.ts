/**
 * Timestamps stay in UTC everywhere they are *stored* (SQLite, Chroma) — that is the only sane
 * storage format: sortable, comparable, DST-proof. But the model must not be asked to do
 * timezone arithmetic, and an ISO `...Z` string silently teaches it to answer Yuuta in the wrong
 * hour, since he is in Thailand.
 *
 * So every timestamp that leaves this process *toward a prompt* goes through `thaiTimestamp()`,
 * which renders the same instant as Thailand local time with an explicit numeric offset:
 *
 *   "2026-08-30T20:01:47.957Z"  ->  "2026-08-31T03:01:47+07:00"
 *
 * The offset is kept in the output on purpose. A bare "2026-08-31 03:01:47" is a wall clock with
 * no zone, and a model that assumes UTC is then 7 hours off in exactly the direction that
 * matters. `+07:00` makes the reading unambiguous while still letting the model convert when a
 * user asks about another country.
 *
 * The offset comes from `Intl`, not a hardcoded +7, so changing ISLA_TIMEZONE to a zone with DST
 * keeps working. Asia/Bangkok itself has had no DST since 1920.
 */

import { config } from "../config.js";

/** The zone prompts are rendered in. Override with ISLA_TIMEZONE (see config.display.timezone). */
export const TIMEZONE_LABEL = config.display.timezone;

/**
 * Build a renderer for an arbitrary zone. `thaiTimestamp` below is this bound to
 * TIMEZONE_LABEL; the factory exists so tests can assert that the offset is genuinely derived
 * from Intl (a half-hour zone like Asia/Kolkata is impossible to fake with a "+07:00" constant).
 */
export function createTimestampFormatter(zone: string): (timestamp: string | null | undefined) => string {
  // `hour12: false` can still render midnight as "24" on some ICU builds; normalised below.
  // `longOffset` gives "GMT+07:00", "GMT-04:00", or plain "GMT" for UTC itself.
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZoneName: "longOffset",
  });

  return function renderTimestamp(timestamp: string | null | undefined): string {
    if (!timestamp) return "";
    const date = new Date(timestamp);
    // Anything that is not a real instant is returned unchanged: rows written by older code,
    // empty strings, and synthetic test timestamps all pass through rather than becoming
    // "Invalid Date" inside a prompt.
    if (Number.isNaN(date.getTime())) return timestamp;

    const parts: Record<string, string> = {};
    for (const part of formatter.formatToParts(date)) parts[part.type] = part.value;

    const hour = parts.hour === "24" ? "00" : (parts.hour ?? "00");
    return `${parts.year}-${parts.month}-${parts.day}T${hour}:${parts.minute ?? "00"}:${parts.second ?? "00"}${offsetOf(parts.timeZoneName)}`;
  };
}

/** "+07:00" / "-04:00" / "+00:00" from an Intl longOffset label like "GMT+07:00". */
function offsetOf(timeZoneName: string | undefined): string {
  const match = /GMT([+-])(\d{2})(?::(\d{2}))?$/.exec(timeZoneName ?? "");
  if (!match) return "+00:00";
  return `${match[1]}${match[2]}:${match[3] ?? "00"}`;
}

/** Render a stored (UTC) timestamp as Thailand local time, ready to put in front of the model. */
export const thaiTimestamp = createTimestampFormatter(TIMEZONE_LABEL);
