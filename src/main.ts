/**
 * Task Span — the tasks you already have, drawn as a timeline.
 *
 * One code block and one view, four layouts, and a single renderer behind all
 * of it. That is the whole design. The timelines that exist are views, and a
 * view cannot be embedded in a note or a canvas card; the one that is a block
 * bakes its own colours in and ignores the theme around it. This does both,
 * from the same drawing code, so the pane and the card can never disagree.
 *
 * It reads and never writes. Dragging a bar to change a date is a different
 * job with a far larger surface — file writes, conflicting edits, undo — and
 * there is already a good plugin doing it. This one shows the plan.
 */

import {
	App,
	ItemView,
	MarkdownPostProcessorContext,
	MarkdownRenderer,
	moment,
	MarkdownRenderChild,
	Menu,
	Modal,
	Notice,
	Plugin,
	Setting,
	TFile,
	WorkspaceLeaf,
	debounce,
	setIcon,
} from "obsidian";
import { LAYOUTS, grouped } from "./draw";
import { attachDrag } from "./drag";
import { NewTask } from "./newtask";
import { SIDE_VIEW, SideView } from "./side";
import { DEFAULTS, SavedView, Settings, SettingsTab } from "./settings";
import { remove, replaceNote, setDates, setStatus, shift } from "./edit";
import { parseQuery } from "./query";
import { collect, groupTasks } from "./tasks";
import type { GroupBy, Query, Task, View } from "./types";

export const VIEW_TYPE = "task-span-view";

/**
 * The six views, in two bands.
 *
 * `calendar` answers "what is happening then" and the date does the grouping.
 * `work` answers "what is there and whose is it", which is the only place
 * grouping means anything. They are drawn as two separate strips because they
 * are two different questions, and a control that applies to half a row of
 * tabs should not look like it applies to all of it.
 */
const VIEWS: { id: View; label: string; icon: string; band: "calendar" | "work" }[] = [
	{ id: "day", label: "Day", icon: "sun", band: "calendar" },
	{ id: "week", label: "Week", icon: "columns-3", band: "calendar" },
	{ id: "month", label: "Month", icon: "layout-grid", band: "calendar" },
	{ id: "year", label: "Year", icon: "book-open", band: "calendar" },
	{ id: "list", label: "Tasks", icon: "list-checks", band: "work" },
	{ id: "gantt", label: "Gantt", icon: "gantt-chart", band: "work" },
];

/** The views grouping applies to. Everywhere else the date is the grouping. */
const GROUPABLE: View[] = ["list", "gantt"];


