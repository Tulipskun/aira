import { strict as assert } from "node:assert";
import { profileBlock, stateBlock } from "../src/pipeline/pipeline.js";
import type { UserProfile } from "../src/sql/profile.js";

const base: UserProfile = {
  userId: "u1",
  userName: "Yuuta",
  nickname: [],
  bond: "crush",
  xp: 699,
  flirtCount: 5,
  approvals: { lover: false, soulmate: false, sibling: false, family: false },
  facts: [],
};

const blocked = stateBlock(base);
assert.match(blocked, /can_accept_lover: false/);
assert.doesNotMatch(blocked, /699/);
assert.doesNotMatch(blocked, /flirt_count/);
assert.doesNotMatch(blocked, /threshold/i);
assert.doesNotMatch(blocked, /xp/i);

const allowed = stateBlock({ ...base, xp: 700 });
assert.match(allowed, /can_accept_lover: true/);

const dialogueProfile = profileBlock(base);
assert.match(dialogueProfile, /can_accept_lover: false/);
assert.doesNotMatch(dialogueProfile, /699/);
assert.doesNotMatch(dialogueProfile, /flirt_count/);
assert.doesNotMatch(dialogueProfile, /threshold/i);
assert.doesNotMatch(dialogueProfile, /xp/i);

console.log("relationship permission context tests passed");
