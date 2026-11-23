/**
 * Ladder engine — server-side only. The guess list and the BFS solver
 * never ship to the browser: the client validates each submitted word
 * through /api/validate, and the par / optimal path are computed here
 * and only revealed after a valid finish. (The client does know the
 * daily start/end words — it has to display them — but without the
 * graph it cannot compute the par.)
 */

import { WORDS_COMMON } from './words-common.js'
import { WORDS_GUESS } from './words-guess.js'
import { DAILY_PAIRS } from './daily-pairs.js'

export const EPOCH_UTC = '2026-11-22'

const DAY_MS = 86_400_000

// ---------------------------------------------------------------------------
// Dates (UTC — one shared puzzle per UTC day)
// ---------------------------------------------------------------------------

export function utcDateString(d: Date): string {
  return d.toISOString().slice(0, 10)
}

export function daysSinceEpoch(dateStr: string): number {
  const epoch = Date.parse(`${EPOCH_UTC}T00:00:00.000Z`)
  const day = Date.parse(`${dateStr}T00:00:00.000Z`)
  return Math.floor((day - epoch) / DAY_MS)
}

export function ladderNumberFor(dateStr: string): number {
  return daysSinceEpoch(dateStr) + 1
}

export function isValidDateStr(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = Date.parse(`${value}T00:00:00.000Z`)
  if (!Number.isFinite(parsed)) return false
  return new Date(parsed).toISOString().slice(0, 10) === value
}

/** Deterministic daily pair: index into the pre-validated pairs bank. */
export function dailyPairFor(dateStr: string): { start: string; end: string } {
  const idx =
    ((daysSinceEpoch(dateStr) % DAILY_PAIRS.length) + DAILY_PAIRS.length) %
    DAILY_PAIRS.length
  const pair = DAILY_PAIRS[idx]
  return { start: pair[0], end: pair[1] }
}

// ---------------------------------------------------------------------------
// Wildcard-bucket graph
// ---------------------------------------------------------------------------

export type Buckets = Map<string, string[]>

function bucketKeys(word: string): string[] {
  const keys: string[] = []
  for (let i = 0; i < word.length; i++) {
    keys.push(`${word.slice(0, i)}_${word.slice(i + 1)}`)
  }
  return keys
}

export function buildBuckets(words: readonly string[]): Buckets {
  const buckets: Buckets = new Map()
  for (const word of words) {
    for (const key of bucketKeys(word)) {
      const list = buckets.get(key)
      if (list) list.push(word)
      else buckets.set(key, [word])
    }
  }
  return buckets
}

export function neighbors(word: string, buckets: Buckets): string[] {
  const out = new Set<string>()
  for (const key of bucketKeys(word)) {
    for (const other of buckets.get(key) ?? []) {
      if (other !== word) out.add(other)
    }
  }
  return [...out]
}

const GUESS_BUCKETS = buildBuckets(WORDS_GUESS)
const GUESS_SET = new Set<string>(WORDS_GUESS)

export function isGuessWord(word: string): boolean {
  return GUESS_SET.has(word)
}

export function isCommonWord(word: string): boolean {
  return (WORDS_COMMON as readonly string[]).includes(word)
}

/** Index of the single differing letter, or -1 when the words differ by != 1 letter. */
export function diffIndex(a: string, b: string): number {
  if (a.length !== b.length) return -1
  let diff = -1
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      if (diff !== -1) return -1
      diff = i
    }
  }
  return diff
}

export function isOneLetterApart(a: string, b: string): boolean {
  return diffIndex(a, b) !== -1
}

// ---------------------------------------------------------------------------
// BFS — exact shortest path, plus how many distinct shortest paths exist
// (capped: callers only need to know whether there are >= 2).
// ---------------------------------------------------------------------------

export interface BfsResult {
  /** Shortest path inclusive of start and end, or null when unreachable. */
  path: string[] | null
  /** Number of edges on the shortest path (-1 when unreachable). */
  dist: number
  /** Distinct shortest paths, capped at `cap`. */
  pathCount: number
}

