/**
 * Reading the tasks that are already there.
 *
 * The format is the Tasks plugin's, because that is what this vault already
 * writes and inventing a second one would make the drawing a second source of
 * truth. Dataview's inline fields are read too, since plenty of vaults use
 * those instead and the cost of accepting both is one more regular expression.
 *
 *     - [ ] Draft the API contract 🛫 2026-10-06 📅 2026-10-13
 *     - [x] Create the GitHub organisation 📅 2026-10-05 ✅ 2026-10-05
 *     - [ ] Security review [start:: 2026-12-08] [due:: 2026-12-14]
 *
 * A task with one date is a moment rather than a span, and is drawn as a marker.
 * A task with none is not drawn at all — it has nowhere to go on a timeline, and
 * inventing a position for it would be a lie.
 */

import { App, TFile, TFolder } from "obsidian";
import { day } from "./query";
import type { DateField, Group, GroupBy, Priority, Query, Status, Task } from "./types";

const LINE = /^\s*[-*+]\s+\[(.)\]\s+(.*)$/;

const EMOJI: Record<string, "start" | "scheduled" | "due" | "done"> = {
	"\u{1F6EB}": "start",      // 🛫
	"\u{23F3}": "scheduled",   // ⏳
	"\u{1F4C5}": "due",        // 📅
	"\u{2705}": "done",        // ✅
};

