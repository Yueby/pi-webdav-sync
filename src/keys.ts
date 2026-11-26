/**
 * Pi's terminal layer negotiates the Kitty keyboard protocol (or xterm
 * modifyOtherKeys), so Esc arrives as `\x1b[27u` and Ctrl+C as `\x1b[99;5u`
 * instead of the legacy `\x1b` / `\x03`. Components here match legacy byte
 * sequences, so incoming data is folded back to them first.
 * Returns "" for key-release events, which must be ignored.
 */
const CSI_U = /^\x1b\[(\d+)(?::\d*)*(?:;(\d+)(?::(\d+))?)?(?:;[\d:;]*)?u$/;
const MODIFY_OTHER_KEYS = /^\x1b\[27;(\d+);(\d+)~$/;
const CSI_MODIFIED = /^\x1b\[(\d+);(\d+)(?::(\d+))?([ABCDHF~])$/;
const CSI_MODIFIED_LETTER = /^\x1b\[1;(\d+)(?::(\d+))?([ABCDHF])$/;

const SHIFT = 1;
const ALT = 2;
const CTRL = 4;

function fromCodepoint(codepoint: number, modifier: number): string {
	const mods = modifier - 1 & ~(8 | 16 | 32 | 64 | 128); // ignore super/hyper/meta/lock bits
	if (mods === 0) {
		if (codepoint === 27) return "\x1b";
		if (codepoint === 13 || codepoint === 57414) return "\r";
		if (codepoint === 32) return " ";
		if (codepoint === 127 || codepoint === 8) return "\x7f";
		if (codepoint === 9) return "\t";
		if (codepoint >= 33 && codepoint !== 127 && codepoint < 0x110000) return String.fromCodePoint(codepoint);
	}
	if (mods === CTRL && (codepoint === 99 || codepoint === 67)) return "\x03";
	if (mods === SHIFT && codepoint >= 33 && codepoint < 0x110000 && codepoint !== 127) {
		const char = String.fromCodePoint(codepoint);
		return char.toUpperCase();
	}
	return `\x1b[${codepoint};${mods + 1}u`;
}

export function normalizeKey(data: string): string {
	if (!data.startsWith("\x1b[")) return data;
	let match = CSI_U.exec(data);
	if (match) {
		if (match[3] === "3") return "";
		return fromCodepoint(Number(match[1]), match[2] ? Number(match[2]) : 1);
	}
	match = MODIFY_OTHER_KEYS.exec(data);
	if (match) return fromCodepoint(Number(match[2]), Number(match[1]));
	match = CSI_MODIFIED_LETTER.exec(data);
	if (match) {
		if (match[2] === "3") return "";
		return Number(match[1]) === 1 ? `\x1b[${match[3]}` : data;
	}
	match = CSI_MODIFIED.exec(data);
	if (match && match[4] === "~") {
		if (match[3] === "3") return "";
		return Number(match[2]) === 1 ? `\x1b[${match[1]}~` : data;
	}
	return data;
}
