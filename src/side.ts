/**
 * The sidebar.
 *
 * Two tabs over the whole vault: everything outstanding, and today.
 *
 * It is deliberately not the main view in a narrow pane. A sidebar is read
 * while doing something else, so it answers two questions and no others —
 * "what is outstanding" and "what is today" — and it answers them without a
 * toolbar of controls to set first.
 *
 * The drawing of the timeline is the same `day` layout the main view uses. The
 * list is its own, because a sidebar list wants cards rather than a table: at
 * 300px a row of columns is a row of ellipses.
 */

import { ItemView, Menu, WorkspaceLeaf, debounce, setIcon } from "obsidian";
import { LAYOUTS } from "./draw";
import { parseQuery } from "./query";
import { collect } from "./tasks";
import type TaskSpan from "./main";
import type { Priority, Query, Sort, Status, Task } from "./types";

export const SIDE_VIEW = "task-span-side";

type Tab = "list" | "timeline";

const DAY = 86_400_000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
	"Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export class SideView extends ItemView {
	private tab: Tab = "list";
	private cursor = new Date().setHours(0, 0, 0, 0);
	private search = "";
	private hideDone = true;
	private status: Status[] = [];
	private priorities: Priority[] = [];
	private tags: string[] = [];
	private sort: Sort = "due";
	private window: Query["window"] = "all";
	private body!: HTMLElement;
	private tabsEl!: HTMLElement;
	private stop?: () => void;

	constructor(leaf: WorkspaceLeaf, private plugin: TaskSpan) { super(leaf); }

	getViewType() { return SIDE_VIEW; }
	getDisplayText() { return "Task Span"; }
	getIcon() { return "list-checks"; }

	async onOpen() {
		const root = this.contentEl;
		root.empty();
		root.addClass("task-span", "ts-sidebar");

		this.tabsEl = root.createDiv({ cls: "ts-side-tabs" });
		for (const [id, label, icon] of [
			["list", "Task list", "list-checks"],
			["timeline", "Daily timeline", "clock"],
		] as [Tab, string, string][]) {
			const t = this.tabsEl.createDiv({ cls: `ts-side-tab${id === this.tab ? " is-on" : ""}` });
			setIcon(t.createSpan({ cls: "ts-tab-icon" }), icon);
			t.createSpan({ text: label });
			t.onclick = () => {
				this.tab = id;
				for (const el of Array.from(this.tabsEl.children)) el.removeClass("is-on");
				t.addClass("is-on");
				void this.draw();
			};
		}

		this.body = root.createDiv({ cls: "ts-side-main" });
		this.stop = this.plugin.watch(() => void this.draw());
		await this.draw();
	}

	private query(): Query {
		const q = parseQuery("", "");
		q.from = [""];               // the whole vault
		q.group = ["none"];
		q.sort = this.sort;
		q.status = [...this.status];
		q.priorities = [...this.priorities];
		q.tags = [...this.tags];
		q.window = this.window;
		q.dateField = "due";
		q.view = "day";
		q.cursor = this.cursor;
		q.readonly = false;
		return q;
	}

	private async draw() {
		this.body.empty();
		if (this.tab === "list") await this.drawList();
		else await this.drawTimeline();
	}

	/* ── everything outstanding ─────────────────────────────────────────── */
	private async drawList() {
		const q = this.query();
		const find = this.body.createEl("input", {
			cls: "ts-search", attr: { type: "text", placeholder: "Search tasks…" },
		});
		find.value = this.search;

		const tools = this.body.createDiv({ cls: "ts-side-tools" });
		const list = this.body.createDiv({ cls: "ts-side-list" });
		const all = await collect(this.plugin.app, q);

		// Every tag present in what came back, so the menu never offers a filter
		// that would empty the list.
		const tagsHere = [...new Set(all.flatMap((t) => t.tags))].sort();

		this.pick(tools, "filter", "Status", this.status.length > 0,
			["open", "doing", "done", "cancelled"], this.status as string[],
			(v) => { this.status = v as Status[]; });
		this.pick(tools, "flame", "Priority", this.priorities.length > 0,
			["highest", "high", "medium", "normal", "low", "lowest"], this.priorities as string[],
			(v) => { this.priorities = v as Priority[]; });
		this.pick(tools, "tag", "Tags", this.tags.length > 0,
			tagsHere, this.tags, (v) => { this.tags = v; });
		this.one(tools, "arrow-up-down", "Sort",
			["due", "start", "name", "length", "status"], this.sort,
			(v) => { this.sort = v as Sort; });
		this.one(tools, "calendar-range", "Period",
			["all", "day", "week", "month"], this.window ?? "all",
			(v) => { this.window = v as Query["window"]; });
		const toggle = tools.createDiv({ cls: `ts-icon-btn${this.hideDone ? " is-on" : ""}` });
		setIcon(toggle, "eye-off");
		toggle.setAttr("aria-label", this.hideDone ? "Hiding finished" : "Showing finished");
		toggle.onclick = () => { this.hideDone = !this.hideDone; void this.draw(); };

		const paint = () => {
			list.empty();
			const needle = this.search.trim().toLowerCase();
			const shown = all.filter((t) =>
				(!this.hideDone || (t.status !== "done" && t.status !== "cancelled"))
				&& (!needle || t.text.toLowerCase().includes(needle)));

			if (!shown.length) {
				list.createDiv({ cls: "ts-day-none", text: "Nothing matches." });
				return;
			}
			for (const t of shown) this.card(list, t);
		};

		// Debounced, because re-rendering a few hundred cards on every keystroke
		// is felt, and the list is read while typing rather than after.
		const again = debounce(() => paint(), 150, true);
		find.oninput = () => { this.search = find.value; again(); };
		paint();
	}

	/** A menu where several can be ticked at once. */
	private pick(host: HTMLElement, icon: string, label: string, on: boolean,
		options: string[], now: string[], set: (v: string[]) => void) {
		const b = host.createDiv({ cls: `ts-icon-btn${on ? " is-on" : ""}` });
		setIcon(b, icon);
		b.setAttr("aria-label", label);
		b.onclick = () => {
			const m = new Menu();
			if (!options.length) {
				m.addItem((i) => i.setTitle("Nothing to filter by").setDisabled(true));
			}
			for (const o of options) {
				m.addItem((i) => i.setTitle(o).setChecked(now.includes(o)).onClick(() => {
					const next = now.includes(o) ? now.filter((x) => x !== o) : [...now, o];
					set(next);
					void this.draw();
				}));
			}
			if (now.length) {
				m.addSeparator();
				m.addItem((i) => i.setTitle("Clear").setIcon("x").onClick(() => {
					set([]);
					void this.draw();
				}));
			}
			const box = b.getBoundingClientRect();
			m.showAtPosition({ x: box.left, y: box.bottom + 4 });
		};
	}

	/** A menu where exactly one is chosen. */
	private one(host: HTMLElement, icon: string, label: string,
		options: string[], now: string, set: (v: string) => void) {
		const b = host.createDiv({ cls: "ts-icon-btn" });
		setIcon(b, icon);
		b.setAttr("aria-label", label);
		b.onclick = () => {
			const m = new Menu();
			for (const o of options) {
				m.addItem((i) => i.setTitle(o).setChecked(o === now).onClick(() => {
					set(o);
					void this.draw();
				}));
			}
			const box = b.getBoundingClientRect();
			m.showAtPosition({ x: box.left, y: box.bottom + 4 });
		};
	}

	private card(host: HTMLElement, t: Task) {
		const today = new Date().setHours(0, 0, 0, 0);
		const late = t.status === "open" && t.end < today;
		const card = host.createDiv({ cls: `ts-side-card is-${t.status}${late ? " is-late" : ""}` });

		const box = card.createDiv({ cls: "ts-box" });
		box.onclick = async (ev) => {
			ev.stopPropagation();
			await this.plugin.toggle(t);
		};
		const text = card.createDiv({ cls: "ts-side-card-text" });
		text.createDiv({ cls: "ts-name", text: t.text });
		const when = t.end === today ? "today"
			: t.end < today ? `${Math.round((today - t.end) / DAY)}d late`
				: `${new Date(t.end).getDate()} ${MONTHS[new Date(t.end).getMonth()]}`;
		text.createDiv({ cls: `ts-side-when${late ? " is-late" : ""}`, text: when });

		card.onclick = (ev) => void this.plugin.reveal(t, ev);
		card.oncontextmenu = (ev) => this.plugin.menu(t, ev);
	}

	/* ── today ──────────────────────────────────────────────────────────── */
	private async drawTimeline() {
		const head = this.body.createDiv({ cls: "ts-side-date" });
		const d = new Date(this.cursor);
		head.createSpan({
			cls: "ts-side-date-text",
			text: `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")} ${DOW[d.getDay()]}`,
		});
		const nav = head.createDiv({ cls: "ts-nav" });
		const step = (by: number) => { this.cursor += by * DAY; void this.draw(); };
		const back = nav.createDiv({ cls: "ts-icon-btn" });
		setIcon(back, "chevron-left");
		back.onclick = () => step(-1);
		const now = nav.createDiv({ cls: "ts-today-btn", text: "Today" });
		now.onclick = () => { this.cursor = new Date().setHours(0, 0, 0, 0); void this.draw(); };
		const fwd = nav.createDiv({ cls: "ts-icon-btn" });
		setIcon(fwd, "chevron-right");
		fwd.onclick = () => step(1);

		const q = this.query();
		const tasks = await collect(this.plugin.app, q);
		const { bars } = LAYOUTS.day(this.body, [{ name: "", label: "", tasks, children: [] }], q);
		for (const { task, node } of bars) {
			node.addClass("is-clickable");
			node.onclick = (ev) => void this.plugin.reveal(task, ev as MouseEvent);
			node.oncontextmenu = (ev) => this.plugin.menu(task, ev as MouseEvent);
		}
	}

	async onClose() { this.stop?.(); }
}
