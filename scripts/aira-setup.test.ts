import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  normalizeApiKeys,
  updateEnvFile,
  shouldConfigureModels,
} from "./aira-setup.js";

assert.equal(normalizeApiKeys(" key1, key2 ,   key3 "), "key1,key2,key3");
assert.equal(normalizeApiKeys("key1,, key2,   "), "key1,key2");
assert.equal(normalizeApiKeys("   "), "");

assert.equal(shouldConfigureModels(""), false);
assert.equal(shouldConfigureModels("n"), false);
assert.equal(shouldConfigureModels("N"), false);
assert.equal(shouldConfigureModels("y"), true);
assert.equal(shouldConfigureModels("Y"), true);

const root = mkdtempSync(join(tmpdir(), "aira-setup-"));
const envFile = join(root, ".env");
writeFileSync(envFile, "ISLA_TOKEN=old-token\nDISCORD_OWNER_ID=123\nGEMINI_API_KEY=old1,old2\nGEMINI1_MODEL=old-model\nOTHER=value\n");

updateEnvFile(envFile, {
  ISLA_TOKEN: "new-token",
  DISCORD_OWNER_ID: "456",
  GEMINI_API_KEY: normalizeApiKeys(" key1, key2 ,key3 "),
  GEMINI1_MODEL: "gemini-new",
  GEMINI2_MODEL: "gemini-state",
  GEMINI_EMBEDDING2_MODEL: "gemini-embedding-new",
});

const content = readFileSync(envFile, "utf8");
assert.match(content, /^ISLA_TOKEN=new-token$/m);
assert.match(content, /^DISCORD_OWNER_ID=456$/m);
assert.match(content, /^GEMINI_API_KEY=key1,key2,key3$/m);
assert.match(content, /^GEMINI1_MODEL=gemini-new$/m);
assert.match(content, /^GEMINI2_MODEL=gemini-state$/m);
assert.match(content, /^GEMINI_EMBEDDING2_MODEL=gemini-embedding-new$/m);
assert.match(content, /^OTHER=value$/m);

console.log("aira-setup tests: OK");
