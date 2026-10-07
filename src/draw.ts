/**
 * The drawings.
 *
 * Four layouts over the same tasks — gantt, list, month, year — and not one
 * colour between them. Every rule, bar and label carries a class and takes its
 * colour from CSS, which is the whole reason this plugin exists: a chart with
 * `fill="#b4a7f5"` baked in looks wrong the moment it is dropped into a themed
 * deck, and no amount of plugin settings fixes that.
 *
 * Nothing here knows about Obsidian. Each layout takes groups and gives back an
 * element plus the bars it drew, so the same code serves a code block and a
 * sidebar view without either knowing the other exists.
 */

import type { Group, Query, Task, View } from "./types";

const DAY = 86_400_000;
/** Hour row heights. The CSS reads the same numbers; keep them together. */
const HOUR_DAY = 32;
const HOUR_WEEK = 28;
const MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
	"Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DOW_FROM_SUN = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
/** Day names in the order this vault's week runs. */
function dow(start = 1): string[] {
	return Array.from({ length: 7 }, (_, i) => DOW_FROM_SUN[(start + i) % 7]);
}

export interface Drawn {
	root: HTMLElement;
	/** One entry per task the layout made clickable. */
	bars: { task: Task; node: HTMLElement }[];
	/** Only the gantt has a time axis, so only the gantt can be dragged. */
	geo?: { from: number; colW: number };
	/** Empty places a new task could be put: the day view's hour slots. */
	slots?: { at: number; label: string; node: HTMLElement }[];
	/**
	 * Dates the caller can make clickable. `view` says where the click leads —
	 * a day cell to the day, a week number to the week, a month name to the
	 * month. `tasks`, where given, is what to show on hover.
	 */
	days?: { at: number; node: HTMLElement; view?: View; tasks?: Task[] }[];
}

/** Is anything banded? `["none"]` is the flat case. */
export const grouped = (q: Query) => q.group.some((g) => g !== "none");

/** One level of nesting, in pixels. Wide enough to be seen at a glance. */
const STEP = 22;

const midnight = (t: number) => new Date(t).setHours(0, 0, 0, 0);
const today = () => midnight(Date.now());

/** ISO week number: the Thursday of the week decides it. */
function isoWeek(ms: number): number {
	const thu = new Date(midnight(ms) + 3 * DAY);
	const jan1 = new Date(thu.getFullYear(), 0, 1);
	return Math.ceil((((thu.getTime() - jan1.getTime()) / DAY) + jan1.getDay() + 1) / 7);
}

/**
 * The first day of the week containing `t`.
 *
 * `start` is 0 for Sunday through 6 for Saturday. A project week starts on
 * Monday, a diary often on Sunday, and in parts of the Gulf on Saturday — so
 * it is asked rather than assumed.
 */
function weekStartOf(t: number, start = 1): number {
	const d = new Date(midnight(t));
	d.setDate(d.getDate() - ((d.getDay() - start + 7) % 7));
	return d.getTime();
}

function div(parent: HTMLElement, cls: string, text?: string): HTMLDivElement {
	const node = parent.ownerDocument.createElement("div");
	node.className = cls;
	if (text !== undefined) node.textContent = text;
	parent.appendChild(node);
	return node;
}

function stateOf(t: Task): string {
	if (t.status === "done") return "is-done";
	if (t.status === "cancelled") return "is-cancelled";
	if (t.status === "doing") return "is-doing";
	return t.end < today() ? "is-late" : "is-open";
}

const short = (ms: number) => {
	const d = new Date(ms);
	return `${d.getDate()} ${MONTH[d.getMonth()]}`;
};

/** The window the chart covers, from the query or from the tasks. */
function windowFor(tasks: Task[], q: Query) {
	let from = q.range?.from ?? Math.min(...tasks.map((t) => t.start));
	let to = q.range?.to ?? Math.max(...tasks.map((t) => t.end));
	if (!q.range) {
		const pad = Math.max(DAY, (to - from) * 0.02);
		from = midnight(from - pad);
		to = midnight(to + pad) + DAY;
	}
	if (to <= from) to = from + DAY;
	return { from, to };
}

