// Shared by the stub (renders the picker Screen) and the test harness (states the
// expected Screen): the 0.0.198 update added the `H · History` hint row above the
// bottom border (issue #22), and the 0.0.193 picker capture predates it. One
// transform, so the two sides cannot drift apart.
export const HISTORY_HINT_ROW = `${' '.repeat(75)}H · History`;

// Inserts the hint row above the last full-width separator line, as the 0.0.198
// picker renders it. Returns the input unchanged when no separator exists.
export const insertHintRow = (lines) => {
  const separator = lines.findLastIndex((line) => /^─+$/.test(line.trim()));
  if (separator === -1) return lines;
  return [...lines.slice(0, separator), HISTORY_HINT_ROW, ...lines.slice(separator)];
};
