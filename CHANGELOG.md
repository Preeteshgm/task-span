# Changelog

## 0.7.0

- Grouping is a tree: `group: property:product, property:phase` nests bands,
  and the Gantt and Tasks views draw the same shape.
- Group by any frontmatter property. A task inherits its note's properties, so
  context is written once on the note rather than on every task.
- Saved views: a named scope, grouping, filters and layout, from the toolbar.
- The toolbar re-reads the query on every redraw, so a control can no longer
  answer a question it was asked when the pane opened.
- A finished task shows a tick, drawn once for every view; cancelled shows a
  cross.
- Day/Week/Month/Year and Tasks/Gantt are drawn as two tab groups, since
  grouping applies only to the second pair.
- The Gantt's name column and its header are one measurement again. They had
  drifted 8px apart, which offset every date from the bar beneath it.
- No checkbox in the Gantt: the bar's colour already carries the status.
- Daily-note edits go through the same guarded write as everything else, so a
  note changed while the editor is open is no longer overwritten.