const EMOJI_DATE = new RegExp(
	`(${Object.keys(EMOJI).join("|")})\\s*(\\d{4}-\\d{2}-\\d{2})`,
	"gu",
);
const FIELD_DATE = /\[\s*(start|scheduled|due|completion|done)\s*::\s*(\d{4}-\d{2}-\d{2})\s*\]/gi;
const TAG = /(^|\s)(#[A-Za-z][\w/-]*)/g;
const HEADING = /^(#{1,6})\s+(.*)$/;

/**
 * Tasks' priority markers, highest first so the first hit wins.
 *
 * Read, never shown: the chart draws an icon instead. The marker is the
 * storage format, not the interface.
 */
const PRIORITY: [string, Priority][] = [
	["\u{1F53A}", "highest"],
	["\u{23EB}", "high"],
	["\u{1F53C}", "medium"],
	["\u{1F53D}", "low"],
	["\u{23EC}", "lowest"],
];

function statusOf(ch: string): Status {
	if (ch === "x" || ch === "X") return "done";
	if (ch === "-") return "cancelled";
	if (ch === "/" || ch === ">") return "doing";
	return "open";
}

/** Everything the query points at: a file is itself, a folder is its whole tree. */
function filesFor(app: App, q: Query): TFile[] {
	const out = new Map<string, TFile>();

	const addTree = (folder: TFolder) => {
		for (const child of folder.children) {
			if (child instanceof TFolder) addTree(child);
			else if (child instanceof TFile && child.extension === "md") out.set(child.path, child);
		}
	};

	for (const from of q.from) {
		const direct = app.vault.getAbstractFileByPath(from);
		if (direct instanceof TFile) {
			if (direct.extension === "md") out.set(direct.path, direct);
			continue;
		}
		if (direct instanceof TFolder) {
			// Recursive, which is the thing both of the plugins this replaces get
			// wrong: a project folder with phases inside it is the normal shape.
			addTree(direct);
			continue;
		}
		// Not a real path: fall back to a prefix match, so `Projects/Web` works
		// without having to spell the folder exactly.
		const prefix = from.toLowerCase();
		for (const f of app.vault.getMarkdownFiles()) {
			if (f.path.toLowerCase().startsWith(prefix)) out.set(f.path, f);
		}
	}
	return [...out.values()];
}

function parseFile(path: string, text: string, props: Record<string, unknown>): Task[] {
	const out: Task[] = [];
	const slash = path.lastIndexOf("/");
	const folder = slash < 0 ? "/" : path.slice(0, slash);
	const file = path.slice(slash + 1).replace(/\.md$/, "");
	let heading = "";

	const lines = text.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const h = HEADING.exec(lines[i]);
		if (h) {
			heading = h[2].trim();
			continue;
		}
		const m = LINE.exec(lines[i]);
		if (!m) continue;

		let body = m[2];
		const dates: Partial<Record<string, number>> = {};

		for (const d of body.matchAll(EMOJI_DATE)) {
			const when = day(d[2]);
			if (when !== null) dates[EMOJI[d[1]]] = when;
		}
		for (const d of body.matchAll(FIELD_DATE)) {
			const key = d[1].toLowerCase();
			const when = day(d[2]);
			if (when !== null) dates[key === "completion" ? "done" : key] = when;
		}

		const tags: string[] = [];
		for (const t of body.matchAll(TAG)) tags.push(t[2]);

		let priority: Priority = "normal";
		for (const [mark, name] of PRIORITY) {
			if (body.includes(mark)) { priority = name; break; }
		}

		// What is left once the machinery is removed is the label.
		body = body
			.replace(EMOJI_DATE, "")
			.replace(FIELD_DATE, "")
			.replace(/[\u{1F500}-\u{1F6FF}\u{2600}-\u{27BF}]\s*/gu, "")
			.replace(/\s{2,}/g, " ")
			.trim();

		const begins = dates.start ?? dates.scheduled ?? null;
		const ends = dates.due ?? dates.done ?? null;
		// Carried, not dropped. A task with no dates cannot be drawn on a
		// timeline, but it is still work somebody wrote down — and a planner
		// that hides the unplanned is a planner that cannot be planned with.
		const unscheduled = begins === null && ends === null;

		const start = begins ?? ends ?? 0;
		const end = ends ?? begins ?? 0;

		out.push({
			path, line: i, file, folder, heading,
			text: body || "(untitled)",
			status: statusOf(m[1]),
			priority,
			start: Math.min(start, end),
			end: Math.max(start, end),
			moment: begins === null || ends === null || begins === ends,
			unscheduled,
			dates: {
				start: dates.start, scheduled: dates.scheduled,
				due: dates.due, done: dates.done,
			},
			tags,
			props,
		});
	}
	return out;
}

/**
 * Tasks matching the query.
 *
 * `mode` picks which half: the scheduled ones a chart can draw, or the
 * unscheduled ones it cannot. Two calls rather than one list with a flag,
 * because every caller wants one or the other and never both mixed.
 */
export async function collect(
	app: App, q: Query, mode: "scheduled" | "unscheduled" = "scheduled",
): Promise<Task[]> {
	const files = filesFor(app, q);
	const all: Task[] = [];
	for (const f of files) {
		// cachedRead, not read: this runs on every render and the file is almost
		// always one Obsidian already has in memory.
		// The frontmatter comes from the metadata cache rather than being parsed
		// again: Obsidian has already done it, and done it properly.
		const props = app.metadataCache.getFileCache(f)?.frontmatter ?? {};
		all.push(...parseFile(f.path, await app.vault.cachedRead(f), props));
	}

	let tasks = all.filter((t) => !!t.unscheduled === (mode === "unscheduled"));
	if (q.not.length) {
		tasks = tasks.filter((t) => !q.not.some((n) => t.path.toLowerCase().startsWith(n.toLowerCase())));
	}
	if (q.priorities.length) {
		tasks = tasks.filter((t) => q.priorities.includes(t.priority));
	}
	if (q.status.length) {
		tasks = tasks.filter((t) => q.status.includes(t.status));
	}
	if (q.late && mode === "scheduled") {
		const now = new Date().setHours(0, 0, 0, 0);
		tasks = tasks.filter((t) => t.status === "open" && t.end < now);
	}
	// The window is measured against one chosen field, which is why the field
	// is asked for: "due this week" and "starting this week" are different
	// questions and a list that answers only one is half a list.
	if (q.window && q.window !== "all" && mode === "scheduled") {
		const field: DateField = q.dateField ?? "due";
		const at = new Date(q.cursor);
		at.setHours(0, 0, 0, 0);
		let from = at.getTime();
		let to = from + 86_400_000;
		if (q.window === "week") {
			const start = q.weekStart ?? 1;
			const d = new Date(from);
			d.setDate(d.getDate() - ((d.getDay() - start + 7) % 7));
			from = d.getTime();
			to = from + 7 * 86_400_000;
		} else if (q.window === "month") {
			const d = new Date(from);
			from = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
			to = new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime();
		}
		tasks = tasks.filter((t) => {
			const when = t.dates[field];
			return when !== undefined && when >= from && when < to;
		});
	}
	if (q.tags.length) {
		tasks = tasks.filter((t) => t.tags.some((tag) => q.tags.includes(tag)));
	}
	if (!q.showDone) {
		tasks = tasks.filter((t) => t.status !== "done" && t.status !== "cancelled");
	}
	const RANK: Record<string, number> = { doing: 0, open: 1, done: 2, cancelled: 3 };
	const by: Record<string, (a: Task, b: Task) => number> = {
		start: (a, b) => a.start - b.start || a.end - b.end,
		due: (a, b) => a.end - b.end || a.start - b.start,
		name: (a, b) => a.text.localeCompare(b.text),
		// Longest first: on a chart, the long bars are the shape of the plan.
		length: (a, b) => (b.end - b.start) - (a.end - a.start) || a.start - b.start,
		status: (a, b) => RANK[a.status] - RANK[b.status] || a.start - b.start,
	};
	return tasks.sort(by[q.sort] ?? by.start);
}

/**
 * The short form of a band key.
 *
 * A full vault path is unreadable as a heading at any sane column width, and
 * the leading folders are the same for every band anyway — so a folder shows
 * its last two segments and keeps the whole path on hover.
 */
function labelFor(key: string, level: GroupBy): string {
	if (level !== "folder") return key;
	const parts = key.split("/").filter(Boolean);
	return parts.slice(-2).join("  ·  ") || key;
}

export function groupTasks(tasks: Task[], by: Query["group"]): Group[] {
	const levels = by.filter((b) => b !== "none");
	if (!levels.length) return [{ name: "", label: "", tasks, children: [] }];

	const keyFor = (t: Task, level: GroupBy): string[] => {
		if (level === "folder") return [t.folder];
		if (level === "file") return [t.file];
		if (level === "heading") return [t.heading || "(no heading)"];
		// A task can carry several tags, so it appears under each. Double-counting
		// is the honest answer: the alternative is silently picking one.
		if (level === "tag") return t.tags.length ? t.tags : ["(untagged)"];
		// The note's frontmatter, carried on the task. This is what makes
		// `property:product` work: the property is on the note, and every task in
		// that note inherits it.
		const name = level.slice("property:".length);
		const raw = t.props[name];
		if (raw === undefined || raw === null || raw === "") return [`(no ${name})`];
		return Array.isArray(raw) ? raw.map(String) : [String(raw)];
	};

	const build = (within: Task[], rest: GroupBy[]): Group[] => {
		if (!rest.length) return [];
		const [level, ...deeper] = rest;
		const map = new Map<string, Task[]>();
		for (const t of within) {
			for (const key of keyFor(t, level)) {
				const list = map.get(key);
				if (list) list.push(t);
				else map.set(key, [t]);
			}
		}
		return [...map.entries()]
			.map(([name, list]) => ({
				name,
				label: labelFor(name, level),
				tasks: list,
				children: build(list, deeper),
			}))
			// Bands in the order their first task starts: a timeline reads left to
			// right, so its headings should too.
			.sort((a, b) => a.tasks[0].start - b.tasks[0].start);
	};

	return build(tasks, levels);
}
