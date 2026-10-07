/**
 * The block's options, as plain `key: value` lines.
 *
 * JSON was the obvious alternative and it is what the nearest plugin does, but
 * a block of JSON in the middle of a note reads as configuration rather than as
 * writing, and one missing comma shows an error where a chart should be. Plain
 * keys match the shape of a Tasks query, which is what somebody writing in this
 * vault has already learned.
 *
 *     ```span
 *     from: Projects/Website rebuild
 *     group: folder
 *     scale: week
 *     ```
 *
 * An empty block reads the note it sits in. That is the common case, and it
 * should need no words.
 */

import type { DateField, GroupBy, Priority, Query, Scale, Sort, Status, View, Window } from "./types";

const DEFAULTS: Omit<Query, "from" | "errors"> = {
	tags: [],
	group: ["none"],
	scale: "week",
	range: null,
	showDone: true,
	status: [],
	priorities: [],
	not: [],
	view: "gantt",
	cursor: new Date().setHours(0, 0, 0, 0),
	sort: "start",
	add: false,
	readonly: false,
	row: 26,
	title: "",
};

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A date at local midnight, so a bar starts where the day starts. */
export function day(text: string): number | null {
	const m = DATE.exec(text.trim());
	if (!m) return null;
	const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
	return isNaN(d.getTime()) ? null : d.getTime();
}

export function parseQuery(source: string, here: string): Query {
	const q: Query = { ...DEFAULTS, from: [], errors: [] };

	for (const raw of source.split("\n")) {
		const line = raw.trim();
		if (!line || line.startsWith("#") || line.startsWith("//")) continue;

		const at = line.indexOf(":");
		if (at < 0) {
			q.errors.push(`Not a setting: "${line}" — write it as \`key: value\`.`);
			continue;
		}
		const key = line.slice(0, at).trim().toLowerCase();
		const value = line.slice(at + 1).trim();

		switch (key) {
			case "from":
			case "path":
			case "folder":
				// Repeatable: three folders are three lines, not a comma list, so a
				// path containing a comma is not quietly cut in half.
				if (value) q.from.push(value.replace(/^\/+|\/+$/g, ""));
				break;

			case "tag":
			case "tags":
				for (const t of value.split(/[\s,]+/)) {
					if (t) q.tags.push(t.startsWith("#") ? t : `#${t}`);
				}
				break;

			case "group":
			case "group by":
				// A list, outermost first: `property:product, folder` bands by
				// product and then by phase, which is how a programme is read.
				q.group = [];
				for (const raw2 of value.split(",")) {
					const name = raw2.trim();
					if (!name) continue;
					if (name.startsWith("property:") && name.length > 9) {
						q.group.push(name as GroupBy);
					} else if (["folder", "file", "heading", "tag", "none"].includes(name)) {
						q.group.push(name as GroupBy);
					} else {
						q.errors.push(
							`group: ${name} — use folder, file, heading, tag, none or property:<name>.`);
					}
				}
				if (!q.group.length) q.group = ["none"];
				break;

			case "view":
			case "layout":
				if (["day", "week", "gantt", "list", "month", "year"].includes(value)) q.view = value as View;
				else q.errors.push(`view: ${value} — use day, week, gantt, list, month or year.`);
				break;

			case "status": {
				const names: Record<string, Status> = {
					open: "open", todo: "open", done: "done", complete: "done",
					cancelled: "cancelled", canceled: "cancelled",
					doing: "doing", "in progress": "doing", started: "doing",
				};
				for (const raw2 of value.split(",")) {
					const name = raw2.trim().toLowerCase();
					if (!name) continue;
					// `late` is a state, not a status: an open task past its due date.
					if (name === "late" || name === "overdue") { q.late = true; continue; }
					if (names[name]) q.status.push(names[name]);
					else q.errors.push(`status: ${name} — use open, done, cancelled, doing or late.`);
				}
				break;
			}

			case "priority":
				for (const raw2 of value.split(",")) {
					const name = raw2.trim().toLowerCase();
					if (!name) continue;
					if (["highest", "high", "medium", "normal", "low", "lowest"].includes(name)) {
						q.priorities.push(name as Priority);
					} else {
						q.errors.push(`priority: ${name} — use highest, high, medium, normal, low or lowest.`);
					}
				}
				break;

			case "not":
			case "exclude":
				if (value) q.not.push(value.replace(/^\/+|\/+$/g, ""));
				break;

			case "scale":
				if (["day", "week", "month"].includes(value)) q.scale = value as Scale;
				else q.errors.push(`scale: ${value} — use day, week or month.`);
				break;

			case "range": {
				if (value === "auto") break;
				const [a, b] = value.split("..").map((s) => s.trim());
				const from = day(a ?? "");
				const to = day(b ?? "");
				if (from === null || to === null)
					q.errors.push(`range: ${value} — write it as 2026-10-01..2027-01-31, or auto.`);
				else q.range = { from, to };
				break;
			}

			case "done":
				q.showDone = !/^(hide|no|false|off)$/i.test(value);
				break;

			case "row":
			case "height": {
				const n = Number(value.replace(/px$/, ""));
				if (Number.isFinite(n) && n >= 14 && n <= 80) q.row = n;
				else q.errors.push(`${key}: ${value} — a row is between 14 and 80 pixels.`);
				break;
			}

			case "sort":
			case "sort by":
				if (["start", "due", "name", "length", "status"].includes(value)) q.sort = value as Sort;
				else q.errors.push(`sort: ${value} — use start, due, name, length or status.`);
				break;

			case "date":
			case "date field":
				if (["start", "scheduled", "due", "done"].includes(value))
					q.dateField = value as DateField;
				else q.errors.push(`date: ${value} — use start, scheduled, due or done.`);
				break;

			case "window":
			case "period":
				if (["all", "day", "week", "month"].includes(value)) q.window = value as Window;
				else q.errors.push(`window: ${value} — use all, day, week or month.`);
				break;

			case "week starts":
				{
					const names = ["sunday", "monday", "tuesday", "wednesday",
						"thursday", "friday", "saturday"];
					const at = names.indexOf(value.toLowerCase());
					if (at >= 0) q.weekStart = at;
					else q.errors.push(`week starts: ${value} — name a day.`);
				}
				break;

			case "title":
				q.title = value;
				break;

			case "add":
				q.add = /^(yes|true|on|show)$/i.test(value);
				break;

			case "readonly":
			case "read only":
				// For a card or a deck, where a stray drag would rewrite a plan
				// in front of an audience.
				q.readonly = !/^(no|false|off)$/i.test(value);
				break;

			default:
				q.errors.push(`Unknown setting "${key}".`);
		}
	}

	// No `from` means the note the block sits in. The common case needs no words.
	if (q.from.length === 0) q.from.push(here);
	return q;
}
