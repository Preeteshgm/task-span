/**
 * Creating a task.
 *
 * The fields are the Tasks plugin's, because that is the format being written:
 * a dialog offering something the format cannot hold would be a dialog that
 * lies. Priority and the three dates are its emoji on the line — but nothing
 * here shows an emoji. Icons read at any size, they take the theme's colour,
 * and they do not change shape between Windows and a Mac.
 *
 * Created, done and cancelled dates are deliberately absent. A task being made
 * now has not been done or cancelled, and a created date nobody asked for is a
 * line of noise on every task forever.
 */

import { App, Modal, Notice, setIcon } from "obsidian";
import { appendTask } from "./edit";
import type { Query } from "./types";

/** Tasks' priority markers. The name and the icon are ours; the emoji is its. */
const PRIORITY: { name: string; icon: string; emoji: string }[] = [
	{ name: "Highest", icon: "chevrons-up", emoji: "\u{1F53A}" },
	{ name: "High", icon: "chevron-up", emoji: "\u{23EB}" },
	{ name: "Medium", icon: "equal", emoji: "\u{1F53C}" },
	{ name: "Normal", icon: "minus", emoji: "" },
	{ name: "Low", icon: "chevron-down", emoji: "\u{1F53D}" },
	{ name: "Lowest", icon: "chevrons-down", emoji: "\u{23EC}" },
];

function isoDay(ms: number): string {
	const d = new Date(ms);
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export class NewTask extends Modal {
	private text = "";
	private start: number | null = null;
	private scheduled: number | null = null;
	private due: number | null = null;
	private priority = "";
	private tags = "";
	private path: string;

	constructor(app: App, q: Query, on?: number) {
		super(app);
		const only = q.from.length === 1 ? q.from[0] : "";
		this.path = only.endsWith(".md") ? only : "";
		if (on !== undefined) { this.start = on; this.due = on; }
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.addClass("ts-modal");
		this.titleEl.setText("Create a task");

		// ── what ──────────────────────────────────────────────────────────
		this.label(contentEl, "file-text", "Task", "Ctrl+Enter to add");
		const area = contentEl.createEl("textarea", {
			cls: "ts-modal-text", attr: { placeholder: "What needs doing" },
		});
		area.oninput = () => { this.text = area.value; };
		area.onkeydown = (e) => {
			if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void this.add(); }
		};
		window.setTimeout(() => area.focus(), 0);

		// ── priority ──────────────────────────────────────────────────────
		this.label(contentEl, "flag", "Priority");
		const prio = contentEl.createDiv({ cls: "ts-prio" });
		for (const p of PRIORITY) {
			const b = prio.createDiv({ cls: `ts-prio-btn${p.emoji === this.priority ? " is-on" : ""}` });
			setIcon(b.createSpan({ cls: "ts-prio-icon" }), p.icon);
			b.createSpan({ text: p.name });
			b.onclick = () => {
				this.priority = p.emoji;
				for (const el of Array.from(prio.children)) el.removeClass("is-on");
				b.addClass("is-on");
			};
		}

		// ── when ──────────────────────────────────────────────────────────
		this.label(contentEl, "calendar", "Dates", "At least one, or it cannot be drawn");
		const dates = contentEl.createDiv({ cls: "ts-dates" });
		this.dateField(dates, "plane-takeoff", "Start", this.start, (v) => { this.start = v; });
		this.dateField(dates, "hourglass", "Scheduled", this.scheduled, (v) => { this.scheduled = v; });
		this.dateField(dates, "calendar-check", "Due", this.due, (v) => { this.due = v; });

		// ── tags ──────────────────────────────────────────────────────────
		this.label(contentEl, "tag", "Tags");
		const tag = contentEl.createEl("input", {
			cls: "ts-modal-input",
			attr: { type: "text", placeholder: "#plan #connect — space separated" },
		});
		tag.oninput = () => { this.tags = tag.value; };

		// ── where ─────────────────────────────────────────────────────────
		this.label(contentEl, "folder", "In which note");
		const files = this.app.vault.getMarkdownFiles().map((f) => f.path).sort();
		const pick = contentEl.createEl("select", { cls: "ts-modal-input" });
		for (const f of files) pick.createEl("option", { text: f, value: f });
		if (this.path) pick.value = this.path;
		else this.path = files[0] ?? "";
		pick.onchange = () => { this.path = pick.value; };

		// ── buttons ───────────────────────────────────────────────────────
		const foot = contentEl.createDiv({ cls: "ts-modal-foot" });
		foot.createEl("button", { text: "Cancel" }).onclick = () => this.close();
		foot.createEl("button", { cls: "mod-cta", text: "Add" }).onclick = () => void this.add();
	}

	private label(host: HTMLElement, icon: string, text: string, hint?: string) {
		const row = host.createDiv({ cls: "ts-field-label" });
		setIcon(row.createSpan({ cls: "ts-field-icon" }), icon);
		row.createSpan({ text });
		if (hint) row.createSpan({ cls: "ts-field-hint", text: hint });
	}

	private dateField(host: HTMLElement, icon: string, label: string, now: number | null,
		set: (v: number | null) => void) {
		const wrap = host.createDiv({ cls: "ts-date-field" });
		const head = wrap.createDiv({ cls: "ts-date-label" });
		setIcon(head.createSpan({ cls: "ts-date-icon" }), icon);
		head.createSpan({ text: label });

		const row = wrap.createDiv({ cls: "ts-date-row" });
		const input = row.createEl("input", { attr: { type: "date" } });
		if (now !== null) input.value = isoDay(now);
		input.onchange = () => set(input.value ? Date.parse(input.value) : null);

		const clear = row.createDiv({ cls: "ts-date-clear" });
		setIcon(clear, "x");
		clear.setAttr("aria-label", `Clear ${label.toLowerCase()}`);
		clear.onclick = () => { input.value = ""; set(null); };
	}

	private async add() {
		if (!this.text.trim()) {
			new Notice("Task Span: the task needs some words.");
			return;
		}
		if (!this.path) {
			new Notice("Task Span: pick a note for it to live in.");
			return;
		}
		if (this.start === null && this.scheduled === null && this.due === null) {
			// Without a date it cannot be drawn, and a task that vanishes the
			// moment it is made looks like a bug rather than a rule.
			new Notice("Task Span: give it at least one date, or it cannot be drawn.");
			return;
		}
		await appendTask(this.app, this.path, {
			text: this.text.trim(),
			priority: this.priority,
			tags: this.tags,
			start: this.start,
			scheduled: this.scheduled,
			due: this.due,
		});
		this.close();
	}

	onClose() { this.contentEl.empty(); }
}
