/**
 * The shapes everything else passes around.
 *
 * A task here is deliberately thin: where it came from, when it runs, and what
 * it says. Everything richer — priority, recurrence, dependencies — belongs to
 * the Tasks plugin, which already does it well. This plugin reads; it does not
 * own.
 */

/** Tasks' six levels. "normal" is the absence of a marker. */
export type Priority = "highest" | "high" | "medium" | "normal" | "low" | "lowest";

export type Status = "open" | "done" | "cancelled" | "doing";

export interface Task {
	/** Vault path of the note the line lives in. */
	path: string;
	/** Line number, so clicking a bar lands on the line that drew it. */
	line: number;
	/** The note's basename, for grouping and for the tooltip. */
	file: string;
	/** Parent folder path, for grouping. */
	folder: string;
	/** Nearest heading above the line, for grouping. */
	heading: string;
	/** The task text, with the dates and tags taken out. */
	text: string;
	status: Status;
	priority: Priority;
	/** Start of the bar. Milliseconds since the epoch. */
	start: number;
	/** End of the bar. Equal to `start` for a task with only a due date. */
	end: number;
	/** True when the task has one date rather than two: drawn as a marker. */
	moment: boolean;
	/** Every date the line carried, for filtering by a chosen field. */
	dates: Partial<Record<DateField, number>>;
	tags: string[];
	/** The note's frontmatter, for `group: property:<name>`. */
	props: Record<string, unknown>;
}

/** `property:<name>` carries its key, so grouping by frontmatter needs no
 *  second field on the query. */
export type GroupBy = "folder" | "file" | "heading" | "tag" | "none" | `property:${string}`;
export type Scale = "day" | "week" | "month";
export type DateField = "start" | "scheduled" | "due" | "done";
export type Window = "all" | "day" | "week" | "month";
export type Sort = "start" | "due" | "name" | "length" | "status";
export type View = "day" | "week" | "gantt" | "list" | "month" | "year";

export interface Query {
	/** Folders or files to read. A folder is read recursively. */
	from: string[];
	/** Only tasks carrying one of these tags, if any are given. */
	tags: string[];
	/** Grouping, outermost first. `["none"]` means one flat list. */
	group: GroupBy[];
	scale: Scale;
	/** Explicit window, or null to fit the tasks. */
	range: { from: number; to: number } | null;
	showDone: boolean;
	/** Keep only these states. Empty means all of them. */
	status: Status[];
	/** Keep only these priorities. Empty means all of them. */
	priorities: Priority[];
	/** Paths to leave out, applied after `from`. */
	not: string[];
	/** Which drawing to make. */
	view: View;
	/** The day or month being looked at. Only the dated views use it. */
	cursor: number;
	/** How the rows are ordered within a group. */
	sort: Sort;
	/** Offer the "add a task" button. */
	add: boolean;
	/** Draw it, but never let it write. */
	readonly: boolean;
	/** Keep only open tasks whose due date has passed. */
	late?: boolean;
	/** Row height in pixels. */
	row: number;
	title: string;
	/** Lanes before a week folds; dots before a day counts. From settings. */
	lanes?: number;
	dots?: number;
	/** Strike a finished task as well as dimming it. From settings. */
	strike?: boolean;
	/** 0 Sunday … 6 Saturday. From settings. */
	weekStart?: number;
	/** Show the daily note beside the day. From settings. */
	daily?: boolean;
	/** Which date the window below is measured against. */
	dateField?: DateField;
	/** Limit the list to a period around the cursor. */
	window?: Window;
	/** What a row carries besides its name. From settings. */
	show?: { checkbox: boolean; tags: boolean; priority: boolean; source: boolean };
	/** Problems with the block itself, shown instead of a chart. */
	errors: string[];
}

/**
 * A band of tasks, and the bands beneath it.
 *
 * Grouping is a tree, not a list, because "this product, then by phase" is two
 * questions and a reader answers them in that order. A node with children is a
 * heading and draws none of its own rows; a node without is a leaf and draws
 * all of them. `tasks` is everything beneath either way, so a parent's count is
 * the sum of its children and the two can never disagree.
 */
export interface Group {
	/** The full key — a whole folder path, say. Shown on hover. */
	name: string;
	/** The short form actually drawn in the band. */
	label: string;
	/** Every task beneath this node. */
	tasks: Task[];
	/** Sub-bands. Empty at a leaf. */
	children: Group[];
}
