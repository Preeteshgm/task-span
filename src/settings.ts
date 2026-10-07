/**
 * Settings.
 *
 * Four sections behind a contents page, rather than forty controls in a
 * column. A settings page people scroll is a settings page where the thing
 * they came for is three screens down; a contents page is one click and a
 * short list.
 *
 * Every option here is a default. A `span` block can override any of them for
 * itself, so nothing is configurable in two places with different answers.
 *
 * Deliberately absent: anything a view can work out, and anything belonging to
 * another plugin. The daily-note folder is read from Obsidian's own settings
 * unless told otherwise, because a second place to configure the same thing is
 * a second place to get it wrong.
 */

import { App, PluginSettingTab, Setting, setIcon } from "obsidian";
import type TaskSpan from "./main";
import type { DateField, GroupBy, Priority, Scale, Sort, Status, View, Window } from "./types";

/**
 * A saved view: a whole pane's worth of choices under a name.
 *
 * It stores what was *chosen*, never what it resolved to — `Projects/` stays
 * a folder, so a product added next month appears in the view without anybody
 * editing it. A view that had frozen its file list would quietly go stale.
 */
export interface SavedView {
	name: string;
	from: string[];
	group: GroupBy[];
	view: View;
	scale: Scale;
	sort: Sort;
	dateField: DateField;
	window: Window;
	tags: string[];
	priorities: Priority[];
	status: Status[];
	showDone: boolean;
}

export interface Settings {
	defaultView: View;
	defaultScale: Scale;
	defaultGroup: GroupBy;
	defaultSort: Sort;

	/** 0 Sunday … 6 Saturday. A project week starts on Monday; a diary may not. */
	weekStart: number;

	showCheckbox: boolean;
	showTags: boolean;
	showPriority: boolean;
	showSource: boolean;
	strikeDone: boolean;

	/** Lanes before Week and Month fold the rest behind a count. */
	monthLanes: number;
	yearDots: number;
	ganttColumn: number;
	rowHeight: number;

	ganttStart: "start" | "scheduled";
	ganttEnd: "due" | "done";

	newTaskNote: string;
	newTaskPriority: Priority;
	newTaskHeading: string;

	useObsidianDaily: boolean;
	dailyFolder: string;
	dailyFormat: string;
	showDailyNote: boolean;
	/** Open the sidebar when Obsidian starts. */
	openOnStart: boolean;

	/** Named scope + grouping + filters, picked from the toolbar. */
	views: SavedView[];

	/** The saved view a new pane opens on. Empty means the defaults above. */
	startView: string;

	/** The folder a new pane starts in. Empty means the whole vault. */
	defaultScope: string;
}

export const DEFAULTS: Settings = {
	defaultView: "day",
	defaultScale: "day",
	defaultGroup: "folder",
	defaultSort: "start",
	weekStart: 1,
	showCheckbox: true,
	showTags: true,
	showPriority: true,
	showSource: true,
	strikeDone: false,
	monthLanes: 3,
	yearDots: 3,
	ganttColumn: 15,
	rowHeight: 28,
	ganttStart: "start",
	ganttEnd: "due",
	newTaskNote: "",
	newTaskPriority: "normal",
	newTaskHeading: "",
	useObsidianDaily: true,
	dailyFolder: "",
	dailyFormat: "YYYY-MM-DD",
	showDailyNote: true,
	openOnStart: false,
	views: [],
	startView: "",
	defaultScope: "",
};

type Section = "general" | "calendar" | "views" | "tasks" | "saved";

