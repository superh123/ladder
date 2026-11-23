/**
 * Ladder engine — unit tests.
 *
 * The engine is server-side only, so these run as plain vitest (no
 * worker, no DOM). They pin the facts the game stands on:
 *   1. BFS finds the true shortest path under the lock rule (cold ->
 *      warm is par 4; till -> lane is par 4).
 *   2. Step validation reports the exact error for each bad move,
 *      including the lock rule (no same position twice in a row).
 *   3. The daily pair is deterministic per date and every banked pair
 *      meets the par 4-6 / >= 2 shortest paths bar under the lock rule.
 */

import { describe, expect, it } from 'vitest'
import {
  bfs,
  bucketsForLength,
  dailyPairFor,
  diffIndex,
  GUESS_BUCKETS,
  isGuessWord,
  isPresentableWord,
  ladderNumberFor,
  mulberry32,
  nextStepOnShortestPath,
  practicePairFor,
  preferredPath,
  setsForLength,
  validatePath,
  validateStep,
  wanderingPath,
} from './ladder'
import { DAILY_PAIRS } from './daily-pairs'
import { PRACTICE_PAIRS_5 } from './practice-pairs-5'

describe('bfs', () => {
  it('cold -> warm is par 4 via wold, word, ward', () => {
    const { path, dist, pathCount } = bfs('cold', 'warm')
    expect(dist).toBe(4)
    expect(path).not.toBeNull()
    expect(path![0]).toBe('cold')
    expect(path![path!.length - 1]).toBe('warm')
    expect(path!.length - 1).toBe(4)
    // Whichever shortest path BFS reconstructs, it must obey the lock.
    expect(validatePath('cold', 'warm', path!)).toEqual({ ok: true, steps: 4 })
    expect(pathCount).toBeGreaterThanOrEqual(1)
  })

  it('counts distinct shortest paths', () => {
    // cold -> warm also runs cold -> cord -> card -> ward -> warm.
    const { dist, pathCount } = bfs('cold', 'warm')
    expect(dist).toBe(4)
    expect(pathCount).toBeGreaterThanOrEqual(2)
  })

  it('returns null path for an unreachable word', () => {
    const { path, dist } = bfs('cold', 'zzzz')
    expect(path).toBeNull()
    expect(dist).toBe(-1)
  })

  it('till -> lane is still par 4 under the lock rule', () => {
    const { path, dist, pathCount } = bfs('till', 'lane')
    expect(dist).toBe(4)
    expect(path).not.toBeNull()
    expect(path![0]).toBe('till')
    expect(path![path!.length - 1]).toBe('lane')
    expect(path!.length - 1).toBe(4)
    expect(validatePath('till', 'lane', path!)).toEqual({ ok: true, steps: 4 })
    expect(pathCount).toBeGreaterThanOrEqual(2)
  })

  it('every BFS path obeys the lock rule', { timeout: 30_000 }, () => {
    for (const [start, end] of DAILY_PAIRS) {
      const { path } = bfs(start, end)
      expect(path).not.toBeNull()
      expect(validatePath(start, end, path!)).toEqual({
        ok: true,
        steps: path!.length - 1,
      })
    }
  })

  // Slow on purpose: a full constrained solve + clean-path check per pair.
  it('every banked daily pair meets the bar', { timeout: 60_000 }, () => {
    expect(DAILY_PAIRS.length).toBeGreaterThanOrEqual(90)
    for (const [start, end] of DAILY_PAIRS) {
      const { dist, pathCount } = bfs(start, end)
      expect(dist).toBeGreaterThanOrEqual(4)
      expect(dist).toBeLessThanOrEqual(6)
      expect(pathCount).toBeGreaterThanOrEqual(2)
      // And the path the player is shown must be presentable words only.
      const shown = preferredPath(start, end)
      expect(shown).not.toBeNull()
      expect(shown!.length - 1).toBe(dist)
      for (const word of shown!) expect(isPresentableWord(word)).toBe(true)
    }
  })
})

describe('validateStep', () => {
  const used = new Set(['cold'])

  it('accepts a one-letter real word', () => {
    expect(validateStep('cold', 'cord', used)).toEqual({ ok: true })
  })

  it('rejects a non-dictionary word', () => {
    expect(validateStep('cold', 'xqzw', new Set(['cold']))).toEqual({
      ok: false,
      error: 'Not in dictionary',
    })
  })

  it('rejects a two-letter change', () => {
    expect(validateStep('cold', 'warm', new Set(['cold']))).toEqual({
      ok: false,
      error: 'Change 1 letter',
    })
  })

  it('rejects changing the locked position', () => {
    // cold -> wold changed position 0, so the next rung may not touch it.
    expect(validateStep('wold', 'gold', new Set(['cold', 'wold']), 0)).toEqual({
      ok: false,
      error: "That letter's locked for this rung",
    })
  })

  it('accepts changing a different position while one is locked', () => {
    expect(validateStep('wold', 'word', new Set(['cold', 'wold']), 0)).toEqual({
      ok: true,
    })
  })

  it('rejects an already-used word', () => {
    expect(validateStep('cord', 'cold', new Set(['cold', 'cord']))).toEqual({
      ok: false,
      error: 'Already used',
    })
  })
})

