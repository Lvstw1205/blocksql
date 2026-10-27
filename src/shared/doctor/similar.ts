/** Optimal string alignment distance (Levenshtein + adjacent transpositions). */
export function distance(a: string, b: string): number {
  const m = a.length
  const n = b.length
  const d: number[][] = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)])
  for (let j = 0; j <= n; j++) d[0][j] = j
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost)
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1)
      }
    }
  }
  return d[m][n]
}

/** Closest candidate within a length-scaled distance, case-insensitive. */
export function closest(word: string, candidates: Iterable<string>): string | undefined {
  const w = word.toLowerCase()
  const max = w.length <= 3 ? 1 : w.length <= 6 ? 2 : 3
  let best: string | undefined
  let bestD = Infinity
  for (const c of candidates) {
    const cl = c.toLowerCase()
    const dd = cl.includes(w) || w.includes(cl) ? Math.abs(cl.length - w.length) * 0.5 + 0.5 : distance(w, cl)
    if (dd < bestD) {
      bestD = dd
      best = c
    }
  }
  return bestD <= max ? best : undefined
}