/* ══ gantt ═══════════════════════════════════════════════════════════════
 * A name column that does not scroll, and a timeline that does. This is the
 * shape every project tool settles on, because the one question asked of a
 * gantt is "which task is that bar", and a bar whose name has scrolled off
 * cannot answer it.
 */
export function gantt(host: HTMLElement, groups: Group[], q: Query): Drawn {
	const tasks = groups.flatMap((g) => g.tasks);
	const bars: Drawn["bars"] = [];
	const { from, to } = windowFor(tasks, q);
	const days = Math.max(1, Math.round((to - from) / DAY));
	const colW = q.scale === "day" ? 34 : q.scale === "week" ? 15 : 7;
	const trackW = days * colW;

	const root = div(host, "ts-gantt");
	// The body draws its grid from this, so the columns under a bar are the same
	// columns as the dates above it. Two separate griddings cannot stay in step.
	root.style.setProperty("--ts-col-w", `${colW}px`);
	root.style.setProperty("--ts-week-w", `${colW * 7}px`);
	const head = div(root, "ts-head");
	const headName = div(head, "ts-head-name");
	div(headName, "ts-head-num", "#");
	div(headName, "ts-head-task", "Task");

	// The name column is drag-resizable. A fixed width is a guess about names
	// nobody has written yet, and the wrong guess truncates every one of them.
	const grab = div(headName, "ts-name-grab");
	grab.addEventListener("pointerdown", (ev) => {
		ev.preventDefault();
		ev.stopPropagation();
		grab.setPointerCapture(ev.pointerId);
		const x0 = ev.clientX;
		const w0 = root.getBoundingClientRect();
		const start = parseFloat(getComputedStyle(root).getPropertyValue("--ts-name-w")) || 260;
		const move = (e: PointerEvent) => {
			const next = Math.max(120, Math.min(w0.width - 160, start + (e.clientX - x0)));
			root.style.setProperty("--ts-name-w", `${next}px`);
		};
		const up = () => {
			grab.removeEventListener("pointermove", move);
			grab.removeEventListener("pointerup", up);
		};
		grab.addEventListener("pointermove", move);
		grab.addEventListener("pointerup", up);
	});
	const headTrack = div(head, "ts-head-track");
	const scroller = div(headTrack, "ts-scroll");
	scroller.style.width = `${trackW}px`;

	// ── the date header ──────────────────────────────────────────────────
	for (let i = 0; i < days; i++) {
		const at = from + i * DAY;
		const d = new Date(at);
		const isWeekStart = d.getDay() === 1;
		const cell = div(scroller, `ts-col${isWeekStart ? " is-week" : ""}${at === today() ? " is-today" : ""}`);
		cell.style.left = `${i * colW}px`;
		cell.style.width = `${colW}px`;
		if (q.scale === "day") cell.textContent = String(d.getDate());
		else if (q.scale === "week" && isWeekStart) cell.textContent = `${d.getDate()}/${d.getMonth() + 1}`;
		else if (q.scale === "month" && d.getDate() === 1) cell.textContent = MONTH[d.getMonth()];
	}

	const bodyEl = div(root, "ts-body");
	let n = 0;

	/** Today's line, drawn into whichever rail is asked for. */
	const railFor = (host: HTMLElement) => {
		const rail = div(host, "ts-scroll");
		rail.style.width = `${trackW}px`;
		// Today drawn in every row rather than once behind them: the rows scroll
		// as one, but each has its own rail, and a single line would sit behind
		// only the first.
		if (today() >= from && today() < to) {
			// A line, not a column. A tinted column the width of a day washes over
			// every bar that crosses it and competes with the bars for attention;
			// a line says where today is and then gets out of the way.
			const line = div(rail, "ts-rail-today");
			line.style.left = `${((today() - from) / DAY) * colW}px`;
		}
		return rail;
	};

	const taskRow = (block: HTMLElement, task: Task, depth: number) => {
		n++;
		const row = div(block, `ts-row ${stateOf(task)}`);
		const name = div(row, "ts-cell-name");
		div(name, "ts-num", String(n));
		// No checkbox here, deliberately. A Gantt is read to answer "when does
		// this happen and what overlaps it"; ticking belongs to Tasks and the
		// calendars, where a row is a thing to do rather than a thing to place.
		// The bar still carries the status as colour, so nothing is lost.
		const label = div(name, "ts-name", task.text);
		// The indent belongs to the label, never to the cell. Indenting the cell
		// moves the serial number with it, and the number then no longer lines up
		// with the `#` in the header — the column stops being a column.
		// No depth indent on a task name. The band above it already says where it
		// belongs, and indenting every row as well pushes the names off the left
		// edge for nothing — the column is narrow and the name is what it is for.
		label.title = `${task.text}
${task.file}`;

		const track = div(row, "ts-cell-track");
		const rail = railFor(track);

		const x = ((task.start - from) / DAY) * colW;
		const w = Math.max(colW * 0.7, ((task.end - task.start) / DAY + 1) * colW);
		const bar = div(rail, `ts-bar ${stateOf(task)}${task.moment ? " is-moment" : ""}`);
		bar.style.left = `${x}px`;
		bar.style.width = `${w}px`;
		bar.title = task.moment
			? `${task.text}
${short(task.start)}`
			: `${task.text}
${short(task.start)} → ${short(task.end)}`;
		bars.push({ task, node: bar });
	};

	/**
	 * A band and everything beneath it.
	 *
	 * Each node is its own block so folding a parent folds its children with it
	 * — flat siblings would mean hunting for "the rows after this band and
	 * before the next one", which breaks the moment a group is empty.
	 */
	const renderGroup = (host: HTMLElement, group: Group, depth: number) => {
		const block = div(host, `ts-group${depth ? " is-nested" : ""}`);
		if (group.label) {
			const band = div(block, `ts-row is-band is-depth-${Math.min(depth, 2)}`);
			const head = div(band, "ts-cell-name");
			// From the same base as a task row, or a child band sits two pixels
			// from its parent and the nesting reads as a list of equals.
			head.style.paddingLeft = `${12 + depth * STEP}px`;
			const twist = div(head, "ts-twist", "▾");
			const nameEl = div(head, "ts-band-name", group.label);
			// The whole key on hover: the label is the readable form, not the fact.
			nameEl.title = group.name;
			div(head, "ts-band-count", String(group.tasks.length));
			railFor(div(band, "ts-cell-track"));
			band.onclick = () => {
				const shut = block.hasClass("is-shut");
				block.toggleClass("is-shut", !shut);
				twist.setText(shut ? "▾" : "▸");
			};
		}
		// A node with children is a heading and draws none of its own rows.
		if (group.children.length) {
			for (const child of group.children) renderGroup(block, child, depth + 1);
		} else {
			for (const task of group.tasks) taskRow(block, task, group.label ? depth + 1 : 0);
		}
	};

	for (const group of groups) renderGroup(bodyEl, group, 0);

	// One scrollbar, not one per row: every track scrolls with the header.
	const tracks = Array.from(root.querySelectorAll<HTMLElement>(".ts-cell-track, .ts-head-track"));
	let syncing = false;
	for (const t of tracks) {
		t.addEventListener("scroll", () => {
			if (syncing) return;
			syncing = true;
			for (const other of tracks) if (other !== t) other.scrollLeft = t.scrollLeft;
			syncing = false;
		});
	}
	// Open on today rather than at the beginning of time.
	const start = Math.max(0, ((today() - from) / DAY) * colW - 120);
	requestAnimationFrame(() => { for (const t of tracks) t.scrollLeft = start; });

	return { root, bars, geo: { from, colW } };
}

