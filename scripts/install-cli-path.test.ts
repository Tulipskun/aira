import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { selectBinDir } from "./install-cli.js";

const root = mkdtempSync(join(tmpdir(), "aira-install-cli-path-"));
const pathBin = join(root, "path-bin");
mkdirSync(pathBin);

assert.equal(
  selectBinDir({ HOME: root, PATH: `${pathBin}:/usr/bin` }),
  pathBin,
);

const missingBin = join(root, "missing-bin");
assert.equal(
  selectBinDir({ HOME: root, PATH: `${missingBin}:/usr/bin` }),
  missingBin,
);

const prefixBin = join(root, "prefix", "bin");
mkdirSync(prefixBin, { recursive: true });
assert.equal(
  selectBinDir({ HOME: root, PREFIX: join(root, "prefix"), PATH: `${prefixBin}:/usr/bin` }),
  prefixBin,
);

console.log("install-cli path tests: OK");