describe('validatePath', () => {
  it('accepts the canonical cold -> warm solution', () => {
    expect(validatePath('cold', 'warm', ['cold', 'wold', 'word', 'ward', 'warm'])).toEqual({
      ok: true,
      steps: 4,
    })
  })

  it('accepts the canonical till -> lane solution', () => {
    expect(
      validatePath('till', 'lane', ['till', 'tile', 'tine', 'line', 'lane']),
    ).toEqual({ ok: true, steps: 4 })
  })

  it('rejects a path that changes the same position twice in a row', () => {
    // cold -> wold changed position 0; wold -> gold changes it again.
    const result = validatePath('cold', 'warm', [
      'cold',
      'wold',
      'gold',
      'word',
      'warm',
    ])
    expect(result.ok).toBe(false)
    expect(result.error).toContain("That letter's locked for this rung")
    expect(result.error).toContain('step 3')
  })

  it('accepts the same position changing again after a different step', () => {
    // Position 0 changes, then 1, then 0 again, then 1, then 0: legal,
    // because the lock only ever covers the immediately previous step.
    expect(
      validatePath('cold', 'warm', [
        'cold',
        'wold',
        'word',
        'cord',
        'card',
        'ward',
        'warm',
      ]),
    ).toEqual({ ok: true, steps: 6 })
  })

  it('rejects a path that does not end at the end word', () => {
    expect(validatePath('cold', 'warm', ['cold', 'cord'])).toEqual({
      ok: false,
      error: 'Path must end at the end word',
    })
  })

  it('rejects a path with a bad rung', () => {
    const result = validatePath('cold', 'warm', ['cold', 'xqzw', 'word', 'warm'])
    expect(result.ok).toBe(false)
    expect(result.error).toContain('Not in dictionary')
  })
})

describe('daily pairs', () => {
  it('is deterministic per date', () => {
    expect(dailyPairFor('2026-11-22')).toEqual(dailyPairFor('2026-11-22'))
    expect(dailyPairFor('2026-11-23')).not.toEqual(dailyPairFor('2026-11-22'))
  })

  it("today's pair is still till -> lane", () => {
    expect(dailyPairFor('2026-11-23')).toEqual({ start: 'till', end: 'lane' })
  })

  it('numbers ladders from 1 on the epoch', () => {
    expect(ladderNumberFor('2026-11-22')).toBe(1)
    expect(ladderNumberFor('2026-11-23')).toBe(2)
  })

  it('every pair in the bank is made of guess-list words', () => {
    for (const [start, end] of DAILY_PAIRS) {
      expect(isGuessWord(start)).toBe(true)
      expect(isGuessWord(end)).toBe(true)
    }
  })
})

describe('hints', () => {
  it('next step from cold toward warm is on a shortest path', () => {
    const next = nextStepOnShortestPath('cold', 'warm')
    expect(next).not.toBeNull()
    expect(diffIndex('cold', next!)).not.toBe(-1)
    expect(bfs(next!, 'warm').dist).toBe(3)
  })

  it('respects the locked position when hinting mid-ladder', () => {
    // tile was reached by changing position 3, so the hint must not
    // change position 3 again, and must still be on a shortest path.
    const next = nextStepOnShortestPath('tile', 'lane', GUESS_BUCKETS, 3)
    expect(next).not.toBeNull()
    expect(diffIndex('tile', next!)).not.toBe(3)
    expect(bfs(next!, 'lane', GUESS_BUCKETS, 3, diffIndex('tile', next!)).dist).toBe(
      bfs('tile', 'lane', GUESS_BUCKETS, 3, 3).dist - 1,
    )
  })

  it('returns null at the end word', () => {
    expect(nextStepOnShortestPath('warm', 'warm')).toBeNull()
  })
})

describe('wanderingPath', () => {
  it('produces a legal path from start to end', () => {
    const path = wanderingPath('cold', 'warm', {
      greediness: 0.5,
      random: mulberry32(42),
    })
    expect(path).not.toBeNull()
    expect(path![0]).toBe('cold')
    expect(path![path!.length - 1]).toBe('warm')
    expect(validatePath('cold', 'warm', path!)).toEqual({
      ok: true,
      steps: path!.length - 1,
    })
    expect(path!.length - 1).toBeGreaterThanOrEqual(bfs('cold', 'warm').dist)
  })

  it('wanders further at low greediness', () => {
    // Over several seeds, a low-greediness walk beats the par strictly
    // more often than a high-greediness one — the bot's easy mode really
    // is slower. (Checked as an aggregate, not per-seed, so a single
    // lucky walk cannot flake the test.)
    let lowExtra = 0
    let highExtra = 0
    for (let seed = 1; seed <= 8; seed++) {
      const par = bfs('cold', 'warm').dist
      const low = wanderingPath('cold', 'warm', {
        greediness: 0.3,
        random: mulberry32(seed),
      })!
      const high = wanderingPath('cold', 'warm', {
        greediness: 0.95,
        random: mulberry32(seed),
      })!
      lowExtra += low.length - 1 - par
      highExtra += high.length - 1 - par
    }
    expect(lowExtra).toBeGreaterThan(highExtra)
  })
})

