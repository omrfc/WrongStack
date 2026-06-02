// Pure VERTICAL row geometry for the TUI mouse hit-test (app.tsx), factored out
// so the fiddly off-by-one math can be unit-tested against rendered ground
// truth instead of living inline in the 6k-line App component.
//
// All rows are 1-based screen rows — exactly the `y` an SGR mouse event carries
// (see mouse.ts). `rowsAbove` is the number of rows occupied by everything
// rendered ABOVE the surface being hit: the chat viewport + the "N new lines"
// affordance + the pre-picker region (live-activity strip + input). Because
// rows are contiguous from 1, that count is also the 1-based index of the last
// row above the surface, so the surface's first row is always `rowsAbove + 1`.

/**
 * 1-based screen row of a bottom-anchored list picker's first item.
 * `header` = the number of rows the picker renders before its first item
 * (e.g. 1 for the slash/file menu, 2 for the model/autonomy/settings pickers).
 * The picker is rendered flush after the pre-picker region with no wrapper
 * margin, so its first row is `rowsAbove + 1` and the first item sits `header`
 * rows further down.
 */
export function pickerFirstItemRow(rowsAbove: number, header: number): number {
  return rowsAbove + header + 1;
}

/**
 * 1-based screen row of the confirm dialog's button line.
 *
 * The dialog (a bordered ConfirmPrompt) is wrapped in a `<Box marginY={1}>`, so
 * its top border sits ONE row below the pre-picker region. `boxHeight` is
 * `measureElement(wrapper).height`, which is the border-box height (top border +
 * content + bottom border) and EXCLUDES the wrapper's margin. Walking down:
 *
 *   rowsAbove                     last row of the input region
 *   rowsAbove + 1                 marginTop (blank)
 *   rowsAbove + 2                 top border           ← box row 1
 *   …
 *   rowsAbove + 1 + boxHeight     bottom border        ← box row boxHeight
 *
 * The buttons are the line just above the bottom border, i.e.
 * `rowsAbove + boxHeight`.
 */
export function confirmButtonsRow(rowsAbove: number, boxHeight: number): number {
  return rowsAbove + boxHeight;
}
