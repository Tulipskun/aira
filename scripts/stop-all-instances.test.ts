import { strict as assert } from "node:assert";
import { parseProcessTable, selectAiraProcesses } from "./stop-all-instances.js";

const table = `
  7318 bun run scripts/daemon.ts
  8170 /root/.local/share/aira/.aira/chroma-venv/bin/chroma run --path /root/.local/share/aira/.aira/chroma --host 127.0.0.1 --port 8000
  8198 bun run src/bot/bot.ts
  9201 bun run scripts/daemon.ts
  9250 bun run src/bot/bot.ts
  9999 bun run scripts/not-aira.ts
`;

const processes = parseProcessTable(table);
assert.deepEqual(selectAiraProcesses(processes), [
  { pid: 7318, kind: "daemon" },
  { pid: 8170, kind: "chroma" },
  { pid: 8198, kind: "bot" },
  { pid: 9201, kind: "daemon" },
  { pid: 9250, kind: "bot" },
]);

assert.deepEqual(selectAiraProcesses(parseProcessTable("1234 bun run scripts/not-aira.ts")), []);

console.log("stop-all-instances tests: OK");