/** Draw a query into a host element, and wire every bar back to its line. */
async function paint(
	plugin: TaskSpan, host: HTMLElement, q: Query,
	/**
	 * Called when a grouping level is dropped or added from the footer.
	 *
	 * A pane passes one; a code block does not, and its pills are therefore a
	 * read-out rather than a control — a block's grouping is written in the
	 * block, so letting it be clicked away would last until the next render and
	 * then silently come back.
	 */
	onGroup?: (next: GroupBy[]) => void,
) {
	host.empty();
	// Settings are defaults; the query is the exception. Anything the block did
	// not say for itself is filled in here, once, rather than in six layouts.
	const s = plugin.settings;
	q.lanes = q.lanes ?? s.monthLanes;
	q.dots = q.dots ?? s.yearDots;
	q.strike = s.strikeDone;
	host.toggleClass("is-strike", s.strikeDone);
	q.weekStart = s.weekStart;
	q.daily = s.showDailyNote;
	q.show = {
		checkbox: s.showCheckbox, tags: s.showTags,
		priority: s.showPriority, source: s.showSource,
	};

	if (q.errors.length) {
		const box = host.createDiv({ cls: "ts-problem" });
		box.createDiv({ cls: "ts-problem-head", text: "Task Span could not read this block" });
		const ul = box.createEl("ul");
		for (const e of q.errors) ul.createEl("li", { text: e });
		return;
	}

	const tasks = await collect(plugin.app, q);
	if (!tasks.length) {
		host.createDiv({
			cls: "ts-empty",
			text: `No dated tasks in ${q.from.join(", ")}. A task needs a start or a due date to be drawn.`,
		});
		return;
	}

	if (q.title) host.createDiv({ cls: "ts-title", text: q.title });

	const groups = groupTasks(tasks, q.group);
	const { bars, geo, slots, days } = LAYOUTS[q.view](host, groups, q);

	// The drawing names an icon; only this file may import Obsidian to draw it.
	//
	// The icon goes in a slot of its own, never straight onto the element that
	// named it: `setIcon` empties its host before inserting the glyph, so an
	// element carrying both an icon and text loses the text. That is how every
	// date chip in the Tasks view came to show an icon and nothing else.
	host.findAll("[data-icon]").forEach((el) => {
		const name = el.dataset.icon;
		if (!name) return;
		const slot = createSpan({ cls: "ts-icon-slot" });
		el.prepend(slot);
		setIcon(slot, name);
	});

	for (const { task, node } of bars) {
		// A checkbox ticks; everything else opens. Without this the box would
		// open the note, which is the one thing a checkbox must not do.
		if (node.dataset.toggle === "1") {
			node.addClass("is-clickable");
			plugin.registerDomEvent(node, "click", (ev) => {
				ev.stopPropagation();
				void plugin.toggle(task);
			});
			continue;
		}
		node.addClass("is-clickable");
		plugin.registerDomEvent(node, "click", (ev) => {
			// A drag ends with a click. Ignore the one that follows a move, or
			// every reschedule also opens the note.
			if (node.dataset.dragged === "1") { delete node.dataset.dragged; return; }
			void plugin.reveal(task, ev);
		});
		plugin.registerDomEvent(node, "contextmenu", (ev) => plugin.menu(task, ev));

		if (geo && q.view === "gantt" && !q.readonly) {
			attachDrag(node, task, geo, async (start, end) => {
				node.dataset.dragged = "1";
				await setDates(plugin.app, task, start, end);
			});
		}
	}

	// A hover card rather than a title attribute: the browser's tooltip takes a
	// second to appear, cannot be styled, and truncates. Scanning a month means
	// hovering a dozen bars, and a second each is a dead minute.
	const card = host.createDiv({ cls: "ts-card is-hidden" });
	// Not on the list: every row is already the whole truth, and a card over a
	// list is a card over the next row.
	const peekable = q.view !== "list";
	for (const { task, node } of bars) {
		if (!peekable || node.dataset.toggle === "1") continue;
		plugin.registerDomEvent(node, "mouseenter", () => {
			card.empty();
			card.createDiv({ cls: "ts-card-title", text: task.text });
			const rows = card.createDiv({ cls: "ts-card-rows" });
			const add = (k: string, v: string) => {
				const r = rows.createDiv({ cls: "ts-card-row" });
				r.createSpan({ cls: "ts-card-key", text: k });
				r.createSpan({ cls: "ts-card-val", text: v });
			};
			const fmt = (ms: number) => new Date(ms).toISOString().slice(0, 10);
			if (!task.moment) add("Start", fmt(task.start));
			add(task.moment ? "On" : "Due", fmt(task.end));
			card.createDiv({ cls: "ts-card-where", text: `${task.file} : ${task.line + 1}` });

			const box = node.getBoundingClientRect();
			const host2 = host.getBoundingClientRect();
			card.removeClass("is-hidden");
			const w = card.offsetWidth;
			const h = card.offsetHeight;
			// Beside the bar, never over it. Under it, the card covered the thing
			// being hovered — so the ends could not be grabbed and the bar could
			// not be dragged.
			let left = box.right - host2.left + 10;
			if (left + w > host2.width - 4) left = box.left - host2.left - w - 10;
			card.style.left = `${Math.max(4, left)}px`;
			card.style.top = `${Math.max(4,
				Math.min(box.top - host2.top - 4, host2.height - h - 4))}px`;
		});
		plugin.registerDomEvent(node, "mouseleave", () => card.addClass("is-hidden"));
	}

	// A date steps down a level: a day cell to the day, a week number to the
	// week, a month name to the month. A calendar nobody can step down from is
	// a poster.
	for (const d of days ?? []) {
		d.node.addClass("is-clickable");
		plugin.registerDomEvent(d.node, "click", (ev) => {
			ev.stopPropagation();
			plugin.app.workspace.trigger("task-span:go-to-day", d.at, d.view ?? "day");
		});

		if (!d.tasks?.length) continue;
		// Hovering a day lists what starts on it, with boxes you can tick. The
		// card keeps itself open while the pointer is inside it, or there would
		// be no way to reach the boxes.
		let shut: number | undefined;
		const open = () => {
			window.clearTimeout(shut);
			card.empty();
			card.createDiv({
				cls: "ts-card-title",
				text: new Date(d.at).toDateString().slice(0, 10),
			});
			const list = card.createDiv({ cls: "ts-card-list" });
			for (const t of d.tasks ?? []) {
				const row = list.createDiv({ cls: `ts-card-task is-${t.status}` });
				const box = row.createDiv({ cls: "ts-box" });
				box.onclick = async (e) => { e.stopPropagation(); await plugin.toggle(t); };
				const label = row.createDiv({ cls: "ts-name", text: t.text });
				label.onclick = (e) => void plugin.reveal(t, e as MouseEvent);
			}
			const box = d.node.getBoundingClientRect();
			const outer = host.getBoundingClientRect();
			card.removeClass("is-hidden");
			card.addClass("is-live");
			const w = card.offsetWidth;
			const h = card.offsetHeight;
			// Beside the day, never over it. Covering the cell hides which day is
			// being read, which is the one thing the card is about.
			let left = box.right - outer.left + 8;
			if (left + w > outer.width - 4) left = box.left - outer.left - w - 8;
			card.style.left = `${Math.max(4, left)}px`;
			card.style.top = `${Math.max(4,
				Math.min(box.top - outer.top - 6, outer.height - h - 4))}px`;
		};
		const close = () => { shut = window.setTimeout(() => card.addClass("is-hidden"), 180); };
		plugin.registerDomEvent(d.node, "mouseenter", open);
		plugin.registerDomEvent(d.node, "mouseleave", close);
		plugin.registerDomEvent(card, "mouseenter", () => window.clearTimeout(shut));
		plugin.registerDomEvent(card, "mouseleave", close);
	}

	for (const slot of slots ?? []) {
		if (q.readonly) break;
		plugin.registerDomEvent(slot.node, "click", () =>
			new NewTask(plugin.app, q, slot.at).open());
	}

	if (!q.readonly && q.add) {
		const add = host.createDiv({ cls: "ts-add", text: "+  Add a task" });
		plugin.registerDomEvent(add, "click", () => new NewTask(plugin.app, q).open());
	}

	// The footer carries the grouping as well as the counts. It is the one line
	// that already exists on every view, so saying it here costs no height at
	// all — which was the whole objection to a context row of its own.
	const done = tasks.filter((t) => t.status === "done").length;
	const foot = host.createDiv({ cls: "ts-foot" });

	const left = foot.createDiv({ cls: "ts-foot-group" });
	const levels = q.group.filter((g) => g !== "none");
	if (levels.length && (q.view === "list" || q.view === "gantt")) {
		left.createSpan({ cls: "ts-foot-label", text: "Grouped by" });
		for (const [i, level] of levels.entries()) {
			if (i) left.createSpan({ cls: "ts-foot-arrow", text: "›" });
			const pill = left.createDiv({ cls: "ts-pill" });
			pill.createSpan({ text: level.replace(/^property:/, "") });
			// A property and a folder are different kinds of thing and group
			// differently; the icon says which without spending a word on it.
			if (level.startsWith("property:")) {
				pill.setAttr("aria-label", `The "${level.slice(9)}" property on each note`);
				pill.addClass("is-prop");
			}
			if (!onGroup) continue;
			const x = pill.createDiv({ cls: "ts-pill-x" });
			setIcon(x, "x");
			x.setAttr("aria-label", `Stop grouping by ${level.replace(/^property:/, "")}`);
			x.onclick = (ev) => {
				ev.stopPropagation();
				const next = levels.filter((g) => g !== level);
				onGroup(next.length ? next : ["none"]);
			};
		}
	}

	const right = foot.createDiv({ cls: "ts-foot-counts" });
	right.setText(`${tasks.length} task${tasks.length === 1 ? "" : "s"}`
		+ (done ? ` · ${done} done` : "")
		+ (!grouped(q) ? "" : ` · ${groups.length} group${groups.length === 1 ? "" : "s"}`));
}

export default class TaskSpan extends Plugin {
	settings: Settings = { ...DEFAULTS };
	private blocks = new Set<() => void>();

