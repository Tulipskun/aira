import { strict as assert } from "node:assert";
import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import { addRpsComponents, closedRows, expiredRows, rpsOutcomeText, rpsResult } from "../src/bot/rps.js";
import { parseIslaReply } from "../src/gemini/reply-format.js";
import { enqueueScheduledMessage } from "../src/bot/message-handler.js";

assert.equal(rpsResult("rock", "scissors"), "win");
assert.equal(rpsResult("scissors", "rock"), "lose");
assert.equal(rpsResult("paper", "paper"), "draw");
assert.equal(rpsOutcomeText("rock", "Yuuta", "scissors"), "Isla: rock Yuuta: scissors ผลลัพธ์: isla ชนะ");

const parsed = parseIslaReply('{"Isla":"มาเล่นกันค่ะ","summery":"เล่นเป่ายิ้งฉุบ","mood":"สนุก","color":"#1ABC9C","rps":"rock"}');
assert.equal(parsed.rps, "rock");
assert.equal(parseIslaReply('{"Isla":"ค่ะ","summery":"ส","mood":"สงบ","color":"#1ABC9C"}').rps, undefined);
assert.equal(parseIslaReply('{"Isla":"ค่ะ","summery":"ส","rps":"lizard"}').rps, undefined);

const activeButtons = (addRpsComponents({ content: "test" }, "game-1").components?.[0] as ActionRowBuilder<ButtonBuilder>).toJSON() as { components: Array<{ label?: string; emoji?: { name?: string } }> };
assert.deepEqual(activeButtons.components.map((button) => button.label), ["ค้อน", "กรรไกร", "กระดาษ"]);
assert.deepEqual(activeButtons.components.map((button) => button.emoji), [{ name: "✊🏻" }, { name: "✌🏻" }, { name: "🖐🏻" }]);
assert.equal(activeButtons.components.every((button) => typeof button.label === "string" && button.label.length > 0), true);

const winButtons = closedRows("scissors", "rock")[0].toJSON().components as Array<{ style?: number; disabled?: boolean; label?: string; emoji?: { name?: string } }>;
assert.equal(winButtons[0]?.style, ButtonStyle.Success);
assert.equal(winButtons[0]?.disabled, true);
assert.equal(winButtons[0]?.label, "ค้อน");
assert.deepEqual(winButtons[0]?.emoji, { name: "✊🏻" });
assert.equal(winButtons[1]?.label, "กรรไกร");
assert.deepEqual(winButtons[1]?.emoji, { name: "✌🏻" });
assert.equal(winButtons[1]?.style, ButtonStyle.Secondary);
assert.equal(winButtons[2]?.label, "กระดาษ");
assert.deepEqual(winButtons[2]?.emoji, { name: "🖐🏻" });

const timeoutButtons = expiredRows()[0].toJSON().components as Array<{ style?: number; disabled?: boolean; label?: string; emoji?: { name?: string } }>;
assert.equal(timeoutButtons.every((button) => button.disabled === true), true);
assert.equal(timeoutButtons.every((button) => button.style === ButtonStyle.Secondary), true);
assert.equal(timeoutButtons[0]?.label, "ค้อน");
assert.deepEqual(timeoutButtons[0]?.emoji, { name: "✊🏻" });
assert.equal(timeoutButtons[1]?.label, "กรรไกร");
assert.deepEqual(timeoutButtons[1]?.emoji, { name: "✌🏻" });
assert.equal(timeoutButtons[2]?.label, "กระดาษ");
assert.deepEqual(timeoutButtons[2]?.emoji, { name: "🖐🏻" });

let queued = false;
const scheduler = {
  interruptOtherSessions: (_sessionKey: string) => {},
  push: (_message: { text: string }) => { queued = true; },
};
enqueueScheduledMessage(scheduler, {
  userId: "u1", user: "Yuuta", text: "[RPS] result", timestamp: new Date().toISOString(),
  sessionKey: "user:u1", channelId: "channel-1",
});
assert.equal(queued, true);
console.log("RPS tests: OK");

// Shared queue boundary is exercised above via enqueueScheduledMessage().