/* ══ list ════════════════════════════════════════════════════════════════
 * Rows as cards, grouped into foldable blocks.
 *
 * Everything that is not the task name is on the right and quiet: priority,
 * tags, the dates, the file it came from. A list is read down the left edge,
 * so the left edge carries only what is being looked for, and the right edge
 * carries what is checked once something has been found.
 *
 * `data-icon` leaves the icon to the caller. Nothing in this file imports
 * Obsidian, which is what lets the same drawing run in a test, a code block
 * and a pane.
 */
export function list(host: HTMLElement, groups: Group[], q: Query): Drawn {
	const bars: Drawn["bars"] = [];
	const root = div(host, "ts-list");
	const now = today();

	const PRIO: Record<string, [string, string]> = {
		highest: ["chevrons-up", "Highest"],
		high: ["chevron-up", "High"],
		medium: ["equal", "Medium"],
		low: ["chevron-down", "Low"],
		lowest: ["chevrons-down", "Lowest"],
	};

	let n = 0;

	const taskRow = (block: HTMLElement, task: Task, depth: number) => {
		n++;
		const late = task.status === "open" && task.end < now;
		const row = div(block, `ts-list-row ${stateOf(task)}${depth ? " is-child" : ""}`);
		// The accent on the left is the status, and the status is the only
		// thing it is. Saying so on the row means the legend is a reminder
		// rather than the only way to know.
		row.setAttr("aria-label", `${task.status === "open" && late ? "overdue" : task.status}`);

		div(row, "ts-num", String(n));
		if (q.show?.checkbox !== false) {
			const box = div(row, "ts-box");
			box.setAttr("data-toggle", "1");
			bars.push({ task, node: box });
		}
		div(row, "ts-name", task.text);

		const right = div(row, "ts-list-right");

		if (task.priority !== "normal" && q.show?.priority !== false) {
			const [icon, label] = PRIO[task.priority];
			const p = div(right, `ts-prio-mark is-${task.priority}`);
			p.setAttr("data-icon", icon);
			p.setAttr("aria-label", `${label} priority`);
		}

		if (task.tags.length && q.show?.tags !== false) {
			const tags = div(right, "ts-tags");
			// Two tags and a count: a row of eight chips is a row nobody reads.
			for (const t of task.tags.slice(0, 2)) {
				div(tags, "ts-tag", t.replace(/^#/, "")).setAttr("aria-label", t);
			}
			if (task.tags.length > 2) {
				div(tags, "ts-tag is-more", `+${task.tags.length - 2}`)
					.setAttr("aria-label", task.tags.join(" "));
			}
		}

		const when = div(right, "ts-when");
		if (!task.moment) {
			const st = div(when, "ts-chip");
			st.setAttr("data-icon", "plane-takeoff");
			st.setAttr("aria-label", `Starts ${short(task.start)}`);
			div(st, "ts-chip-text", short(task.start));
		}
		const due = div(when, `ts-chip${late ? " is-late" : ""}`);
		due.setAttr("data-icon", "calendar-check");
		due.setAttr("aria-label", late
			? `Overdue — was due ${short(task.end)}`
			: `Due ${short(task.end)}`);
		div(due, "ts-chip-text", short(task.end));

		if (q.show?.source !== false) {
			div(right, "ts-src", `${task.file}:${task.line + 1}`)
				.setAttr("aria-label", `${task.path}, line ${task.line + 1}`);
		}
		bars.push({ task, node: row });
		if (depth) row.style.paddingLeft = `${12 + depth * STEP}px`;
	};

	/** A band and everything beneath it — the same tree the Gantt draws. */
	const renderGroup = (host: HTMLElement, group: Group, depth: number) => {
		const block = div(host, `ts-group${depth ? " is-nested" : ""}`);
		if (group.label) {
			const band = div(block, `ts-list-band is-depth-${Math.min(depth, 2)}`);
			band.style.paddingLeft = `${12 + depth * STEP}px`;
			const twist = div(band, "ts-twist", "▾");
			const nameEl = div(band, "ts-band-name", group.label);
			nameEl.title = group.name;
			const open = group.tasks.filter((t) => t.status === "open").length;
			div(band, "ts-band-count", `${open}/${group.tasks.length}`);
			band.onclick = () => {
				const shut = block.hasClass("is-shut");
				block.toggleClass("is-shut", !shut);
				twist.setText(shut ? "▾" : "▸");
			};
		}
		if (group.children.length) {
			for (const child of group.children) renderGroup(block, child, depth + 1);
		} else {
			for (const task of group.tasks) taskRow(block, task, group.label ? depth + 1 : 0);
		}
	};

	for (const group of groups) renderGroup(root, group, 0);

	if (!bars.length) {
		div(root, "ts-day-none", "Nothing to show.");
		return { root, bars };
	}

	// The left edge of every row is a colour, and a colour nobody can decode is
	// decoration. One quiet line is cheaper than making people guess.
	const key = div(root, "ts-legend");
	for (const [cls, label] of [
		["is-open", "To do"], ["is-doing", "In progress"], ["is-late", "Overdue"],
		["is-done", "Done"], ["is-cancelled", "Cancelled"],
	]) {
		const item = div(key, "ts-legend-item");
		div(item, `ts-legend-dot ${cls}`);
		div(item, "ts-legend-text", label);
	}
	return { root, bars };
}

/* ══ month ═══════════════════════════════════════════════════════════════
 * Week rows, each with its own lanes.
 *
 * The first version repeated a chip on every day a task touched, which reads
 * as six tasks rather than one task lasting six days, and stacks into an
 * unreadable pile the moment two of them overlap. A bar spanning its days —
 * clipped to the week row, with an arrow where it continues — says the same
 * thing in one mark.
 */
export function month(host: HTMLElement, groups: Group[], q: Query): Drawn {
	const tasks = groups.flatMap((g) => g.tasks);
	const bars: Drawn["bars"] = [];
	const days: NonNullable<Drawn["days"]> = [];

	const first = new Date(q.cursor);
	first.setDate(1);
	first.setHours(0, 0, 0, 0);
	const gridFrom = weekStartOf(first.getTime(), q.weekStart ?? 1);

	const root = div(host, "ts-month");
	const head = div(root, "ts-m-head");
	div(head, "ts-m-gutter");
	for (const d of dow(q.weekStart ?? 1)) div(head, "ts-m-dow", d);

	for (let w = 0; w < 6; w++) {
		const rowFrom = gridFrom + w * 7 * DAY;
		const rowTo = rowFrom + 6 * DAY;
		if (w === 5 && new Date(rowFrom).getMonth() !== first.getMonth()
			&& new Date(rowTo).getMonth() !== first.getMonth()) break;

		const row = div(root, "ts-m-row");
		div(row, "ts-m-gutter", `W${isoWeek(rowFrom)}`);
		// The body is in normal flow so the row grows with its lanes. The cell
		// borders and tints are a backdrop behind it; drawn as the content, they
		// forced a fixed height and the lanes spilled into the next week.
		const body = div(row, "ts-m-body");
		const bg = div(body, "ts-m-bg");
		const nums = div(body, "ts-m-nums");
		for (let i = 0; i < 7; i++) {
			const at = rowFrom + i * DAY;
			const d = new Date(at);
			const other = d.getMonth() !== first.getMonth();
			const klass = `${other ? " is-other" : ""}${at === today() ? " is-today" : ""}`;
			div(bg, `ts-m-cell${klass}`);
			const cell = div(nums, `ts-m-numcell${klass}`);
			const num = div(cell, "ts-m-num", String(d.getDate()));
			days.push({ at, node: num });
		}

		const here = tasks
			.filter((t) => midnight(t.end) >= rowFrom && midnight(t.start) <= rowTo)
			.sort((a2, b2) => a2.start - b2.start || b2.end - a2.end);
		const col = (at: number) => Math.max(0, Math.min(6, Math.round((midnight(at) - rowFrom) / DAY)));
		const lanes: Task[][] = [];
		for (const t of here) {
			const x1 = col(t.start);
			const x2 = col(t.end);
			let lane = lanes.find((l) => l.every((o) => col(o.end) < x1 || col(o.start) > x2));
			if (!lane) { lane = []; lanes.push(lane); }
			lane.push(t);
		}

		const laneHost = div(body, "ts-m-lanes");
		const drawLane = (lane: Task[], into: HTMLElement) => {
			const l = div(into, "ts-m-lane");
			for (const t of lane) {
				const x1 = col(t.start);
				const x2 = col(t.end);
				const bar = div(l, `ts-m-bar ${stateOf(t)}`);
				bar.style.left = `calc(${(x1 / 7) * 100}% + 2px)`;
				bar.style.width = `calc(${((x2 - x1 + 1) / 7) * 100}% - 4px)`;
				if (midnight(t.end) > rowTo) bar.addClass("runs-on");
				if (midnight(t.start) < rowFrom) bar.addClass("runs-from");
				div(bar, "ts-box");
				div(bar, "ts-m-name", t.text);
				bars.push({ task: t, node: bar });
			}
		};

		// Three lanes, then a count. A week with twelve overlapping tasks would
		// otherwise be a screen of its own, and the month stops being a month.
		const SHOWN = q.lanes ?? 3;
		for (const lane of lanes.slice(0, SHOWN)) drawLane(lane, laneHost);
		if (lanes.length > SHOWN) {
			const hidden = lanes.length - SHOWN;
			const rest = div(laneHost, "ts-m-rest is-hidden");
			for (const lane of lanes.slice(SHOWN)) drawLane(lane, rest);
			const shut = `${hidden} more…`;
			const more = div(laneHost, "ts-m-more", shut);
			more.onclick = (ev) => {
				ev.stopPropagation();
				const closed = !rest.hasClass("is-hidden");
				rest.toggleClass("is-hidden", closed);
				more.setText(closed ? shut : "Show fewer");
			};
		}
	}
	return { root, bars, days };
}

/* ══ year ════════════════════════════════════════════════════════════════
 * Twelve months, and a dot for every task that *starts* that day.
 *
 * Starts, not spans. A task running six weeks would otherwise shade six weeks
 * of the year, and a year of shading says nothing — whereas the days work
 * begins on are exactly the shape of a plan seen from a distance.
 */
export function year(host: HTMLElement, groups: Group[], q: Query): Drawn {
	const tasks = groups.flatMap((g) => g.tasks);
	const bars: Drawn["bars"] = [];
	const days: NonNullable<Drawn["days"]> = [];
	const y = new Date(q.cursor).getFullYear();

	const starting = new Map<number, Task[]>();
	for (const t of tasks) {
		const at = midnight(t.start);
		const list = starting.get(at);
		if (list) list.push(t);
		else starting.set(at, [t]);
	}

	const root = div(host, "ts-year");
	const months = div(root, "ts-months");
	const NAMES = ["January", "February", "March", "April", "May", "June", "July",
		"August", "September", "October", "November", "December"];

	for (let m = 0; m < 12; m++) {
		const box = div(months, "ts-mbox");
		// The month name is the way back to the month, and the week numbers the
		// way into a week. A year nobody can step down from is a poster.
		const name = div(box, "ts-mname", NAMES[m]);
		days.push({ at: new Date(y, m, 1).getTime(), node: name, view: "month" });

		const grid = div(box, "ts-ygrid");
		div(grid, "ts-yweekhead");
		for (const d of dow(q.weekStart ?? 1)) div(grid, "ts-ydow", d[0]);

		const firstOf = new Date(y, m, 1);
		const dim = new Date(y, m + 1, 0).getDate();
		let cursor = weekStartOf(firstOf.getTime(), q.weekStart ?? 1);

		while (cursor <= new Date(y, m, dim).getTime()) {
			const wk = div(grid, "ts-yweek", String(isoWeek(cursor)));
			days.push({ at: cursor, node: wk, view: "week" });

			for (let i = 0; i < 7; i++) {
				const at = cursor + i * DAY;
				const d = new Date(at);
				if (d.getMonth() !== m) { div(grid, "ts-yday is-blank"); continue; }

				const here = starting.get(at) ?? [];
				const cell = div(grid, `ts-yday${here.length ? " has-tasks" : ""}${at === today() ? " is-today" : ""}`);
				div(cell, "ts-ynum", String(d.getDate()));
				days.push({ at, node: cell, view: "day", tasks: here });

				if (!here.length) continue;
				const dots = div(cell, "ts-ydots");
				// Three dots and a count. Four in a cell this size is a smudge.
				const cap = q.dots ?? 3;
				for (const t of here.slice(0, cap)) div(dots, `ts-ydot ${stateOf(t)}`);
				if (here.length > cap) div(dots, "ts-ymore", `+${here.length - cap}`);
			}
			cursor += 7 * DAY;
		}
	}
	return { root, bars, days };
}

/* ══ day ═════════════════════════════════════════════════════════════════
 * One day: everything running on it above, an hour grid below.
 *
 * The grid is mostly empty for tasks that carry dates and no times, and that
 * is the honest picture. It earns its place for the now line, which is the one
 * thing a day view says that a list does not: how much of the day is left.
 */
export function day(host: HTMLElement, groups: Group[], q: Query): Drawn {
	const tasks = groups.flatMap((g) => g.tasks);
	const bars: Drawn["bars"] = [];
	const on = midnight(q.cursor);

	const root = div(host, "ts-day-view");
	const running = tasks
		.filter((t) => on >= midnight(t.start) && on <= midnight(t.end))
		.sort((a, b) => a.end - b.end);

	const left = div(root, "ts-day-main");
	div(left, "ts-day-h1", on === today() ? "Today's tasks" : `Tasks on ${short(on)}`);
	div(left, "ts-allday-label", `All day · ${running.length}`);

	const band = div(left, "ts-allday");
	if (!running.length) div(band, "ts-day-none", "Nothing runs on this day.");
	for (const task of running) {
		const row = div(band, `ts-allday-row ${stateOf(task)}`);
		div(row, "ts-box");
		div(row, "ts-name", task.text);
		const due = div(row, "ts-date",
			midnight(task.end) === on ? "due today" : `due ${short(task.end)}`);
		if (task.end < today() && task.status === "open") due.addClass("is-late");
		bars.push({ task, node: row });
	}

	const grid = div(left, "ts-hours");
	const slots: NonNullable<Drawn["slots"]>[number][] = [];
	for (let h = 0; h < 24; h++) {
		const row = div(grid, "ts-hour");
		div(row, "ts-hour-label", `${String(h).padStart(2, "0")}:00`);
		const slot = div(row, "ts-hour-slot");
		const hint = div(slot, "ts-slot-hint");
		div(hint, "ts-slot-time", `${String(h).padStart(2, "0")}:00`);
		div(hint, "ts-slot-plus", "+");
		slots.push({ at: on, label: `${String(h).padStart(2, "0")}:00`, node: slot });
	}
	if (on === today()) {
		const now = new Date();
		const line = div(grid, "ts-now");
		line.style.top = `${((now.getHours() * 60 + now.getMinutes()) / 60) * HOUR_DAY + 1}px`;
		div(line, "ts-now-dot");
	}
	return { root, bars, slots };
}

/* ══ week ════════════════════════════════════════════════════════════════
 * Seven days across, an all-day band over an hour grid. The band gets lanes:
 * a task spanning Monday to Wednesday is one bar three columns wide.
 */
export function week(host: HTMLElement, groups: Group[], q: Query): Drawn {
	const tasks = groups.flatMap((g) => g.tasks);
	const bars: Drawn["bars"] = [];
	const days: NonNullable<Drawn["days"]> = [];
	const from = weekStartOf(q.cursor, q.weekStart ?? 1);
	const span = Array.from({ length: 7 }, (_, i) => from + i * DAY);
	const last = span[6];

	const root = div(host, "ts-week");
	const head = div(root, "ts-week-head");
	div(head, "ts-week-gutter");
	for (const at of span) {
		const d = new Date(at);
		const cell = div(head, `ts-week-day${at === today() ? " is-today" : ""}`);
		div(cell, "ts-week-dow", DOW_FROM_SUN[d.getDay()]);
		div(cell, "ts-week-num", String(d.getDate()));
		days.push({ at, node: cell });
	}

	const here = tasks
		.filter((t) => midnight(t.end) >= from && midnight(t.start) <= last)
		.sort((a, b) => a.start - b.start || b.end - a.end);
	const col = (at: number) => Math.max(0, Math.min(6, Math.round((midnight(at) - from) / DAY)));
	const lanes: Task[][] = [];
	for (const t of here) {
		const a = col(t.start);
		const b = col(t.end);
		let lane = lanes.find((row) => row.every((o) => col(o.end) < a || col(o.start) > b));
		if (!lane) { lane = []; lanes.push(lane); }
		lane.push(t);
	}

	const band = div(root, "ts-week-allday");
	div(band, "ts-week-gutter", "All day");
	const laneHost = div(band, "ts-week-lanes");
	const SHOWN = q.lanes ?? 3;
	const hidden = Math.max(0, lanes.length - SHOWN);

	const drawLane = (lane: Task[], into: HTMLElement) => {
		const row = div(into, "ts-week-lane");
		for (let i = 0; i < 7; i++) div(row, "ts-week-slot");
		for (const t of lane) {
			const a = col(t.start);
			const b = col(t.end);
			const bar = div(row, `ts-week-bar ${stateOf(t)}`);
			bar.style.left = `calc(${(a / 7) * 100}% + 2px)`;
			bar.style.width = `calc(${((b - a + 1) / 7) * 100}% - 4px)`;
			if (midnight(t.end) > last) bar.addClass("runs-on");
			if (midnight(t.start) < from) bar.addClass("runs-from");
			div(bar, "ts-box");
			div(bar, "ts-week-name", t.text);
			bars.push({ task: t, node: bar });
		}
	};

	for (const lane of lanes.slice(0, SHOWN)) drawLane(lane, laneHost);
	if (hidden > 0) {
		const rest = div(laneHost, "ts-week-rest is-hidden");
		for (const lane of lanes.slice(SHOWN)) drawLane(lane, rest);
		const shut = `${hidden} more all-day task${hidden === 1 ? "" : "s"}…`;
		const more = div(laneHost, "ts-week-more", shut);
		more.onclick = () => {
			const closed = !rest.hasClass("is-hidden");
			rest.toggleClass("is-hidden", closed);
			more.setText(closed ? shut : "Collapse all-day tasks");
			more.toggleClass("is-open", !closed);
		};
	}

	const grid = div(root, "ts-week-hours");
	const slots: NonNullable<Drawn["slots"]>[number][] = [];
	for (let h = 0; h < 24; h++) {
		const row = div(grid, "ts-week-hour");
		div(row, "ts-week-gutter", `${String(h).padStart(2, "0")}:00`);
		for (const at of span) {
			const slot = div(row, `ts-week-cell${at === today() ? " is-today" : ""}`);
			const hint = div(slot, "ts-slot-hint");
			div(hint, "ts-slot-time", `${String(h).padStart(2, "0")}:00`);
			div(hint, "ts-slot-plus", "+");
			slots.push({ at, label: `${String(h).padStart(2, "0")}:00`, node: slot });
		}
	}
	if (today() >= from && today() <= last) {
		const now = new Date();
		const line = div(grid, "ts-now");
		line.style.top = `${((now.getHours() * 60 + now.getMinutes()) / 60) * HOUR_WEEK + 1}px`;
		div(line, "ts-now-dot");
	}
	return { root, bars, slots, days };
}

export const LAYOUTS = { day, week, month, year, list, gantt };
