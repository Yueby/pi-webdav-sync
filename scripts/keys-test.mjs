import assert from "node:assert/strict";
import { normalizeKey } from "../dist/src/keys.js";
import { pickerActionFor } from "../dist/src/tree-picker.js";
import { createSyncMenuComponent } from "../dist/src/sync-menu.js";

const cases = [
	["\x1b[27u", "\x1b"], ["\x1b[27;1u", "\x1b"], ["\x1b[27;1:1u", "\x1b"], ["\x1b[27;1:3u", ""],
	["\x1b[99;5u", "\x03"], ["\x1b[99;5:1u", "\x03"], ["\x1b[99;5:3u", ""], ["\x1b[27;5;99~", "\x03"],
	["\x1b[27;1;27~", "\x1b"], ["\x1b[13u", "\r"], ["\x1b[1;1:2A", "\x1b[A"], ["\x1b[1;1:3A", ""],
	["\x1b[1;5A", "\x1b[1;5A"], ["\x1b", "\x1b"], ["\x03", "\x03"], ["\x1b[A", "\x1b[A"], ["x", "x"],
];
for (const [input, expected] of cases) assert.equal(normalizeKey(input), expected, JSON.stringify(input));
assert.equal(pickerActionFor("\x1b[27u"), "back");
assert.equal(pickerActionFor("\x1b[99;5u"), "cancel");
let result;
const menu = createSyncMenuComponent("Step", [{ id: "a", label: "A" }], (v) => { result = v; });
menu.handleInput("\x1b[27u");
assert.ok(result !== undefined, "menu closes on Kitty Esc");
console.log("keys-test ok");
