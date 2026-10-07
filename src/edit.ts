/**
 * Writing back — the only part of this plugin that touches a file.
 *
 * Everything else reads. This module exists so that every write goes through
 * one door with one set of rules, because the failure that matters here is not
 * a wrong bar: it is somebody's plan quietly losing a line.
 *
 * Three rules, and the first is the important one:
 *
 *   1. Never rewrite a line. Replace the date tokens inside it and leave every
 *      other character — tags, links, block ids, indentation, trailing
 *      whitespace somebody's other plugin depends on — exactly as it was.
 *
 *   2. Check the line is still the line. A timeline can be minutes old; the
 *      file may have been edited since. If the text no longer matches what was
 *      drawn, refuse and say so rather than writing to the wrong place.
 *
 *   3. One `vault.process` call per change. It reads and writes under the same
 *      lock, which is what stops two quick drags racing each other.
 */

import { App, Notice, TFile } from "obsidian";
import type { Status, Task } from "./types";

const DAY = 86_400_000;

const START = "\u{1F6EB}";      // 🛫
const SCHEDULED = "\u{23F3}";   // ⏳
const DUE = "\u{1F4C5}";        // 📅
const DONE = "\u{2705}";        // ✅

const LINE = /^(\s*[-*+]\s+\[)(.)(\]\s*)(.*)$/;

