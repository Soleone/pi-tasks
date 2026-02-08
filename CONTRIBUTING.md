# Contributing

## UI color hierarchy (Beads pages)

Use these text colors consistently, from strongest to weakest emphasis:

1. `accent`
2. `warning` (only for attention/error states)
3. default/plain text
4. `muted`
5. `dim`

---

## Color inventory by page

### List page

- `accent`
  - selected row prefix/text
  - selected preview title
- `muted`
  - page title (`Tasks`)
  - global top/bottom borders
  - row metadata (status/type)
- `dim`
  - keyboard helper text (primary + secondary)
  - footer divider
  - select-list scroll info
- `warning`
  - no-match/search warning text
- default/plain
  - non-selected row title and summary body

### Show page

- `accent`
  - focused field labels (`Title`, `Description`)
  - editing status in title area
  - save success status (`✓ Saved`)
  - selected-task arrow prefix
  - focused field border color
- `muted`
  - page title base (`Tasks`)
  - unfocused field labels
  - blurred field borders
- `dim`
  - keyboard helper lines
  - global top/bottom borders
  - footer divider
- `warning`
  - save failure status
- default/plain
  - form field content text

---

## UX rules for list/show flow

- Keep list/show visual hierarchy aligned.
- Keep keyboard helper spacing/padding symmetric across pages.
- Keep selected task identity formatting shared via view-model helpers (avoid duplicate formatting logic).
- Prefer extracting reusable rendering/formatting primitives over repeating inline style logic.
