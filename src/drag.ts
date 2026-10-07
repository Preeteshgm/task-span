/**
 * Dragging a bar.
 *
 * Three gestures on one element: grab the middle to move both dates, grab
 * either end to move one. The edges are 7px wide, which is the smallest a
 * pointer reliably hits and the largest that still leaves a short bar grabbable
 * in the middle.
 *
 * Nothing is written until the pointer is released, and nothing is written at
 * all if the dates have not changed. A drag that ends where it started should
 * cost the file nothing — otherwise every accidental nudge rewrites a line and
 * every rewrite is a sync, a backup and a git diff.
 */

import type { Task } from "./types";

const DAY = 86_400_000;
const EDGE = 7;

export interface Geometry {
	/** Left edge of the track, in milliseconds. */
	from: number;
	/** Pixels per day. */
	colW: number;
}

export type Mode = "move" | "start" | "end";

export function attachDrag(
	bar: HTMLElement,
	task: Task,
	geo: Geometry,
	commit: (start: number, end: number) => void | Promise<void>,
) {
	const perDay = geo.colW;

	const modeAt = (ev: PointerEvent): Mode => {
		const box = bar.getBoundingClientRect();
		if (task.moment) return "move";
		if (ev.clientX - box.left <= EDGE) return "start";
		if (box.right - ev.clientX <= EDGE) return "end";
		return "move";
	};

	// The cursor is the whole affordance: nothing else tells you the ends are
	// grabbable, and a tooltip saying so would be an admission of failure.
	bar.addEventListener("pointermove", (ev) => {
		if (bar.hasClass("is-dragging")) return;
		const m = modeAt(ev);
		bar.style.cursor = m === "move" ? "grab" : "ew-resize";
	});

	bar.addEventListener("pointerdown", (ev) => {
		if (ev.button !== 0) return;
		ev.preventDefault();
		ev.stopPropagation();

		const mode = modeAt(ev);
		const x0 = ev.clientX;
		const left0 = parseFloat(bar.style.left) || 0;
		const width0 = parseFloat(bar.style.width) || 0;
		let start = task.start;
		let end = task.end;
		let moved = false;

		bar.addClass("is-dragging");
		bar.setPointerCapture(ev.pointerId);

		const ghost = bar.createDiv({ cls: "ts-ghost" });

		const onMove = (e: PointerEvent) => {
			const days = Math.round((e.clientX - x0) / perDay);
			if (days !== 0) moved = true;

			if (mode === "move") {
				start = task.start + days * DAY;
				end = task.end + days * DAY;
				bar.style.left = `${left0 + days * perDay}px`;
			} else if (mode === "start") {
				// A bar cannot end before it begins; the far end holds still.
				start = Math.min(task.start + days * DAY, task.end);
				const dx = (start - task.start) / DAY;
				bar.style.left = `${left0 + dx * perDay}px`;
				bar.style.width = `${Math.max(perDay * 0.7, width0 - dx * perDay)}px`;
			} else {
				end = Math.max(task.end + days * DAY, task.start);
				const dx = (end - task.end) / DAY;
				bar.style.width = `${Math.max(perDay * 0.7, width0 + dx * perDay)}px`;
			}

			const fmt = (ms: number) => new Date(ms).toDateString().slice(4, 10);
			ghost.setText(start === end ? fmt(end) : `${fmt(start)} → ${fmt(end)}`);
		};

		const onUp = async () => {
			bar.removeEventListener("pointermove", onMove);
			bar.removeEventListener("pointerup", onUp);
			bar.removeEventListener("pointercancel", onUp);
			bar.removeClass("is-dragging");
			ghost.remove();

			if (!moved || (start === task.start && end === task.end)) {
				// Put it back exactly: a no-op drag must cost the file nothing.
				bar.style.left = `${left0}px`;
				bar.style.width = `${width0}px`;
				return;
			}
			await commit(start, end);
		};

		bar.addEventListener("pointermove", onMove);
		bar.addEventListener("pointerup", onUp);
		bar.addEventListener("pointercancel", onUp);
	});
}