const SECTIONS: { id: Section; name: string; icon: string; desc: string }[] = [
	{
		id: "general", name: "General", icon: "settings-2",
		desc: "Which view opens, how tasks are grouped and sorted",
	},
	{
		id: "calendar", name: "Calendar", icon: "calendar",
		desc: "Week start, daily notes",
	},
	{
		id: "views", name: "Views", icon: "layout-grid",
		desc: "What a task shows, row density, lanes and dots",
	},
	{
		id: "tasks", name: "Tasks", icon: "list-checks",
		desc: "Which dates a bar uses, defaults for new tasks",
	},
	{
		id: "saved", name: "Saved views", icon: "bookmark",
		desc: "Named scope, grouping and filters — renamed, reordered or removed",
	},
];

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** A saved view in one line, so a list of them is still readable. */
export function describe(v: SavedView): string {
	const bits: string[] = [];
	const where = v.from.filter(Boolean);
	bits.push(where.length ? where.join(", ") : "whole vault");
	bits.push(v.view);
	const groups = v.group.filter((g) => g !== "none")
		.map((g) => g.replace(/^property:/, ""));
	if (groups.length) bits.push(groups.join(" › "));
	if (v.status.length) bits.push(v.status.join("/"));
	if (v.priorities.length) bits.push(v.priorities.join("/"));
	if (v.tags.length) bits.push(v.tags.join(" "));
	if (v.window && v.window !== "all") bits.push(`this ${v.window} by ${v.dateField}`);
	if (!v.showDone) bits.push("open only");
	return bits.join("  ·  ");
}

export class SettingsTab extends PluginSettingTab {
	private open: Section | null = null;

	constructor(app: App, private plugin: TaskSpan) { super(app, plugin); }

	display() {
		this.containerEl.empty();
		if (this.open) this.section(this.open);
		else this.contents();
	}

	/** The contents page. */
	private contents() {
		const c = this.containerEl;
		c.createEl("p", {
			cls: "setting-item-description",
			text: "Every setting is a default. A `span` block can override any of them"
				+ " for itself, so a card in a presentation need not match the pane.",
		});
		for (const s of SECTIONS) {
			const row = new Setting(c).setName(s.name).setDesc(s.desc);
			row.settingEl.addClass("ts-set-row");
			setIcon(row.nameEl.createSpan({ cls: "ts-set-icon" }), s.icon);
			row.addExtraButton((b) => b.setIcon("chevron-right")
				.onClick(() => { this.open = s.id; this.display(); }));
			row.settingEl.onclick = () => { this.open = s.id; this.display(); };
		}
	}

	/** Frontmatter keys the vault really has, so the dropdown can never offer a dud. */
	private propertyKeys(): string[] {
		const keys = new Set<string>();
		for (const f of this.app.vault.getMarkdownFiles()) {
			const fm = this.app.metadataCache.getFileCache(f)?.frontmatter;
			for (const k of Object.keys(fm ?? {})) {
				if (k === "position" || k === "aliases" || k === "cssclasses") continue;
				keys.add(k);
			}
		}
		return [...keys].sort();
	}

	private back(name: string) {
		const head = this.containerEl.createDiv({ cls: "ts-set-back" });
		const b = head.createDiv({ cls: "ts-icon-btn" });
		setIcon(b, "chevron-left");
		b.onclick = () => { this.open = null; this.display(); };
		head.createSpan({ cls: "ts-set-back-text", text: name });
		head.onclick = () => { this.open = null; this.display(); };
	}

