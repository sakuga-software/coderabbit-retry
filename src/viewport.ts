export interface Range {
  start: number;
  end: number;
}

/**
 * Returns the rows that fit in `available` lines and include the selected row.
 * The range moves only when the selection leaves it, so the list does not jump at each key press.
 */
export function visibleRange(heights: number[], selected: number, available: number, previousStart: number): Range {
  if (heights.length === 0) return { start: 0, end: 0 };
  const target = Math.min(Math.max(selected, 0), heights.length - 1);
  const fitFrom = (start: number) => {
    let used = 0;
    let end = start;
    while (end < heights.length && used + heights[end]! <= available) used += heights[end++]!;
    return Math.max(end, start + 1);
  };

  let start = Math.min(Math.max(previousStart, 0), heights.length - 1);
  if (target < start) start = target;
  while (target >= fitFrom(start)) start++;
  while (start > 0 && fitFrom(start - 1) === heights.length && fitFrom(start) === heights.length) start--;
  return { start, end: fitFrom(start) };
}