	async onload() {
		this.settings = Object.assign({}, DEFAULTS, await this.loadData());
		this.addSettingTab(new SettingsTab(this.app, this));
		this.applyDensity();

		for (const name of ["span", "taskspan"]) {
			this.registerMarkdownCodeBlockProcessor(name, (src, el, ctx) => this.block(src, el, ctx));
		}

		this.registerView(VIEW_TYPE, (leaf) => new SpanView(leaf, this));
		this.registerView(SIDE_VIEW, (leaf) => new SideView(leaf, this));
		this.addRibbonIcon("calendar-range", "Task Span", () => void this.open());
		this.addRibbonIcon("list-checks", "Task Span — sidebar", () => void this.openSide());
		this.addCommand({ id: "open", name: "Open Task Span", callback: () => void this.open() });
		this.addCommand({
			id: "open-sidebar", name: "Open the Task Span sidebar",
			callback: () => void this.openSide(),
		});

		// A timeline that disagrees with the file beneath it is worse than no
		// timeline. Debounced, because a redraw on every keystroke is a redraw of
		// everything on screen.
		// After layout, never during: opening a leaf while the workspace is still
		// being restored fights with the layout Obsidian is rebuilding, and the
		// pane lands somewhere nobody put it.
		this.app.workspace.onLayoutReady(() => {
			if (this.settings.openOnStart) void this.openSide(false);
		});

		const refresh = debounce(() => this.blocks.forEach((f) => f()), 400, true);
		this.registerEvent(this.app.vault.on("modify", (f) => {
			if (f instanceof TFile && f.extension === "md") refresh();
		}));
		this.registerEvent(this.app.vault.on("rename", () => refresh()));
		this.registerEvent(this.app.vault.on("delete", () => refresh()));
	}

	async open() {
		const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE);
		if (existing.length) {
			await this.app.workspace.revealLeaf(existing[0]);
			return;
		}
		const leaf = this.app.workspace.getLeaf("tab");
		await leaf.setViewState({ type: VIEW_TYPE, active: true });
	}

	/** The sidebar belongs on the right: it is read while doing something else. */
	/** `focus` is false on startup: appearing is one thing, stealing the cursor another. */
	async openSide(focus = true) {
		const existing = this.app.workspace.getLeavesOfType(SIDE_VIEW);
		if (existing.length) {
			if (focus) await this.app.workspace.revealLeaf(existing[0]);
			return;
		}
		const leaf = this.app.workspace.getRightLeaf(false);
		if (!leaf) return;
		await leaf.setViewState({ type: SIDE_VIEW, active: focus });
		if (focus) await this.app.workspace.revealLeaf(leaf);
	}

	/** Tick or untick, from wherever the checkbox was clicked. */
	async toggle(task: Task) {
		await setStatus(this.app, task, task.status === "done" ? "open" : "done");
	}

	/** Open the note at the line that drew this bar. */
	async reveal(task: Task, ev: MouseEvent) {
		ev.preventDefault();
		const file = this.app.vault.getAbstractFileByPath(task.path);
		if (!(file instanceof TFile)) return;
		const leaf = this.app.workspace.getLeaf(ev.ctrlKey || ev.metaKey ? "tab" : false);
		await leaf.openFile(file, { eState: { line: task.line } });
	}

	/** Right-click a bar: the handful of edits worth making without leaving the chart. */
	menu(task: Task, ev: MouseEvent) {
		ev.preventDefault();
		const m = new Menu();
		m.addItem((i) => i.setTitle("Open the line").setIcon("file-text")
			.onClick(() => void this.reveal(task, ev)));
		m.addSeparator();
		if (task.status !== "done") {
			m.addItem((i) => i.setTitle("Mark done").setIcon("check")
				.onClick(() => void setStatus(this.app, task, "done")));
		} else {
			m.addItem((i) => i.setTitle("Reopen").setIcon("rotate-ccw")
				.onClick(() => void setStatus(this.app, task, "open")));
		}
		m.addItem((i) => i.setTitle("In progress").setIcon("play")
			.onClick(() => void setStatus(this.app, task, "doing")));
		m.addItem((i) => i.setTitle("Cancel").setIcon("x")
			.onClick(() => void setStatus(this.app, task, "cancelled")));
		m.addSeparator();
		for (const [label, days] of [["Postpone a day", 1], ["Postpone a week", 7]] as const) {
			m.addItem((i) => i.setTitle(label).setIcon("calendar-plus")
				.onClick(() => void shift(this.app, task, days)));
		}
		m.addItem((i) => i.setTitle("Pull forward a week").setIcon("calendar-minus")
			.onClick(() => void shift(this.app, task, -7)));
		m.addSeparator();
		m.addItem((i) => i.setTitle("Delete the line").setIcon("trash").onClick(() => {
			// Deleting somebody's line is the one thing worth a question.
			new Confirm(this.app, `Delete "${task.text}" from ${task.file}?`,
				() => void remove(this.app, task)).open();
		}));
		m.showAtMouseEvent(ev);
	}

	/** Anything that should be redrawn when a file changes. */
	watch(redraw: () => void): () => void {
		this.blocks.add(redraw);
		return () => this.blocks.delete(redraw);
	}

	private async block(src: string, host: HTMLElement, ctx: MarkdownPostProcessorContext) {
		const root = host.createDiv({ cls: "task-span" });
		const redraw = () => void paint(this, root, parseQuery(src, ctx.sourcePath));
		await paint(this, root, parseQuery(src, ctx.sourcePath));

		// A block lives as long as the pane that drew it. Tying the redraw to a
		// render child is what stops a closed note's timeline being repainted
		// every time any file is saved.
		const child = new MarkdownRenderChild(root);
		child.register(this.watch(redraw));
		ctx.addChild(child);
	}

	/**
	 * Row height and day width are read by the stylesheet, so they are written
	 * as custom properties on the document rather than threaded through every
	 * layout. One place to set them, and the CSS stays declarative.
	 */
	applyDensity() {
		const root = document.body;
		root.style.setProperty("--ts-row-set", `${this.settings.rowHeight}px`);
		root.style.setProperty("--ts-col-set", `${this.settings.ganttColumn}px`);
	}

	async saveSettings() {
		await this.saveData(this.settings);
		this.applyDensity();
		this.blocks.forEach((f) => f());
	}

	onunload() {
		this.blocks.clear();
	}
}

/* ══ the view ════════════════════════════════════════════════════════════
 * A toolbar and a drawing. Everything below the toolbar is the same code the
 * code block runs, which is the point: one renderer, two hosts.
 */
