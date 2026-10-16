/** Which bar a Body chart is showing after the metrics list changes under it.
 *
 *  An index is the wrong thing to remember. A sync can prepend a backfilled day,
 *  append a newer one, or slide a fixed-length window forward, and the same index
 *  then names a different date than the one on screen. The readout and the
 *  highlighted bar have to follow the date.
 *
 *  `followNewest` means the board is on the tip — the chart just opened, or the
 *  newest bar was the one chosen — so a day that arrives later should take over.
 *  A historical date stays put through a backfill and through a rolling window
 *  that still contains it, and only falls back to the newest reading once that
 *  date is gone.
 */
export type ChartSelection = { date: string; followNewest: boolean }

export function resolveChartSelection(
  points: { date: string }[],
  selection: ChartSelection | null,
): { index: number; date: string } {
  const newest = points[points.length - 1].date
  const pinned = selection && !selection.followNewest ? selection.date : null
  const date = pinned != null && points.some((p) => p.date === pinned) ? pinned : newest
  return { index: points.findIndex((p) => p.date === date), date }
}

/** A click or a keypress. Choosing the current tip keeps following newer days;
 *  choosing any earlier date pins that date. */
export function selectionAfterPick(points: { date: string }[], index: number): ChartSelection {
  const date = points[index].date
  return { date, followNewest: date === points[points.length - 1].date }
}