export function iso(ms: number): string {
	const d = new Date(ms);
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** The task text with dates and tags stripped — the same shape `tasks.ts` makes. */
function signature(body: string): string {
	return body
		.replace(/[\u{1F6EB}\u{23F3}\u{1F4C5}\u{2705}\u{2795}\u{1F501}\u{23EC}\u{1F53C}\u{23EB}]\s*\d{4}-\d{2}-\d{2}/gu, "")
		.replace(/\[\s*(start|scheduled|due|completion|done)\s*::\s*\d{4}-\d{2}-\d{2}\s*\]/gi, "")
		.replace(/[\u{1F500}-\u{1F6FF}\u{2600}-\u{27BF}]\s*/gu, "")
		.replace(/\s{2,}/g, " ")
		.trim();
}

/**
 * Apply `change` to the one line this task came from.
 *
 * Returns false and warns if the line has moved or changed underneath us: a
 * refusal the person can see beats a silent write to the wrong line.
 */
async function onLine(
	app: App, task: Task, change: (body: string, box: string) => { body: string; box: string } | null,
): Promise<boolean> {
	const file = app.vault.getAbstractFileByPath(task.path);
	if (!(file instanceof TFile)) {
		new Notice(`Task Span: ${task.path} is gone.`);
		return false;
	}

	let ok = true;
	await app.vault.process(file, (text) => {
		const lines = text.split("\n");
		const raw = lines[task.line];
		const m = raw === undefined ? null : LINE.exec(raw);

		if (!m || signature(m[4]) !== task.text) {
			// Rule 2. The file changed since the chart was drawn.
			new Notice("Task Span: that line has changed since this was drawn. Nothing was written.");
			ok = false;
			return text;
		}

		const next = change(m[4], m[2]);
		if (!next) { ok = false; return text; }

		lines[task.line] = `${m[1]}${next.box}${m[3]}${next.body}`;
		return lines.join("\n");
	});
	return ok;
}

/** Put a date token on the line: replace the existing one, or append it. */
function withDate(body: string, emoji: string, when: number | null): string {
	const re = new RegExp(`${emoji}\\s*\\d{4}-\\d{2}-\\d{2}`, "u");
	if (when === null) return body.replace(re, "").replace(/\s{2,}/g, " ").trimEnd();
	if (re.test(body)) return body.replace(re, `${emoji} ${iso(when)}`);
	return `${body.trimEnd()} ${emoji} ${iso(when)}`;
}

/** Move or resize: write both ends, in the fields the task already used. */
export async function setDates(app: App, task: Task, start: number, end: number): Promise<boolean> {
	return onLine(app, task, (body, box) => {
		let out = body;
		if (task.moment && start === end) {
			// One date in, one date out. Giving a moment a span because somebody
			// dragged it would invent a duration nobody wrote down.
			//
			// `start === end` matters: a task with no dates at all is a moment by
			// this definition, so without it, scheduling one from the tray with a
			// real start and a real finish would silently drop the start.
			out = withDate(out, DUE, end);
		} else {
			// Respect whichever field supplied the start: a task using ⏳ keeps ⏳.
			const usesScheduled = new RegExp(`${SCHEDULED}\\s*\\d{4}-\\d{2}-\\d{2}`, "u").test(body);
			out = withDate(out, usesScheduled ? SCHEDULED : START, start);
			out = withDate(out, DUE, end);
		}
		return { body: out, box };
	});
}

export async function shift(app: App, task: Task, days: number): Promise<boolean> {
	return setDates(app, task, task.start + days * DAY, task.end + days * DAY);
}

export async function setStatus(app: App, task: Task, status: Status): Promise<boolean> {
	const mark: Record<Status, string> = { open: " ", done: "x", cancelled: "-", doing: "/" };
	return onLine(app, task, (body) => {
		// A done date is part of being done. Removing it on reopening is the
		// matching half, or a reopened task claims to have finished.
		const out = status === "done"
			? withDate(body, DONE, Date.now())
			: withDate(body, DONE, null);
		return { body: out, box: mark[status] };
	});
}

/** Delete the line entirely. Confirmed by the caller, never here. */
export async function remove(app: App, task: Task): Promise<boolean> {
	const file = app.vault.getAbstractFileByPath(task.path);
	if (!(file instanceof TFile)) return false;
	let ok = true;
	await app.vault.process(file, (text) => {
		const lines = text.split("\n");
		const m = lines[task.line] === undefined ? null : LINE.exec(lines[task.line]);
		if (!m || signature(m[4]) !== task.text) {
			new Notice("Task Span: that line has changed since this was drawn. Nothing was deleted.");
			ok = false;
			return text;
		}
		lines.splice(task.line, 1);
		return lines.join("\n");
	});
	return ok;
}

export interface NewLine {
	text: string;
	priority: string;
	tags: string;
	start: number | null;
	scheduled: number | null;
	due: number | null;
}

/**
 * Add a task to a note.
 *
 * Built in the order the Tasks plugin writes them — text, tags, priority,
 * then dates — so a line made here is indistinguishable from one typed by
 * hand, and every other plugin reading the vault sees what it expects.
 *
 * Appended at the end of the file. New tasks go where the person can find
 * them, which is the bottom, not the top.
 */
export async function appendTask(app: App, path: string, t: NewLine): Promise<boolean> {
	const file = app.vault.getAbstractFileByPath(path);
	if (!(file instanceof TFile)) {
		new Notice(`Task Span: ${path} does not exist.`);
		return false;
	}

	const parts = ["- [ ]", t.text];
	const tags = t.tags.split(/\s+/).filter(Boolean)
		.map((x) => (x.startsWith("#") ? x : `#${x}`));
	if (tags.length) parts.push(tags.join(" "));
	if (t.priority) parts.push(t.priority);
	if (t.start !== null) parts.push(`${START} ${iso(t.start)}`);
	if (t.scheduled !== null) parts.push(`${SCHEDULED} ${iso(t.scheduled)}`);
	if (t.due !== null) parts.push(`${DUE} ${iso(t.due)}`);

	const line = parts.join(" ");
	const NL = "\n";
	await app.vault.process(file, (body) =>
		body === "" || body.endsWith(NL)
			? body + line + NL
			: body + NL + line + NL);
	return true;
}


/**
 * Replace a whole note's text — the daily-note editor, and only that.
 *
 * Rule 2 applies here more than anywhere else in this file. The editor holds
 * whatever the note said when the panel was drawn, which can be minutes ago;
 * writing that back unconditionally would discard anything typed into the note
 * from another pane, another window or another device in between. So the
 * content it was opened on is checked inside the same `process` lock that does
 * the writing, and a mismatch refuses rather than overwrites.
 */
export async function replaceNote(
	app: App, path: string, was: string, next: string,
): Promise<boolean> {
	const file = app.vault.getAbstractFileByPath(path);
	if (!(file instanceof TFile)) return false;
	let ok = true;
	await app.vault.process(file, (current) => {
		if (current !== was) {
			new Notice("Task Span: this note changed while you were typing. Nothing was written.");
			ok = false;
			return current;
		}
		return next;
	});
	return ok;
}
