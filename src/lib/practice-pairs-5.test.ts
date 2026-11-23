/**
 * 5-letter pair bank — re-validation test (the runtime counterpart of
 * scripts/precompute-pairs-5.mjs). Every pair must be solvable on the
 * 5-letter guess graph with par 4-7, at least 2 distinct shortest
 * paths, and a shortest path made only of presentable words — all
 * under the lock rule.
 */
import { describe, expect, it } from 'vitest'
import {
  bfs,
  bucketsForLength,
  isPresentableWord,
  preferredPath,
  setsForLength,
  validatePath,
} from './ladder'
import { PRACTICE_PAIRS_5 } from './practice-pairs-5'

describe('5-letter pair bank', () => {
  it('has 60 pairs, all 5-letter words from the guess list', () => {
    expect(PRACTICE_PAIRS_5.length).toBe(60)
    const sets5 = setsForLength(5)
    for (const [start, end] of PRACTICE_PAIRS_5) {
      expect(start).toHaveLength(5)
      expect(end).toHaveLength(5)
      expect(sets5.guess.has(start)).toBe(true)
      expect(sets5.guess.has(end)).toBe(true)
      expect(sets5.legit.has(start)).toBe(true)
      expect(sets5.legit.has(end)).toBe(true)
    }
  })

  // Slow on purpose: a full constrained solve + clean-path check per pair.
  it('every pair meets the bar under the lock rule', { timeout: 180_000 }, () => {
    const sets5 = setsForLength(5)
    const buckets5 = bucketsForLength(5)
    const parHist = new Map<number, number>()
    for (const [start, end] of PRACTICE_PAIRS_5) {
      const { path, dist, pathCount } = bfs(start, end, buckets5)
      expect(dist).toBeGreaterThanOrEqual(4)
      expect(dist).toBeLessThanOrEqual(7)
      expect(pathCount).toBeGreaterThanOrEqual(2)
      parHist.set(dist, (parHist.get(dist) ?? 0) + 1)
      expect(path).not.toBeNull()
      expect(validatePath(start, end, path!, sets5.guess)).toEqual({
        ok: true,
        steps: dist,
      })
      // And the path the player is shown must be presentable words only.
      const shown = preferredPath(start, end, buckets5, -1, sets5)
      expect(shown).not.toBeNull()
      expect(shown!.length - 1).toBe(dist)
      for (const word of shown!) expect(isPresentableWord(word, sets5)).toBe(true)
    }
    // Sanity: the bank is not all one par.
    expect(parHist.size).toBeGreaterThanOrEqual(3)
  })
})
