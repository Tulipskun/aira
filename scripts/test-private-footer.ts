import { strict as assert } from "node:assert";

const { statusLineOf, buildFooterText } = await import("../src/bot/embed-footer.js");

const base = {
  userName: "Farris",
  bond: "lover",
  xp: 109,
};

assert.equal(statusLineOf({ ...base, privateSession: true }), "Farris (คนรัก) (❤️) 109");
assert.equal(statusLineOf({ ...base, privateSession: false }), "Farris (คนรัก) ❤️ 109");
assert.equal(statusLineOf({ ...base }), "Farris (คนรัก) ❤️ 109");
assert.equal(buildFooterText({ ...base, privateSession: true, mood: "สงบ" }), "Farris (คนรัก) (❤️) 109\nอารมณ์: สงบ");
assert.equal(buildFooterText({ ...base, privateSession: false, mood: "สงบ" }), "Farris (คนรัก) ❤️ 109\nอารมณ์: สงบ");

console.log("private-footer tests: OK");