class SpanView extends ItemView {
	private q: Query;
	private body!: HTMLElement;
	private caption!: HTMLElement;
	private nav!: HTMLElement;
	private side!: HTMLElement;
	private handle!: HTMLElement;
	private tabs!: HTMLElement;
	private listOnly!: HTMLElement;
	/** Tags present in what the last draw returned, so a filter cannot empty the list. */
	private tagsSeen: string[] = [];
	/** Remembered across view switches, because re-dragging it every time is a tax. */
	private sideWidth = 40;
	private stop?: () => void;

	/** The saved view this pane is showing, if any. */
	private appliedView: string | null = null;
	private groupBtn?: HTMLElement;
	private viewsBtn?: HTMLElement;

	constructor(leaf: WorkspaceLeaf, private plugin: TaskSpan) {
		super(leaf);
		this.q = parseQuery("", "");
		this.q.from = [plugin.settings.defaultScope || ""];
		const s = plugin.settings;
		this.q.group = [s.defaultGroup];
		this.q.sort = s.defaultSort;
		this.q.scale = s.defaultScale;
		this.q.view = s.defaultView;
		// A chosen starting view wins over the loose defaults above, but only
		// here: a pane restored from saved state has its own answers already.
		const start = s.views.find((v) => v.name === s.startView);
		if (start) this.applyView(start);
	}

	getViewType() { return VIEW_TYPE; }
	getDisplayText() { return "Task Span"; }
	getIcon() { return "calendar-range"; }

	async onOpen() {
		const root = this.contentEl;
		root.empty();
		root.addClass("task-span", "is-view");

		const bar = root.createDiv({ cls: "ts-toolbar" });

		const strip = bar.createDiv({ cls: "ts-tabstrip" });
		this.tabs = strip;
		for (const band of ["calendar", "work"] as const) {
			const tabs = strip.createDiv({ cls: `ts-tabs is-${band}` });
			for (const v of VIEWS.filter((x) => x.band === band)) {
				const tab = tabs.createDiv({ cls: `ts-tab${v.id === this.q.view ? " is-on" : ""}` });
				tab.setAttr("data-view", v.id);
				setIcon(tab.createSpan({ cls: "ts-tab-icon" }), v.icon);
				tab.createSpan({ text: v.label });
				tab.onclick = () => {
					this.q.view = v.id;
					this.litTab(v.id);
					void this.redraw();
				};
			}
		}

		// The caption sits in the middle, as it does in every calendar: it is the
		// answer to "where am I", and the middle is where the eye already is.
		this.caption = bar.createDiv({ cls: "ts-caption" });

		const right = bar.createDiv({ cls: "ts-tools" });
		this.nav = right.createDiv({ cls: "ts-nav" });
		this.iconButton(this.nav, "chevron-left", "Back", () => this.step(-1));
		const t = this.nav.createDiv({ cls: "ts-today-btn", text: "Today" });
		t.onclick = () => {
			this.q.cursor = new Date().setHours(0, 0, 0, 0);
			if (this.q.view === "gantt") { void this.redraw(); return; }
			void this.redraw();
		};
		this.iconButton(this.nav, "chevron-right", "Forward", () => this.step(1));
		this.iconButton(right, "folder-search", "Scope — which folders this pane reads",
			() => new ScopePicker(this.app, this.q.from, (picked) => {
				this.q.from = picked.length ? picked : [""];
				void this.redraw();
			}).open());
		// Only in the Tasks view: the calendars already answer "when" by being a
		// calendar, so a date window there would be a second, contradictory one.
		this.listOnly = right.createDiv({ cls: "ts-listonly" });
		this.menuButton(this.listOnly, "calendar-clock", "Which date",
			["due", "start", "scheduled", "done"], this.q.dateField ?? "due",
			(v) => { this.q.dateField = v as Query["dateField"]; });
		this.menuButton(this.listOnly, "calendar-range", "Period",
			["all", "day", "week", "month"], this.q.window ?? "all",
			(v) => { this.q.window = v as Query["window"]; });

		this.menuButton(right, "filter", "Show", ["all", "open", "late", "done", "cancelled"],
			"all", (v) => {
				this.q.status = v === "all" || v === "late" ? [] : [v as Query["status"][0]];
				this.q.late = v === "late";
			});
		this.multiButton(right, "flame", "Priority",
			["highest", "high", "medium", "normal", "low", "lowest"],
			() => this.q.priorities as string[],
			(v) => { this.q.priorities = v as Query["priorities"]; });
		this.multiButton(right, "tag", "Tags", this.tagsSeen,
			() => this.q.tags,
			(v) => { this.q.tags = v; });
		this.menuButton(right, "arrow-up-down", "Sort",
			["start", "due", "name", "length", "status"], this.q.sort,
			(v) => { this.q.sort = v as Query["sort"]; });
		this.groupButton(right);
		this.viewsButton(right);
		this.menuButton(right, "zoom-in", "Scale", ["day", "week", "month"],
			this.q.scale, (v) => { this.q.scale = v as Query["scale"]; });
		this.iconButton(right, "plus", "Add a task", () => new NewTask(this.app, this.q).open());
		// A command nobody knows the name of is a feature nobody has. The button
		// sits where the person already is when they want the sidebar.
		this.iconButton(right, "panel-right", "Open the sidebar",
			() => void this.plugin.openSide());
		this.iconButton(right, "settings", "Settings", () => {
			// `setting` is not in the public typings, but it is how Obsidian's own
			// ribbon opens a plugin's tab.
			const app = this.app as unknown as {
				setting: { open(): void; openTabById(id: string): void };
			};
			app.setting.open();
			app.setting.openTabById("task-span");
		});
		this.iconButton(right, "refresh-cw", "Refresh", () => void this.redraw());

		const split = root.createDiv({ cls: "ts-split" });
		this.body = split.createDiv({ cls: "ts-view-body" });
		this.swipeable(this.body);
		this.handle = split.createDiv({ cls: "ts-handle is-hidden" });
		this.side = split.createDiv({ cls: "ts-side is-hidden" });
		this.resizable(split);
		this.stop = this.plugin.watch(() => void this.redraw());
		// The month view asks to open a day; only the view can honour it, because
		// only the view has a cursor and tabs to move.
		this.registerEvent(this.app.workspace.on(
			"task-span:go-to-day" as "quick-preview", ((at: number, view: View = "day") => {
				this.q.cursor = at;
				this.q.view = view;
				this.litTab(view);
				void this.redraw();
			}) as never));
		await this.redraw();
	}

	/** Light one tab. By name, not by index: the tabs sit in two strips now. */
	private litTab(view: View) {
		if (!this.tabs) return;
		for (const el of Array.from(this.tabs.querySelectorAll<HTMLElement>(".ts-tab"))) {
			el.toggleClass("is-on", el.getAttr("data-view") === view);
		}
	}

