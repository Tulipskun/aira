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

console.log("install-cli path tests: OK");