describe('preferredPath', () => {
  it('returns a shortest path (length == par)', () => {
    const { dist } = bfs('cold', 'warm')
    const path = preferredPath('cold', 'warm')
    expect(path).not.toBeNull()
    expect(path!.length - 1).toBe(dist)
    expect(path![0]).toBe('cold')
    expect(path![path!.length - 1]).toBe('warm')
  })

  it('routes through presentable words when a clean shortest path exists', () => {
    // lets -> user has no clean shortest path (every par-6 line runs
    // through 'ssed'), so the bank rejects such pairs; a banked pair's
    // preferred path must be presentable end to end.
    const [start, end] = DAILY_PAIRS[1]
    const path = preferredPath(start, end)
    expect(path).not.toBeNull()
    for (const word of path!) expect(isPresentableWord(word)).toBe(true)
  })
})

describe('5-letter mode', () => {
  const sets5 = setsForLength(5)
  const buckets5 = bucketsForLength(5)
  const [bankStart, bankEnd] = PRACTICE_PAIRS_5[0]

  it('solves a banked 5-letter pair at par 4-7 with >= 2 shortest paths', () => {
    const { path, dist, pathCount } = bfs(bankStart, bankEnd, buckets5)
    expect(dist).toBeGreaterThanOrEqual(4)
    expect(dist).toBeLessThanOrEqual(7)
    expect(pathCount).toBeGreaterThanOrEqual(2)
    expect(path).not.toBeNull()
    expect(validatePath(bankStart, bankEnd, path!, sets5.guess)).toEqual({
      ok: true,
      steps: dist,
    })
  })

  it('validates 5-letter steps against the 5-letter guess list', () => {
    const { path } = bfs(bankStart, bankEnd, buckets5)
    expect(path).not.toBeNull()
    // Every rung of a real solution validates, lock included.
    const used = new Set<string>([path![0]])
    for (let i = 1; i < path!.length; i++) {
      const locked = i >= 2 ? diffIndex(path![i - 2], path![i - 1]) : -1
      expect(validateStep(path![i - 1], path![i], used, locked, sets5.guess)).toEqual({
        ok: true,
      })
      used.add(path![i])
    }
    // A 4-letter word is not a 5-letter dictionary word.
    expect(validateStep(bankStart, 'cold', new Set([bankStart]), -1, sets5.guess)).toEqual({
      ok: false,
      error: 'Not in dictionary',
    })
  })

  it('rejects a full 5-letter path that breaks the lock rule', () => {
    const { path } = bfs(bankStart, bankEnd, buckets5)
    expect(path).not.toBeNull()
    // Repeat the first step's changed position on the second rung.
    const broken = [...path!]
    const pos = diffIndex(broken[0], broken[1])
    const alphabet = 'abcdefghijklmnopqrstuvwxyz'
    for (const ch of alphabet) {
      const alt = broken[1].slice(0, pos) + ch + broken[1].slice(pos + 1)
      if (alt !== broken[1] && sets5.guess.has(alt) && diffIndex(broken[1], alt) === pos) {
        broken[2] = alt
        break
      }
    }
    if (broken[2] !== path![2]) {
      expect(validatePath(bankStart, bankEnd, broken, sets5.guess).ok).toBe(false)
    }
  })

  it('shows a presentable-only optimal path for a banked pair', () => {
    const { dist } = bfs(bankStart, bankEnd, buckets5)
    const shown = preferredPath(bankStart, bankEnd, buckets5, -1, sets5)
    expect(shown).not.toBeNull()
    expect(shown!.length - 1).toBe(dist)
    for (const word of shown!) expect(isPresentableWord(word, sets5)).toBe(true)
  })

  it('hints on a 5-letter ladder and wanders legally', () => {
    const next = nextStepOnShortestPath(bankStart, bankEnd, buckets5, -1, sets5)
    expect(next).not.toBeNull()
    expect(diffIndex(bankStart, next!)).not.toBe(-1)
    const wandered = wanderingPath(bankStart, bankEnd, {
      greediness: 0.5,
      random: mulberry32(42),
    }, buckets5, sets5)
    expect(wandered).not.toBeNull()
    expect(validatePath(bankStart, bankEnd, wandered!, sets5.guess).ok).toBe(true)
  })

  it('practicePairFor picks the right bank per length', () => {
    const five = practicePairFor(5, mulberry32(7))
    expect(five.start).toHaveLength(5)
    expect(five.end).toHaveLength(5)
    expect(PRACTICE_PAIRS_5).toContainEqual([five.start, five.end])
    const four = practicePairFor(4, mulberry32(7))
    expect(four.start).toHaveLength(4)
    expect(four.end).toHaveLength(4)
    expect(DAILY_PAIRS).toContainEqual([four.start, four.end])
  })
})