	private iconButton(host: HTMLElement, icon: string, label: string, click: () => void) {
		const b = host.createDiv({ cls: "ts-icon-btn" });
		setIcon(b, icon);
		// aria-label alone: `title` as well gives two tooltips, one of them
		// Obsidian's and one the browser's, fighting each other.
		b.setAttr("aria-label", label);
		b.onclick = click;
		return b;
	}

	/** An icon whose menu allows several at once. */
	private multiButton(host: HTMLElement, icon: string, label: string,
		options: string[] | (() => string[]), now: () => string[], set: (v: string[]) => void) {
		const b = this.iconButton(host, icon, label, () => {
			const list = typeof options === "function" ? options() : options;
			const chosen = now();
			const m = new Menu();
			if (!list.length) m.addItem((i) => i.setTitle("Nothing to filter by").setDisabled(true));
			for (const o of list) {
				m.addItem((i) => i.setTitle(o).setChecked(chosen.includes(o)).onClick(() => {
					set(chosen.includes(o) ? chosen.filter((x) => x !== o) : [...chosen, o]);
					void this.redraw();
				}));
			}
			if (chosen.length) {
				m.addSeparator();
				m.addItem((i) => i.setTitle("Clear").setIcon("x")
					.onClick(() => { set([]); void this.redraw(); }));
			}
			const box = b.getBoundingClientRect();
			m.showAtPosition({ x: box.left, y: box.bottom + 4 });
		});
		b.toggleClass("is-on", now().length > 0);
		return b;
	}

	/** An icon that opens a tick-list, the way the toolbar menus work. */
	/**
	 * Grouping, which is a list rather than a choice.
	 *
	 * Banding by one thing answers "where is this work"; banding by two answers
	 * "whose work is this, and which phase" — which is the question a programme
	 * is actually read with. The menu is ticked in the order clicked, outermost
	 * first, and the properties on offer are the ones the vault really has, so
	 * it can never produce a band of "(no whatever)" for every task.
	 */
	/**
	 * Saved views.
	 *
	 * A pane is a dozen small choices — folder, grouping, filters, layout — and
	 * setting them again every time is the reason people stop using a tool. A
	 * saved view is those choices under a name, and nothing more: no copy of the
	 * tasks, no frozen file list, so a product added next month shows up in the
	 * view without anybody editing it.
	 */
	private viewsButton(host: HTMLElement) {
		const saved = this.plugin.settings.views;
		const b = host.createDiv({ cls: "ts-icon-btn" });
		setIcon(b, "bookmark");
		this.viewsBtn = b;
		b.onclick = () => {
			const m = new Menu();
			if (!saved.length) {
				m.addItem((i) => i.setTitle("No saved views yet").setDisabled(true));
			}
			for (const v of saved) {
				m.addItem((i) => i
					.setTitle(v.name)
					.setIcon("bookmark")
					.setChecked(v.name === this.appliedView)
					.onClick(() => this.applyView(v)));
			}
			m.addSeparator();
			m.addItem((i) => i.setTitle("Save this view…").setIcon("plus").onClick(() => {
				new NameView(this.app, saved.map((v) => v.name), this.appliedView ?? "",
					async (name: string) => {
						const next = this.asView(name);
						const at = saved.findIndex((v) => v.name === name);
						// Saving over a name replaces it rather than making a second
						// view with the same label, which nobody could then tell apart.
						if (at >= 0) saved[at] = next; else saved.push(next);
						this.appliedView = name;
						await this.plugin.saveSettings();
						await this.redraw();
						new Notice(`Saved view "${name}".`);
					}).open();
			}));
			if (this.appliedView) {
				m.addItem((i) => i.setTitle("Back to defaults").setIcon("x").onClick(() => {
					this.appliedView = null;
					void this.redraw();
				}));
			}
			m.addSeparator();
			m.addItem((i) => i.setTitle("Manage saved views").setIcon("settings").onClick(() => {
				const app = this.app as unknown as {
					setting: { open(): void; openTabById(id: string): void };
				};
				app.setting.open();
				app.setting.openTabById("task-span");
			}));
			const box = b.getBoundingClientRect();
			m.showAtPosition({ x: box.left, y: box.bottom + 4 });
		};
	}

	/** This pane's current choices, as a saved view. */
	private asView(name: string): SavedView {
		const q = this.q;
		return {
			name,
			from: [...q.from],
			group: [...q.group],
			view: q.view,
			scale: q.scale,
			sort: q.sort,
			dateField: q.dateField ?? "due",
			window: q.window ?? "all",
			tags: [...q.tags],
			priorities: [...q.priorities],
			status: [...q.status],
			showDone: q.showDone,
		};
	}

	/** Everything a saved view sets, and nothing it does not. */
	private applyView(v: SavedView) {
		const q = this.q;
		q.from = v.from.length ? [...v.from] : [""];
		q.group = [...v.group];
		q.view = v.view;
		q.scale = v.scale;
		q.sort = v.sort;
		q.dateField = v.dateField;
		q.window = v.window;
		q.tags = [...v.tags];
		q.priorities = [...v.priorities];
		q.status = [...v.status];
		q.showDone = v.showDone;
		// The cursor is deliberately left alone: a saved view is a lens, not a
		// time machine, and being thrown back to last March on every switch
		// would be its own bug.
		this.appliedView = v.name;
		void this.redraw();
	}