export function bfs(
  start: string,
  end: string,
  buckets: Buckets = GUESS_BUCKETS,
  cap = 3,
): BfsResult {
  if (start === end) return { path: [start], dist: 0, pathCount: 1 }
  const dist = new Map<string, number>([[start, 0]])
  const count = new Map<string, number>([[start, 1]])
  const prev = new Map<string, string>()
  const queue: string[] = [start]
  let head = 0
  while (head < queue.length) {
    const u = queue[head++]
    const du = dist.get(u) ?? 0
    // Once the end is settled at its distance, deeper layers cannot add
    // shortest paths to it — but same-layer edges still can, so only stop
    // when we pass its distance.
    const endDist = dist.get(end)
    if (endDist !== undefined && du > endDist) break
    for (const v of neighbors(u, buckets)) {
      const dv = dist.get(v)
      if (dv === undefined) {
        dist.set(v, du + 1)
        count.set(v, count.get(u) ?? 1)
        prev.set(v, u)
        queue.push(v)
      } else if (dv === du + 1) {
        count.set(v, Math.min(cap, (count.get(v) ?? 0) + (count.get(u) ?? 1)))
      }
    }
  }
  const d = dist.get(end)
  if (d === undefined) return { path: null, dist: -1, pathCount: 0 }
  const path: string[] = [end]
  let cur = end
  while (cur !== start) {
    const p = prev.get(cur)
    if (p === undefined) break
    path.unshift(p)
    cur = p
  }
  return { path, dist: d, pathCount: count.get(end) ?? 1 }
}

/** Next word on a shortest path from `current` to `end` (for hints). */
export function nextStepOnShortestPath(
  current: string,
  end: string,
  buckets: Buckets = GUESS_BUCKETS,
): string | null {
  if (current === end) return null
  // Distances from the END: a neighbor of current is on a shortest path
  // when its distance-to-end is exactly one less than current's.
  const dist = new Map<string, number>([[end, 0]])
  const queue: string[] = [end]
  let head = 0
  while (head < queue.length) {
    const u = queue[head++]
    for (const v of neighbors(u, buckets)) {
      if (!dist.has(v)) {
        dist.set(v, (dist.get(u) ?? 0) + 1)
        queue.push(v)
      }
    }
  }
  const curDist = dist.get(current)
  if (curDist === undefined) return null
  for (const v of neighbors(current, buckets)) {
    if (dist.get(v) === curDist - 1) return v
  }
  return null
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export type StepError = 'Not in dictionary' | 'Change 1 letter' | 'Already used'

export function validateStep(
  prev: string,
  word: string,
  used: ReadonlySet<string>,
): { ok: true } | { ok: false; error: StepError } {
  const w = word.toLowerCase()
  if (!isGuessWord(w)) return { ok: false, error: 'Not in dictionary' }
  if (!isOneLetterApart(prev, w)) return { ok: false, error: 'Change 1 letter' }
  if (used.has(w)) return { ok: false, error: 'Already used' }
  return { ok: true }
}

export interface PathValidation {
  ok: boolean
  error?: string
  /** Rungs beyond the start word. */
  steps?: number
}

/** Full server-side validation of a claimed solution path. */
export function validatePath(
  start: string,
  end: string,
  path: string[],
): PathValidation {
  if (!Array.isArray(path) || path.length < 2) {
    return { ok: false, error: 'Path too short' }
  }
  const lower = path.map((w) => String(w).toLowerCase())
  if (lower[0] !== start) return { ok: false, error: 'Path must start at the start word' }
  if (lower[lower.length - 1] !== end) {
    return { ok: false, error: 'Path must end at the end word' }
  }
  const used = new Set<string>([start])
  for (let i = 1; i < lower.length; i++) {
    const check = validateStep(lower[i - 1], lower[i], used)
    if (!check.ok) return { ok: false, error: `${check.error} at step ${i + 1}` }
    used.add(lower[i])
  }
  return { ok: true, steps: lower.length - 1 }
}
