import { strict as assert } from "node:assert";
import { CRUSH_XP_THRESHOLD, FLIRT_REQUIREMENT, FLIRT_XP_BONUS, deriveBond } from "../src/sql/bonds.js";

assert.equal(CRUSH_XP_THRESHOLD, 500);
assert.equal(FLIRT_REQUIREMENT, 5);
assert.equal(FLIRT_XP_BONUS, 25);

assert.equal(deriveBond("close_friend", 499, { flirtCount: 5 }).bond, "close_friend");
assert.equal(deriveBond("close_friend", 500, { flirtCount: 4 }).bond, "close_friend");
assert.equal(deriveBond("close_friend", 500, { flirtCount: 5 }).bond, "crush");
assert.equal(deriveBond("close_friend", 999999, { flirtCount: 5 }).bond, "crush");
assert.match(deriveBond("close_friend", 500, { flirtCount: 5 }).reason, /500/);

// A lover proposal is only valid after both crush gates are actually satisfied.
assert.equal(deriveBond("crush", 499, { flirtCount: 5, approvals: { lover: true } }).bond, "crush");
assert.equal(deriveBond("crush", 500, { flirtCount: 4, approvals: { lover: true } }).bond, "crush");
assert.equal(deriveBond("crush", 500, { flirtCount: 5, approvals: { lover: true } }).bond, "lover");

// A proposal cannot jump from a lower rung directly to lover/soulmate.
assert.notEqual(deriveBond("stranger", 500, { flirtCount: 5, approvals: { lover: true } }).bond, "lover");
assert.notEqual(deriveBond("friend", 500, { flirtCount: 5, approvals: { soulmate: true } }).bond, "soulmate");

// XP is a leaderboard score and must not be capped by the relationship ladder.
assert.equal(deriveBond("crush", 999999, { flirtCount: 5 }).xp, 999999);

console.log("relationship-v2 tests: OK");
