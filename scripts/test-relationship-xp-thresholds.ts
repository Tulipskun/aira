import { strict as assert } from "node:assert";
import { bondForXp, deriveBond } from "../src/sql/bonds.js";

const d = (from: string | null, xp: number, flirtCount = 0, approvals: Record<string, boolean> = {}) =>
  deriveBond(from, xp, { flirtCount, approvals: approvals as never });

// XP bands.
assert.equal(bondForXp(-150), "enemy");
assert.equal(bondForXp(-149), "stranger");
assert.equal(bondForXp(49), "stranger");
assert.equal(bondForXp(50), "acquaintance");
assert.equal(bondForXp(149), "acquaintance");
assert.equal(bondForXp(150), "friend");
assert.equal(bondForXp(299), "friend");
assert.equal(bondForXp(300), "close_friend");
assert.equal(bondForXp(499), "close_friend");

// Crush requires 500 XP + 5 accepted flirts.
assert.equal(d("close_friend", 499, 5).bond, "close_friend");
assert.equal(d("close_friend", 500, 4).bond, "close_friend");
assert.equal(d("close_friend", 500, 5).bond, "crush");

// Lover requires crush + 700 XP + accepted lover proposal.
assert.equal(d("crush", 699, 5, { lover: true }).bond, "crush");
assert.equal(d("crush", 700, 5).bond, "crush");
assert.equal(d("crush", 700, 5, { lover: true }).bond, "lover");

// Soulmate requires lover + 1000 XP + accepted marriage proposal.
assert.equal(d("lover", 999, 0, { soulmate: true }).bond, "lover");
assert.equal(d("lover", 1000, 0).bond, "lover");
assert.equal(d("lover", 1000, 0, { soulmate: true }).bond, "soulmate");

// Sibling/family require 500 XP + acceptance.
assert.equal(d("friend", 499, 0, { sibling: true }).bond, "friend");
assert.equal(d("friend", 500, 0, { sibling: true }).bond, "sibling");
assert.equal(d("friend", 499, 0, { family: true }).bond, "friend");
assert.equal(d("friend", 500, 0, { family: true }).bond, "family");

console.log("relationship XP threshold tests passed");
