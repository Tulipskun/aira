import { strict as assert } from "node:assert";

process.env.GEMINI_API_KEY = "key1,key2";
delete process.env.GEMINI1_API_KEYS;
delete process.env.GEMINI2_API_KEYS;
delete process.env.GEMINI_EMBEDDING2_API_KEYS;

await import("../src/config.js");

assert.equal(process.env.GEMINI1_API_KEYS, "key1,key2");
assert.equal(process.env.GEMINI2_API_KEYS, "key1,key2");
assert.equal(process.env.GEMINI_EMBEDDING2_API_KEYS, "key1,key2");

console.log("shared Gemini API key config: OK");
