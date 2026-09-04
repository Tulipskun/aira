import { strict as assert } from "node:assert";
import {
  CRUSH_XP_THRESHOLD,
  FLIRT_REQUIREMENT,
  FLIRT_XP_BONUS,
  LOVER_XP_THRESHOLD,
  SOULMATE_XP_THRESHOLD,
  SPECIAL_XP,
  deriveBond,
} from "../src/sql/bonds.js";

assert.equal(CRUSH_XP_THRESHOLD, 500);
assert.equal(LOVER_XP_THRESHOLD, 700);
assert.equal(SOULMATE_XP_THRESHOLD, 1000);
assert.equal(SPECIAL_XP, 500);
assert.equal(FLIRT_REQUIREMENT, 5);
assert.equal(FLIRT_XP_BONUS, 25);

assert.equal(deriveBond("close_friend", 499, { flirtCount: 5 }).bond, "close_friend");
assert.equal(deriveBond("close_friend", 500, { flirtCount: 4 }).bond, "close_friend");
assert.equal(deriveBond("close_friend", 500, { flirtCount: 5 }).bond, "crush");
assert.equal(deriveBond("close_friend", 999999, { flirtCount: 5 }).bond, "crush");
assert.match(deriveBond("close_friend", 500, { flirtCount: 5 }).reason, /500/);

// A lover proposal requires crush + 700 XP + 5 flirts + acceptance.
assert.equal(deriveBond("crush", 699, { flirtCount: 5, approvals: { lover: true } }).bond, "crush");
assert.equal(deriveBond("crush", 700, { flirtCount: 4, approvals: { lover: true } }).bond, "crush");
assert.equal(deriveBond("crush", 700, { flirtCount: 5, approvals: { lover: true } }).bond, "lover");

// A soulmate proposal requires lover + 1000 XP + acceptance.
assert.equal(deriveBond("lover", 999, { flirtCount: 0, approvals: { soulmate: true } }).bond, "lover");
assert.equal(deriveBond("lover", 1000, { flirtCount: 0, approvals: { soulmate: true } }).bond, "soulmate");

// Sibling/family are capped special rungs and require 500 XP + acceptance.
assert.equal(deriveBond("friend", 499, { flirtCount: 0, approvals: { sibling: true } }).bond, "friend");
assert.equal(deriveBond("friend", 500, { flirtCount: 0, approvals: { sibling: true } }).bond, "sibling");
assert.equal(deriveBond("friend", 499, { flirtCount: 0, approvals: { family: true } }).bond, "friend");
assert.equal(deriveBond("friend", 500, { flirtCount: 0, approvals: { family: true } }).bond, "family");

// A proposal cannot jump from a lower rung directly to lover/soulmate.
assert.notEqual(deriveBond("stranger", 1000, { flirtCount: 5, approvals: { lover: true } }).bond, "lover");
assert.notEqual(deriveBond("friend", 1000, { flirtCount: 5, approvals: { soulmate: true } }).bond, "soulmate");

// XP is a leaderboard score and must not be capped by the relationship ladder.
assert.equal(deriveBond("crush", 999999, { flirtCount: 5 }).xp, 999999);

console.log("relationship-v2 tests: OK");