	private section(id: Section) {
		const c = this.containerEl;
		const s = this.plugin.settings;
		const save = () => void this.plugin.saveSettings();
		this.back(SECTIONS.find((x) => x.id === id)?.name ?? "Back");

		if (id === "general") {
			new Setting(c).setName("Open the sidebar on startup")
				.setDesc("Off by default: a pane nobody asked for taking a third of the "
					+ "screen on every launch is worse than one command away.")
				.addToggle((t) => t.setValue(s.openOnStart)
					.onChange((v) => { s.openOnStart = v; save(); }));

			new Setting(c).setName("Where a new pane starts")
				.setDesc("A folder. Empty reads the whole vault. A pane you have already "
					+ "pointed somewhere keeps its own scope.")
				.addText((t) => t.setPlaceholder("Digital Delivery/Projects")
					.setValue(s.defaultScope)
					.onChange((v) => { s.defaultScope = v.trim(); save(); }));

			new Setting(c).setName("Default view")
				.setDesc("The view a pane opens on.")
				.addDropdown((d) => d.addOptions({
					day: "Day", week: "Week", month: "Month",
					year: "Year", list: "Tasks", gantt: "Gantt",
				}).setValue(s.defaultView).onChange((v) => { s.defaultView = v as View; save(); }));

			new Setting(c).setName("Group by")
				.setDesc("Bands in the Tasks and Gantt views. The properties listed are "
					+ "the ones this vault's notes actually carry — a task is banded by "
					+ "the property on the note it lives in.")
				.addDropdown((d) => {
					d.addOptions({
						none: "Nothing", folder: "Folder", file: "File",
						heading: "Heading", tag: "Tag",
					});
					for (const k of this.propertyKeys()) d.addOption(`property:${k}`, `Property: ${k}`);
					d.setValue(s.defaultGroup)
						.onChange((v) => { s.defaultGroup = v as GroupBy; save(); });
				});

			new Setting(c).setName("Sort by")
				.addDropdown((d) => d.addOptions({
					start: "Start date", due: "Due date", name: "Name",
					length: "Length, longest first", status: "Status",
				}).setValue(s.defaultSort).onChange((v) => { s.defaultSort = v as Sort; save(); }));

			new Setting(c).setName("Gantt scale")
				.setDesc("How much of the timeline a day takes.")
				.addDropdown((d) => d.addOptions({ day: "Day", week: "Week", month: "Month" })
					.setValue(s.defaultScale).onChange((v) => { s.defaultScale = v as Scale; save(); }));
			return;
		}

		if (id === "calendar") {
			new Setting(c).setName("Week starts on")
				.setDesc("The first column in Week, Month and Year, and the week the Gantt counts by.")
				.addDropdown((d) => {
					// Every day, not a Monday toggle: the week starts on Sunday in
					// much of the world and on Saturday in parts of this one.
					for (let i = 0; i < 7; i++) d.addOption(String(i), DAYS[i]);
					d.setValue(String(s.weekStart))
						.onChange((v) => { s.weekStart = Number(v); save(); });
				});

			new Setting(c).setName("Daily notes").setHeading();

			new Setting(c).setName("Show the daily note")
				.setDesc("Beside the day in the Day view.")
				.addToggle((t) => t.setValue(s.showDailyNote)
					.onChange((v) => { s.showDailyNote = v; save(); }));

			new Setting(c).setName("Use Obsidian's settings")
				.setDesc("Read the folder and format from the core Daily Notes plugin. "
					+ "A second place to configure the same thing is a second place to get it wrong.")
				.addToggle((t) => t.setValue(s.useObsidianDaily)
					.onChange((v) => { s.useObsidianDaily = v; save(); this.display(); }));

			if (!s.useObsidianDaily) {
				new Setting(c).setName("Folder")
					.addText((t) => t.setPlaceholder("Daily Notes").setValue(s.dailyFolder)
						.onChange((v) => { s.dailyFolder = v.trim(); save(); }));
				new Setting(c).setName("File name format")
					.setDesc("Moment.js tokens, as the core plugin uses.")
					.addText((t) => t.setPlaceholder("YYYY-MM-DD").setValue(s.dailyFormat)
						.onChange((v) => { s.dailyFormat = v.trim() || "YYYY-MM-DD"; save(); }));
			}
			return;
		}

		if (id === "views") {
			new Setting(c).setName("What a task shows").setHeading();
			for (const [key, name, desc] of [
				["showCheckbox", "Checkbox", "Tick it to finish the task without leaving the chart."],
				["showPriority", "Priority", "An icon, never the emoji."],
				["showTags", "Tags", "Two, then a count."],
				["showSource", "Source", "The file and line it came from."],
				["strikeDone", "Strike finished tasks",
					"They are already ticked and dimmed; a struck-through long name is harder to read."],
			] as [keyof Settings, string, string][]) {
				new Setting(c).setName(name).setDesc(desc)
					.addToggle((t) => t.setValue(s[key] as boolean)
						.onChange((v) => { (s[key] as boolean) = v; save(); }));
			}

			new Setting(c).setName("Density").setHeading();

			new Setting(c).setName("Row height")
				.setDesc("Pixels. Below about 22 a bar cannot hold a label.")
				.addSlider((x) => x.setLimits(22, 56, 2).setValue(s.rowHeight).setDynamicTooltip()
					.onChange((v) => { s.rowHeight = v; save(); }));

			new Setting(c).setName("Gantt day width")
				.setDesc("Pixels per day. Narrower fits more; too narrow and a short task cannot be grabbed.")
				.addSlider((x) => x.setLimits(6, 50, 1).setValue(s.ganttColumn).setDynamicTooltip()
					.onChange((v) => { s.ganttColumn = v; save(); }));

			new Setting(c).setName("Rows of tasks per week")
				.setDesc("In Week and Month, before the rest fold behind a count.")
				.addSlider((x) => x.setLimits(1, 10, 1).setValue(s.monthLanes).setDynamicTooltip()
					.onChange((v) => { s.monthLanes = v; save(); }));

			new Setting(c).setName("Dots per day")
				.setDesc("In Year, before a day shows a count instead.")
				.addSlider((x) => x.setLimits(1, 5, 1).setValue(s.yearDots).setDynamicTooltip()
					.onChange((v) => { s.yearDots = v; save(); }));
			return;
		}

		if (id === "saved") {
			if (!s.views.length) {
				c.createEl("p", {
					cls: "setting-item-description",
					text: "No saved views yet. Set a pane up the way you want it — folder,"
						+ " grouping, filters — then use the bookmark button in its toolbar"
						+ " to save it. They are listed here so they can be renamed, reordered"
						+ " or removed.",
				});
				return;
			}

			new Setting(c).setName("The view a new pane opens on")
				.setDesc("Nothing means the defaults in General.")
				.addDropdown((d) => {
					d.addOption("", "Defaults");
					for (const v of s.views) d.addOption(v.name, v.name);
					d.setValue(s.startView).onChange((v) => { s.startView = v; save(); });
				});

			for (const [i, v] of s.views.entries()) {
				const row = new Setting(c)
					.setName(v.name)
					// What it actually does, so a list of six names is still readable.
					.setDesc(describe(v));
				row.addText((t) => t.setValue(v.name).onChange((name) => {
					const was = v.name;
					v.name = name.trim() || was;
					if (s.startView === was) s.startView = v.name;
					save();
				}));
				row.addExtraButton((b) => b.setIcon("chevron-up").setTooltip("Move up")
					.setDisabled(i === 0)
					.onClick(() => {
						s.views.splice(i - 1, 0, s.views.splice(i, 1)[0]);
						save(); this.display();
					}));
				row.addExtraButton((b) => b.setIcon("chevron-down").setTooltip("Move down")
					.setDisabled(i === s.views.length - 1)
					.onClick(() => {
						s.views.splice(i + 1, 0, s.views.splice(i, 1)[0]);
						save(); this.display();
					}));
				row.addExtraButton((b) => b.setIcon("trash-2").setTooltip("Remove")
					.onClick(() => {
						if (s.startView === v.name) s.startView = "";
						s.views.splice(i, 1);
						save(); this.display();
					}));
			}
			return;
		}

		new Setting(c).setName("Which dates a bar uses").setHeading();

		new Setting(c).setName("A bar starts at")
			.addDropdown((d) => d.addOptions({ start: "Start date", scheduled: "Scheduled date" })
				.setValue(s.ganttStart)
				.onChange((v) => { s.ganttStart = v as Settings["ganttStart"]; save(); }));

		new Setting(c).setName("A bar ends at")
			.addDropdown((d) => d.addOptions({ due: "Due date", done: "Done date" })
				.setValue(s.ganttEnd)
				.onChange((v) => { s.ganttEnd = v as Settings["ganttEnd"]; save(); }));

		new Setting(c).setName("New tasks").setHeading();

		new Setting(c).setName("Default note")
			.setDesc("Where a task made from the chart goes, unless the block reads a single file.")
			.addText((t) => t.setPlaceholder("Inbox.md").setValue(s.newTaskNote)
				.onChange((v) => { s.newTaskNote = v.trim(); save(); }));

		new Setting(c).setName("Under which heading")
			.setDesc("Appended at the end of the file when this is empty.")
			.addText((t) => t.setPlaceholder("Tasks").setValue(s.newTaskHeading)
				.onChange((v) => { s.newTaskHeading = v.trim(); save(); }));

		new Setting(c).setName("Default priority")
			.addDropdown((d) => d.addOptions({
				highest: "Highest", high: "High", medium: "Medium",
				normal: "Normal", low: "Low", lowest: "Lowest",
			}).setValue(s.newTaskPriority)
				.onChange((v) => { s.newTaskPriority = v as Priority; save(); }));
	}
}
