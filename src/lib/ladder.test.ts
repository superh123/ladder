/**
 * Ladder engine — unit tests.
 *
 * The engine is server-side only, so these run as plain vitest (no
 * worker, no DOM). They pin the three facts the game stands on:
 *   1. BFS finds the true shortest path (cold -> warm is par 4).
 *   2. Step validation reports the exact error for each bad move.
 *   3. The daily pair is deterministic per date and every banked pair
 *      meets the par 4-6 / >= 2 shortest paths bar.
 */

import { describe, expect, it } from 'vitest'
import {
  bfs,
  dailyPairFor,
  diffIndex,
  isGuessWord,
  ladderNumberFor,
  nextStepOnShortestPath,
  validatePath,
  validateStep,
} from './ladder'
import { DAILY_PAIRS } from './daily-pairs'

describe('bfs', () => {
  it('cold -> warm is par 4 via wold, word, ward', () => {
    const { path, dist, pathCount } = bfs('cold', 'warm')
    expect(dist).toBe(4)
    expect(path).toEqual(['cold', 'wold', 'word', 'ward', 'warm'])
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

  it('every banked daily pair meets the bar', () => {
    expect(DAILY_PAIRS.length).toBeGreaterThanOrEqual(90)
    for (const [start, end] of DAILY_PAIRS) {
      const { dist, pathCount } = bfs(start, end)
      expect(dist).toBeGreaterThanOrEqual(4)
      expect(dist).toBeLessThanOrEqual(6)
      expect(pathCount).toBeGreaterThanOrEqual(2)
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

  it('rejects a path that does not end at the end word', () => {
    expect(validatePath('cold', 'warm', ['cold', 'cord'])).toEqual({
      ok: false,
      error: 'Path must end at the end word',
    })
  })

  it('rejects a path with a bad rung', () => {
    const result = validatePath('cold', 'warm', ['cold', 'cork', 'word', 'warm'])
    expect(result.ok).toBe(false)
    expect(result.error).toContain('Not in dictionary')
  })
})

describe('daily pairs', () => {
  it('is deterministic per date', () => {
    expect(dailyPairFor('2026-11-22')).toEqual(dailyPairFor('2026-11-22'))
    expect(dailyPairFor('2026-11-23')).not.toEqual(dailyPairFor('2026-11-22'))
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

  it('returns null at the end word', () => {
    expect(nextStepOnShortestPath('warm', 'warm')).toBeNull()
  })
})
