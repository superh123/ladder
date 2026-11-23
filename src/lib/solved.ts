/**
 * Solved daily record — the Wordle-style "Solved" state.
 *
 * No sign-in: once a player solves the daily, the solve is recorded in
 * localStorage keyed by date (name, best steps/time, submitted path, par).
 * Revisiting that date's daily shows the Solved state instead of a fresh
 * board, and SOLVED LOCKS THE DAY — there is no replay of the same daily
 * pair that day. A new day is a fresh board with a fresh name choice.
 *
 * NAME LOCK: the name is locked per date. After the first submit for a
 * date, this browser cannot submit under a different name for that date
 * (there is no replay, so no second submit is reachable at all). This is
 * per-browser (localStorage) enforcement, NOT per-person: the server
 * still upserts per (date, name) and cannot bind a browser to a name.
 * Clearing storage or using another browser bypasses it.
 *
 * The record functions are pure so they unit-test without a DOM; the
 * load/save wrappers touch localStorage and never throw.
 */

export interface SolvedEntry {
  name: string
  steps: number
  seconds: number
  path: string[]
  par: number
  isPar: boolean
  optimalPath: string[]
}

export type SolvedBook = Record<string, SolvedEntry>

export const SOLVED_KEY = 'ladder-solved-v1'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function isWordList(v: unknown): v is string[] {
  return (
    Array.isArray(v) &&
    v.length >= 2 &&
    v.every((w) => typeof w === 'string' && /^[a-z]{4}$/.test(w))
  )
}

function isSolvedEntry(v: unknown): v is SolvedEntry {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false
  const e = v as Record<string, unknown>
  return (
    typeof e.name === 'string' &&
    e.name.length > 0 &&
    Number.isInteger(e.steps) &&
    (e.steps as number) > 0 &&
    typeof e.seconds === 'number' &&
    (e.seconds as number) >= 0 &&
    isWordList(e.path) &&
    Number.isInteger(e.par) &&
    (e.par as number) > 0 &&
    typeof e.isPar === 'boolean' &&
    isWordList(e.optimalPath)
  )
}

/** Record (or replace) the solve for a date. Other dates are untouched. */
export function recordSolved(
  book: SolvedBook,
  date: string,
  entry: SolvedEntry,
): SolvedBook {
  return { ...book, [date]: entry }
}

/** The solve for a date, or null when the daily is still open. */
export function solvedFor(book: SolvedBook, date: string): SolvedEntry | null {
  return book[date] ?? null
}

/** The name locked for a date, or null when no name is locked yet. */
export function solvedNameFor(book: SolvedBook, date: string): string | null {
  return book[date]?.name ?? null
}

/** Parse a stored book, dropping corrupt or malformed entries. */
export function parseSolvedBook(raw: string | null): SolvedBook {
  if (!raw) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return {}
    }
    const book: SolvedBook = {}
    for (const [date, entry] of Object.entries(parsed)) {
      if (DATE_RE.test(date) && isSolvedEntry(entry)) book[date] = entry
    }
    return book
  } catch {
    return {}
  }
}

export function loadSolvedBook(): SolvedBook {
  try {
    return parseSolvedBook(localStorage.getItem(SOLVED_KEY))
  } catch {
    return {}
  }
}

export function saveSolvedBook(book: SolvedBook): void {
  try {
    localStorage.setItem(SOLVED_KEY, JSON.stringify(book))
  } catch {
    // localStorage full/blocked — the solve just won't persist.
  }
}
