# Contributing

## UI

### Color hierarchy (Beads pages)

Use these text colors consistently, from strongest to weakest emphasis:

1. `accent`
2. `warning` (only for attention/error states)
3. default/plain text
4. `muted`
5. `dim`

### Color inventory by page

#### List page

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

#### Show page

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

### UX rules for list/show flow

- Keep list/show visual hierarchy aligned.
- Keep keyboard helper spacing/padding symmetric across pages.
- Keep selected task identity formatting shared via view-model helpers (avoid duplicate formatting logic).
- Prefer extracting reusable rendering/formatting primitives over repeating inline style logic.

## Implementation details

- list modes for focused triage (`ready`, `open`, `all`)
- stable list layout with aligned task identity/meta and fixed-height description preview
- unified task form architecture for both Edit and Create pages
- create flow that keeps editing context after initial save and updates the same issue on subsequent saves
- keyboard-first interaction model with intent-based shortcuts and consistent list/show navigation behavior
- mvc-like architecture: control flow designed for concise, maintainable extension code
- inline header save feedback states with optional status icons
- shared view-model formatting primitives to keep list/show/create rendering in sync
- task reference serialization and work handoff prompt generation
