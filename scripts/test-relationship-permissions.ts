import { strict as assert } from "node:assert";
import { relationshipPermissions } from "../src/sql/bonds.js";

const permissions = (bond: string, xp: number, flirtCount = 0) =>
  relationshipPermissions(bond, xp, flirtCount);

// Permission is a hard semantic gate, independent of what the current rung looks like.
assert.deepEqual(permissions("close_friend", 499, 5), {
  lover: false,
  soulmate: false,
  sibling: false,
  family: false,
});

// Crossing the actual romantic gate enables lover acceptance.
assert.equal(permissions("crush", 700, 5).lover, true);
assert.equal(permissions("crush", 699, 5).lover, false);

// Soulmate has its own gate and still requires lover first.
assert.equal(permissions("lover", 999, 5).soulmate, false);
assert.equal(permissions("lover", 1000, 5).soulmate, true);
assert.equal(permissions("crush", 1000, 5).soulmate, false);

// Special relationships are independently permissioned by the same backend rules.
assert.equal(permissions("friend", 499).sibling, false);
assert.equal(permissions("friend", 500).sibling, true);
assert.equal(permissions("friend", 499).family, false);
assert.equal(permissions("friend", 500).family, true);

// Capped relationships cannot expose romantic acceptance permissions.
assert.equal(permissions("sibling", 1000, 10).lover, false);
assert.equal(permissions("family", 1000, 10).soulmate, false);

console.log("relationship permission tests passed");
