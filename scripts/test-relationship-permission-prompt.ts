import { strict as assert } from "node:assert";
import { gemini2SystemPrompt } from "../src/pipeline/pipeline.js";

const prompt = gemini2SystemPrompt("Yuuta");

// Relationship mechanics must stay server-side. The analyst gets semantic permissions in the turn context.
assert.doesNotMatch(prompt, /bond_ladder/i);
assert.doesNotMatch(prompt, /proposal_xp/i);
assert.doesNotMatch(prompt, /enemy_xp/i);
assert.doesNotMatch(prompt, /flirt_requirement/i);
assert.doesNotMatch(prompt, /(?:lover|soulmate|sibling|family)[^\n]*(?:500|700|1000)/i);
assert.match(prompt, /can_accept_lover/);
assert.match(prompt, /hard gate/i);

console.log("relationship permission prompt tests passed");