	/**
	 * Grouping, which is a list rather than a choice.
	 *
	 * Built once, but it decides nothing at build time. The toolbar is created
	 * when the pane opens and never again, so anything read from `this.q` here
	 * would be frozen at whatever the pane started as — which is exactly how
	 * this button came to refuse grouping while sitting in the Gantt. Every
	 * answer is read at click time, and the way it looks is refreshed by
	 * `syncToolbar` on each redraw.
	 */
	private groupButton(host: HTMLElement) {
		const b = host.createDiv({ cls: "ts-icon-btn" });
		setIcon(b, "group");
		this.groupBtn = b;

		const toggle = (key: string) => {
			const here = this.q.group.filter((g) => g !== "none");
			this.q.group = here.includes(key as never)
				? (here.filter((g) => g !== key) as Query["group"])
				: ([...here, key] as Query["group"]);
			if (!this.q.group.length) this.q.group = ["none"];
			void this.redraw();
		};

		b.onclick = () => {
			// In Day, Week, Month and Year the date *is* the grouping — a day cell
			// banded by product would mean four headings inside 50 pixels.
			if (!GROUPABLE.includes(this.q.view)) {
				new Notice("Grouping applies to the Tasks and Gantt views.");
				return;
			}
			const m = new Menu();
			for (const o of ["folder", "file", "heading", "tag"]) {
				const at = this.q.group.indexOf(o as never);
				m.addItem((i) => i
					.setTitle(at < 0 ? o : `${at + 1}. ${o}`)
					.setChecked(at >= 0)
					.onClick(() => toggle(o)));
			}
			const keys = this.propertyKeys();
			if (keys.length) {
				m.addSeparator();
				for (const k of keys) {
					const key = `property:${k}`;
					const at = this.q.group.indexOf(key as never);
					m.addItem((i) => i
						.setTitle(at < 0 ? k : `${at + 1}. ${k}`)
						.setIcon("file-cog")
						.setChecked(at >= 0)
						.onClick(() => toggle(key)));
				}
			}
			if (grouped(this.q)) {
				m.addSeparator();
				m.addItem((i) => i.setTitle("Clear").setIcon("x").onClick(() => {
					this.q.group = ["none"];
					void this.redraw();
				}));
			}
			const box = b.getBoundingClientRect();
			m.showAtPosition({ x: box.left, y: box.bottom + 4 });
		};
	}

	/**
	 * Bring the toolbar back in step with the query.
	 *
	 * The toolbar is built once and the query changes under it — by a tab, a
	 * saved view, or state restored at startup. Anything whose appearance
	 * depends on the query is refreshed here, in one place, rather than by each
	 * thing that changes the query remembering to.
	 */
	private syncToolbar() {
		const applies = GROUPABLE.includes(this.q.view);
		const on = grouped(this.q) && applies;

		if (this.groupBtn) {
			this.groupBtn.toggleClass("is-on", on);
			this.groupBtn.toggleClass("is-off", !applies);
			this.groupBtn.setAttr("aria-label", !applies
				? "Grouping applies to Tasks and Gantt"
				: on ? `Grouped by ${this.q.group.join(" › ")}` : "Group");
		}

		if (this.viewsBtn) {
			this.viewsBtn.toggleClass("is-on", this.appliedView !== null);
			this.viewsBtn.setAttr("aria-label", this.appliedView
				? `View: ${this.appliedView}` : "Saved views");
		}
	}

	/** Frontmatter keys the notes in scope actually carry. */
	private propertyKeys(): string[] {
		const keys = new Set<string>();
		for (const f of this.app.vault.getMarkdownFiles()) {
			if (this.q.from.length && !this.q.from.some((p) => !p || f.path.startsWith(p))) continue;
			const fm = this.app.metadataCache.getFileCache(f)?.frontmatter;
			for (const k of Object.keys(fm ?? {})) {
				// Obsidian's own bookkeeping, never a grouping anybody wants.
				if (k === "position" || k === "aliases" || k === "cssclasses") continue;
				keys.add(k);
			}
		}
		return [...keys].sort();
	}

	private menuButton(host: HTMLElement, icon: string, label: string,
		options: string[], now: string, set: (v: string) => void) {
		let chosen = now;
		const b = this.iconButton(host, icon, label, () => {
			const m = new Menu();
			for (const o of options) {
				m.addItem((i) => i.setTitle(o).setChecked(o === chosen).onClick(() => {
					chosen = o;
					set(o);
					void this.redraw();
				}));
			}
			const box = b.getBoundingClientRect();
			m.showAtPosition({ x: box.left, y: box.bottom + 4 });
		});
	}

	private async redraw() {
		const d = new Date(this.q.cursor);
		const stamp = `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`;
		const names: Record<View, string> = {
			day: stamp,
			week: weekLabel(this.q.cursor),
			gantt: "Gantt", list: "Tasks",
			month: d.toLocaleString(undefined, { month: "long", year: "numeric" }),
			year: String(d.getFullYear()),
		};
		this.caption.setText(names[this.q.view]);
		this.litTab(this.q.view);
		this.syncToolbar();
		// Hidden only where there is nothing to move through. On the gantt the
		// same arrows scroll the timeline, which is what a reader expects of
		// them there — not a second, differently-shaped control.
		this.nav.toggleClass("is-hidden", this.q.view === "list");
		this.listOnly.toggleClass("is-hidden", this.q.view !== "list");
		await paint(this.plugin, this.body, this.q, (next) => {
			this.q.group = next;
			void this.redraw();
		});
		this.tagsSeen = [...new Set(
			this.body.findAll(".ts-tag:not(.is-more)").map((e) => `#${e.textContent ?? ""}`),
		)].sort();
		await this.daily();
	}

	/**
	 * Drag the divider.
	 *
	 * Pointer capture rather than listeners on the document: the pointer can
	 * leave the handle at speed, and without capture the drag is dropped
	 * mid-gesture and the panel sticks at whatever width it had reached.
	 */
	private resizable(split: HTMLElement) {
		this.handle.addEventListener("pointerdown", (ev) => {
			ev.preventDefault();
			this.handle.setPointerCapture(ev.pointerId);
			this.handle.addClass("is-dragging");

			const onMove = (e: PointerEvent) => {
				const box = split.getBoundingClientRect();
				const pct = ((box.right - e.clientX) / box.width) * 100;
				// Neither side may be squeezed to nothing: a panel you cannot see
				// is a panel you cannot drag back.
				this.sideWidth = Math.min(70, Math.max(18, pct));
				this.side.style.flexBasis = `${this.sideWidth}%`;
			};
			const onUp = () => {
				this.handle.removeEventListener("pointermove", onMove);
				this.handle.removeEventListener("pointerup", onUp);
				this.handle.removeClass("is-dragging");
			};
			this.handle.addEventListener("pointermove", onMove);
			this.handle.addEventListener("pointerup", onUp);
		});
	}

	/**
	 * Swipe sideways to step a period.
	 *
	 * Only on the dated views, and only when the gesture is clearly horizontal:
	 * a trackpad reports a little sideways drift on almost every vertical
	 * scroll, and stepping the month because somebody scrolled down would be
	 * worse than not having the gesture at all.
	 *
	 * The gantt is excluded — its timeline genuinely scrolls sideways, and
	 * hijacking that would take away the thing the view is for.
	 */
	private swipeable(host: HTMLElement) {
		let armed = true;
		host.addEventListener("wheel", (ev) => {
			if (this.q.view === "gantt" || this.q.view === "list") return;
			if (Math.abs(ev.deltaX) < 24 || Math.abs(ev.deltaX) < Math.abs(ev.deltaY) * 1.5) return;
			ev.preventDefault();
			if (!armed) return;
			armed = false;
			// One step per gesture, not one per event: a swipe is dozens of
			// events and would otherwise fly through a year.
			window.setTimeout(() => { armed = true; }, 320);
			this.step(ev.deltaX > 0 ? 1 : -1);
		}, { passive: false });
	}

