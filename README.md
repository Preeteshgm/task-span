# Task Span

Draw the tasks you already have as a timeline — **in a note, a canvas card or a
presentation**, not only in a pane of its own.

Task Span reads ordinary checkbox tasks. It does not ask you to write them
again in its own format, and it does not keep a copy. The note is the record;
this is a drawing of it.

```markdown
- [ ] Draft the API contract 🛫 2026-10-06 📅 2026-10-13
- [x] Create the repository 📅 2026-10-05 ✅ 2026-10-05
- [ ] Security review [start:: 2026-12-08] [due:: 2026-12-14]
```

## Why it exists

Two plugins already draw tasks on a timeline. Neither could do the thing this
one is for:

- A view-only plugin cannot be embedded. Its chart lives in a pane and nowhere
  else — not in a note, not in a canvas, not in a deck.
- A plugin that bundles its own styling cannot inherit your theme, so the
  chart never matches the vault around it.

Task Span registers a **code block**, so the same chart renders wherever
markdown renders. Every colour is a CSS variable, so it takes the theme it
finds.

## Six views

**Day · Week · Month · Year** — the calendars, where the date does the grouping.
**Tasks · Gantt** — the work, where grouping is yours to choose.

Bars are draggable: move one, or take an edge to resize it. The dates are
written back to the line they came from.

## Blocks

An empty block reads the note it sits in — the common case, and it needs no
words:

````markdown
```span
```
````

Or say what to read:

````markdown
```span
from: Projects/Website rebuild
group: property:product, property:phase
view: gantt
scale: week
sort: start
title: The programme
```
````

### Options

| Key | Values |
|---|---|
| `from` · `path` · `folder` | A file or a folder, recursive. Repeatable |
| `group` | `folder` `file` `heading` `tag` `none` `property:<name>` — a comma list nests them |
| `view` | `day` `week` `month` `year` `list` `gantt` |
| `scale` | `day` `week` `month` — the Gantt's column width |
| `sort` | `start` `due` `name` `length` `status` |
| `status` | `open` `doing` `done` `cancelled` |
| `tag` · `priority` | Filters |
| `date` | `start` `scheduled` `due` `done` — which date a window measures |
| `window` | `all` `day` `week` `month` |
| `not` · `exclude` | A path to leave out |
| `done` | `false` to hide finished work |
| `title` · `add` · `readonly` · `row` | |

Unknown keys are reported in the block rather than ignored.

## Grouping by a property

A task inherits the frontmatter of the note it sits in. A note carrying
`product: Website` puts every task in it under that band, without any task
repeating the name:

```markdown
---
product: Website
phase: Design
---

- [ ] Draft the page shell 🛫 2026-10-06 📅 2026-10-13
```

```span
group: property:product, property:phase
```

Levels nest in the order given.

## Dates

Tasks plugin emoji and Dataview inline fields are both read:

| | |
|---|---|
| 🛫 `[start:: ]` | Starts |
| ⏳ `[scheduled:: ]` | Scheduled |
| 📅 `[due:: ]` | Due |
| ✅ `[completion:: ]` | Done |

A task with one date is drawn as a marker. **A task with no date is not drawn
at all** — it has nowhere to sit on a timeline, and inventing a position for it
would be a lie.

## Writing back

Dragging a bar edits the line it came from. Three rules govern every write:

1. **Never rewrite a line.** Only the date tokens are replaced. Tags, links,
   block ids and whitespace are left exactly as they were.
2. **Check the line is still the line.** If the file changed since the chart
   was drawn, the write is refused with a notice rather than applied to the
   wrong place.
3. **One `vault.process` per change**, so two quick drags cannot race.

## Install

Not yet in the community catalogue. To install manually, copy `main.js`,
`manifest.json` and `styles.css` into
`<vault>/.obsidian/plugins/task-span/` and enable it in **Community plugins**.

## Build

```bash
npm install
npm run dev     # watch
npm run build   # type-check, then bundle
```

`src/draw.ts` imports nothing from Obsidian — the six layouts are pure DOM, so
the same drawing runs in a pane, a code block and a test.

## Prior art

**[Gantt Calendar](https://github.com/Leo310/obsidian-gantt-calendar)** and
**Smart Gantt** came first, and both are good. Task Span's six views sit in the
order Gantt Calendar established, and its settings are grouped much the same
way, because those conventions are worth keeping rather than reinventing a
worse version of.

No code is taken from either. The two things this one does differently are the
reason it exists: the chart renders anywhere markdown renders, and every colour
is a CSS variable, so it takes your theme rather than bringing its own.

If a pane is all you need, use Gantt Calendar.

## Licence

MIT — see [LICENSE](LICENSE).
