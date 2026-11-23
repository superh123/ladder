/**
 * Solved daily record — unit tests.
 *
 * These pin the no-login "Solved" contract: a solve is recorded per date,
 * the name locks per date, a new day starts fresh, and corrupt storage
 * never crashes the game. The lock is per-browser (localStorage), not
 * per-person — that limit lives in the module comment, not in a test.
 */

import { describe, expect, it } from 'vitest'
import {
  parseSolvedBook,
  recordSolved,
  solvedFor,
  solvedNameFor,
  type SolvedBook,
  type SolvedEntry,
} from './solved'

const TILL_LANE: SolvedEntry = {
  name: 'Milo',
  steps: 4,
  seconds: 214,
  path: ['till', 'tile', 'tine', 'line', 'lane'],
  par: 4,
  isPar: true,
  optimalPath: ['till', 'tile', 'tine', 'line', 'lane'],
}

describe('recordSolved / solvedFor', () => {
  it('records a solve and reads it back for that date', () => {
    const book = recordSolved({}, '2026-11-23', TILL_LANE)
    expect(solvedFor(book, '2026-11-23')).toEqual(TILL_LANE)
  })

  it('a different date is still open', () => {
    const book = recordSolved({}, '2026-11-23', TILL_LANE)
    expect(solvedFor(book, '2026-11-24')).toBeNull()
  })

  it('recording a date leaves other dates untouched', () => {
    const other: SolvedEntry = { ...TILL_LANE, name: 'Maya', steps: 5 }
    const book = recordSolved(recordSolved({}, '2026-11-23', TILL_LANE), '2026-11-24', other)
    expect(solvedFor(book, '2026-11-23')).toEqual(TILL_LANE)
    expect(solvedFor(book, '2026-11-24')).toEqual(other)
  })

  it('re-recording a date replaces the old entry (best counts)', () => {
    const better: SolvedEntry = { ...TILL_LANE, steps: 4, seconds: 180 }
    const book = recordSolved(recordSolved({}, '2026-11-23', TILL_LANE), '2026-11-23', better)
    expect(solvedFor(book, '2026-11-23')).toEqual(better)
  })
})

describe('solvedNameFor (name lock)', () => {
  it('returns the locked name for a solved date', () => {
    const book: SolvedBook = { '2026-11-23': TILL_LANE }
    expect(solvedNameFor(book, '2026-11-23')).toBe('Milo')
  })

  it('returns null when the date has no solve yet', () => {
    expect(solvedNameFor({}, '2026-11-23')).toBeNull()
    expect(solvedNameFor({ '2026-11-23': TILL_LANE }, '2026-11-24')).toBeNull()
  })
})

describe('parseSolvedBook', () => {
  it('returns an empty book for null / empty / invalid JSON', () => {
    expect(parseSolvedBook(null)).toEqual({})
    expect(parseSolvedBook('')).toEqual({})
    expect(parseSolvedBook('not json')).toEqual({})
    expect(parseSolvedBook('[]')).toEqual({})
    expect(parseSolvedBook('"hello"')).toEqual({})
  })

  it('keeps valid entries and drops malformed ones', () => {
    const raw = JSON.stringify({
      '2026-11-23': TILL_LANE,
      '2026-11-24': { name: 'Maya' },
      'not-a-date': TILL_LANE,
      '2026-11-25': { ...TILL_LANE, steps: 0 },
    })
    expect(parseSolvedBook(raw)).toEqual({ '2026-11-23': TILL_LANE })
  })
})