	/** Step the cursor by whatever the current view counts in. */
	private step(by: number) {
		if (this.q.view === "gantt") {
			// A fortnight a press: a day is imperceptible on a wide chart, and a
			// month loses the bars you were following.
			const tracks = this.body.findAll(".ts-cell-track, .ts-head-track");
			const colW = this.q.scale === "day" ? 34 : this.q.scale === "week" ? 15 : 7;
			const by14 = by * colW * 14;
			for (const t of tracks) t.scrollLeft += by14;
			return;
		}
		const d = new Date(this.q.cursor);
		if (this.q.view === "month") d.setMonth(d.getMonth() + by);
		else if (this.q.view === "year") d.setFullYear(d.getFullYear() + by);
		else if (this.q.view === "week") d.setDate(d.getDate() + by * 7);
		else d.setDate(d.getDate() + by);
		this.q.cursor = d.setHours(0, 0, 0, 0);
		void this.redraw();
	}

	/**
	 * The daily note beside the day.
	 *
	 * Read from the core Daily Notes settings rather than asked for again: a
	 * second place to configure the same thing is a second place to get it wrong.
	 */
	private async daily() {
		this.side.empty();
		if (this.q.view !== "day" || this.plugin.settings.showDailyNote === false) {
			this.side.addClass("is-hidden");
			this.handle.addClass("is-hidden");
			return;
		}
		this.side.removeClass("is-hidden");
		this.handle.removeClass("is-hidden");
		this.side.style.flexBasis = `${this.sideWidth}%`;

		const head = this.side.createDiv({ cls: "ts-side-head" });
		head.createSpan({ cls: "ts-side-title", text: "Daily note" });

		const cfg = await this.dailyConfig();
		const name = formatDate(this.q.cursor, cfg.format);
		const path = cfg.folder ? `${cfg.folder}/${name}.md` : `${name}.md`;
		let file = this.app.vault.getAbstractFileByPath(path);

		head.createSpan({ cls: "ts-side-name", text: name });
		const edit = head.createDiv({ cls: "ts-icon-btn" });
		setIcon(edit, "pencil");
		edit.setAttr("aria-label", "Open in a pane");
		edit.onclick = async () => {
			const f = this.app.vault.getAbstractFileByPath(path);
			if (f instanceof TFile) await this.app.workspace.getLeaf(false).openFile(f);
		};

		const body = this.side.createDiv({ cls: "ts-side-body markdown-rendered" });
		const area = this.side.createEl("textarea", { cls: "ts-side-edit is-hidden" });

		const text = file instanceof TFile ? await this.app.vault.cachedRead(file) : "";
		const show = async () => {
			body.empty();
			if (text.trim()) {
				await MarkdownRenderer.render(this.app, text, body, path, this);
			} else {
				body.createDiv({ cls: "ts-day-none", text: "No daily note yet. Click to write one." });
			}
		};
		await show();

		// Click to write, blur to save. A pane is a click away for anything
		// longer; this is for the line you think of while looking at the day.
		body.onclick = () => {
			area.value = text;
			body.addClass("is-hidden");
			area.removeClass("is-hidden");
			area.focus();
		};

		let saving = false;
		area.onblur = async () => {
			if (saving) return;
			saving = true;
			const next = area.value;
			area.addClass("is-hidden");
			body.removeClass("is-hidden");
			if (next !== text) {
				file = this.app.vault.getAbstractFileByPath(path);
				if (file instanceof TFile) {
					// `text` is what the note said when this panel was drawn. Every
					// write goes through edit.ts so that the check comes with it.
					await replaceNote(this.app, path, text, next);
				} else if (next.trim()) {
					// Only make a file when there is something to put in it: an
					// empty note for every day you glanced at is litter.
					if (cfg.folder && !this.app.vault.getAbstractFileByPath(cfg.folder)) {
						await this.app.vault.createFolder(cfg.folder).catch(() => undefined);
					}
					await this.app.vault.create(path, next);
				}
			}
			saving = false;
			void this.redraw();
		};
	}

	private async dailyConfig(): Promise<{ folder: string; format: string }> {
		try {
			const raw = await this.app.vault.adapter.read(
				`${this.app.vault.configDir}/daily-notes.json`);
			const j = JSON.parse(raw) as { folder?: string; format?: string };
			return { folder: j.folder ?? "", format: j.format || "YYYY-MM-DD" };
		} catch {
			return { folder: "", format: "YYYY-MM-DD" };
		}
	}

	/**
	 * Each pane carries its own scope and view.
	 *
	 * Without this, two panes watching two projects would be the same pane
	 * twice, and neither would survive a restart.
	 */
	getState(): Record<string, unknown> {
		// Spread the base state: Obsidian needs its own keys to re-associate the
		// saved state with the leaf, and without them it discards the lot on
		// restart — which is exactly how the chosen folder went missing.
		return {
			...super.getState(),
			from: this.q.from,
			view: this.q.view,
			group: this.q.group,
			scale: this.q.scale,
			sort: this.q.sort,
			dateField: this.q.dateField,
			window: this.q.window,
			tags: this.q.tags,
			priorities: this.q.priorities,
			status: this.q.status,
			showDone: this.q.showDone,
			appliedView: this.appliedView,
		};
	}

	async setState(state: Record<string, unknown>, result: unknown) {
		const str = (k: string) => (typeof state?.[k] === "string" ? state[k] as string : null);
		const list = (k: string) => (Array.isArray(state?.[k]) ? state[k] as string[] : null);

		if (list("from")?.length) this.q.from = list("from") as string[];
		if (str("view")) this.q.view = str("view") as View;
		if (str("scale")) this.q.scale = str("scale") as Query["scale"];
		if (str("sort")) this.q.sort = str("sort") as Query["sort"];
		if (str("dateField")) this.q.dateField = str("dateField") as Query["dateField"];
		if (str("window")) this.q.window = str("window") as Query["window"];
		if (list("tags")) this.q.tags = list("tags") as string[];
		if (list("priorities")) this.q.priorities = list("priorities") as Query["priorities"];
		if (list("status")) this.q.status = list("status") as Query["status"];
		if (typeof state?.showDone === "boolean") this.q.showDone = state.showDone;
		if (typeof state?.appliedView === "string") this.appliedView = state.appliedView;

		// Group is written as a list and was once written as a string. Both are
		// read, because a pane saved by an older build is still somebody's pane.
		const g = state?.group;
		if (Array.isArray(g) && g.length) this.q.group = g as Query["group"];
		else if (typeof g === "string" && g) {
			this.q.group = g.split(",").map((x) => x.trim()).filter(Boolean) as Query["group"];
		}

		await super.setState(state, result as never);
		if (this.body) await this.redraw();
	}

	async onClose() {
		this.stop?.();
	}
}

/**
 * Which folders a pane reads.
 *
 * A list of every folder holding a dated task, ticked or not. Offering the
 * whole vault tree would be a tree of mostly empty folders; offering only
 * those with work in them is the same list, shorter.
 */
/**
 * Naming a saved view.
 *
 * It warns when the name is already taken rather than refusing it: saving over
 * a view you have just adjusted is the common case, and a dialog that says no
 * would send people off to delete the old one first.
 */
class NameView extends Modal {
	constructor(
		app: App,
		private taken: string[],
		private initial: string,
		private done: (name: string) => void | Promise<void>,
	) { super(app); }

	onOpen() {
		const { contentEl } = this;
		contentEl.addClass("task-span");
		contentEl.createEl("h3", { text: "Save this view" });

		let name = this.initial;
		const warn = contentEl.createDiv({ cls: "ts-note" });
		const say = () => {
			warn.setText(this.taken.includes(name.trim()) && name.trim()
				? `Replaces the existing "${name.trim()}".`
				: "Folder, grouping, filters and layout — not the tasks themselves.");
		};

		new Setting(contentEl).setName("Name")
			.addText((t) => {
				t.setPlaceholder("Programme").setValue(name).onChange((v) => { name = v; say(); });
				// Named and saved in one gesture: this dialog has one field.
				t.inputEl.onkeydown = (ev) => {
					if (ev.key === "Enter" && name.trim()) { ev.preventDefault(); save(); }
				};
				window.setTimeout(() => t.inputEl.focus(), 0);
			});
		say();

		const save = () => {
			if (!name.trim()) return;
			void this.done(name.trim());
			this.close();
		};

		new Setting(contentEl)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((b) => b.setButtonText("Save").setCta().onClick(save));
	}

	onClose() { this.contentEl.empty(); }
}

class ScopePicker extends Modal {
	private picked: Set<string>;

	constructor(app: App, current: string[], private done: (picked: string[]) => void) {
		super(app);
		this.picked = new Set(current.filter(Boolean));
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.addClass("ts-modal");
		this.titleEl.setText("Which folders should this pane read?");

		// Every folder, including the ones that only hold other folders. Listing
		// only folders with files in them meant a project folder could not be
		// picked — you had to tick its five phases one at a time.
		const folders = new Set<string>();
		for (const f of this.app.vault.getMarkdownFiles()) {
			const at = f.path.lastIndexOf("/");
			if (at < 0) continue;
			const parts = f.path.slice(0, at).split("/");
			for (let i = 1; i <= parts.length; i++) folders.add(parts.slice(0, i).join("/"));
		}

		contentEl.createDiv({
			cls: "ts-field-hint",
			text: "A folder includes everything beneath it. Nothing ticked reads the whole vault.",
		});

		const list = contentEl.createDiv({ cls: "ts-scope-list" });
		const draw = () => {
			list.empty();
			for (const folder of [...folders].sort()) {
				const depth = folder.split("/").length - 1;
				const name = folder.split("/").pop() ?? folder;
				const row = list.createDiv({ cls: "ts-scope-row" });
				row.style.paddingLeft = `${10 + depth * 16}px`;

				// Covered by an ancestor: shown ticked and faint, because
				// unticking it would do nothing and a control that does nothing is
				// worse than one that is absent.
				const parent = [...this.picked].some(
					(p) => p !== folder && folder.startsWith(`${p}/`));
				const on = this.picked.has(folder) || parent;
				const box = row.createDiv({ cls: `ts-box${on ? " is-on" : ""}` });
				if (parent) box.addClass("is-inherited");
				row.createDiv({ cls: "ts-scope-name", text: name });
				if (parent) row.createDiv({ cls: "ts-scope-via", text: "included" });
				if (parent) { row.addClass("is-inherited"); continue; }

				row.onclick = () => {
					if (this.picked.has(folder)) this.picked.delete(folder);
					else this.picked.add(folder);
					draw();
				};
			}
		};
		draw();

		const foot = contentEl.createDiv({ cls: "ts-modal-foot" });
		foot.createEl("button", { text: "Whole vault" }).onclick = () => {
			this.done([]);
			this.close();
		};
		foot.createEl("button", { cls: "mod-cta", text: "Use these" }).onclick = () => {
			this.done([...this.picked]);
			this.close();
		};
	}

	onClose() { this.contentEl.empty(); }
}


/* ══ the two small dialogs ═══════════════════════════════════════════════ */

/** Deleting somebody's line is the one edit worth a question. */
class Confirm extends Modal {
	constructor(app: App, private question: string, private yes: () => void) { super(app); }
	onOpen() {
		this.titleEl.setText("Are you sure?");
		this.contentEl.createEl("p", { text: this.question });
		new Setting(this.contentEl)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((b) => b.setButtonText("Delete").setWarning()
				.onClick(() => { this.yes(); this.close(); }));
	}
	onClose() { this.contentEl.empty(); }
}

/** `W41 (05 Oct – 11 Oct)` — the week number is what a programme is counted in. */
function weekLabel(ms: number): string {
	const d = new Date(ms);
	d.setHours(0, 0, 0, 0);
	d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
	const mon = new Date(d);
	const sun = new Date(d.getTime() + 6 * 86_400_000);
	// ISO week: the Thursday of this week decides which year and which number.
	const thu = new Date(d.getTime() + 3 * 86_400_000);
	const jan1 = new Date(thu.getFullYear(), 0, 1);
	const wk = Math.ceil((((thu.getTime() - jan1.getTime()) / 86_400_000) + jan1.getDay() + 1) / 7);
	const f = (x: Date) => `${String(x.getDate()).padStart(2, "0")}/${String(x.getMonth() + 1).padStart(2, "0")}`;
	return `W${wk} (${f(mon)}–${f(sun)})`;
}

function formatDate(ms: number, format: string): string {
	return moment(ms).format(format);
}

