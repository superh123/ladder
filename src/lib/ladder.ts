/**
 * Ladder engine — the word graph, the constrained BFS solver, and
 * validation.
 *
 * THE LOCK RULE: a letter position changed in one rung is locked for the
 * next rung only — you may not change the same position on two
 * consecutive steps. Every solver and validator in this file enforces
 * it: BFS states carry the last-changed position, and a step is legal
 * only when it changes a different position. (So a ladder is never
 * forced onto a single optimal line: the lock only ever forbids one
 * position at a time.)
 *
 * The engine is shared with the browser for Bot mode (the bot's path is
 * simulated client-side from this same solver — bot mode has no
 * leaderboard, so there is nothing to cheat for). The daily game still
 * validates every step server-side, and the par / optimal path are
 * revealed only after a finish or a forfeit.
 */

import { WORDS_COMMON } from './words-common.js'
import { WORDS_GUESS } from './words-guess.js'
import { WORDS_LEGIT } from './words-legit.js'
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

// Neighbour lists are pure functions of the buckets, so cache them:
// the solver looks the same words up thousands of times per search.
const neighborCache = new WeakMap<Buckets, Map<string, string[]>>()

export function neighbors(word: string, buckets: Buckets): string[] {
  let perWord = neighborCache.get(buckets)
  if (!perWord) {
    perWord = new Map()
    neighborCache.set(buckets, perWord)
  }
  const cached = perWord.get(word)
  if (cached) return cached
  const out = new Set<string>()
  for (const key of bucketKeys(word)) {
    for (const other of buckets.get(key) ?? []) {
      if (other !== word) out.add(other)
    }
  }
  const arr = [...out]
  perWord.set(word, arr)
  return arr
}

export const GUESS_BUCKETS = buildBuckets(WORDS_GUESS)
const GUESS_SET = new Set<string>(WORDS_GUESS)
const COMMON_SET = new Set<string>(WORDS_COMMON)
const LEGIT_SET = new Set<string>(WORDS_LEGIT)

export function isGuessWord(word: string): boolean {
  return GUESS_SET.has(word)
}

export function isCommonWord(word: string): boolean {
  return COMMON_SET.has(word)
}

/** True when `word` is presentable in a hint or an optimal-path reveal. */
export function isPresentableWord(word: string): boolean {
  return LEGIT_SET.has(word)
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
// Lock-rule states: a BFS state is (word, lastChanged) where lastChanged
// is the position changed to reach the word, or -1 at a fresh start.
// A move is legal only when it changes a different position.
// ---------------------------------------------------------------------------

export interface LegalMove {
  word: string
  /** Position this move changes. */
  pos: number
}

function stateKey(word: string, last: number): string {
  return `${word}:${last}`
}

/**
 * Legal next words from `word` when position `locked` was just changed
 * (-1 when nothing is locked, i.e. a fresh start).
 */
export function legalMoves(
  word: string,
  locked: number,
  buckets: Buckets = GUESS_BUCKETS,
): LegalMove[] {
  const out: LegalMove[] = []
  for (const v of neighbors(word, buckets)) {
    const p = diffIndex(word, v)
    if (p !== -1 && p !== locked) out.push({ word: v, pos: p })
  }
  return out
}

// ---------------------------------------------------------------------------
// BFS — exact shortest path under the lock rule, plus how many distinct
// shortest paths exist (capped: callers only need to know whether
// there are >= 2).
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
  initialLocked = -1,
): BfsResult {
  if (start === end) return { path: [start], dist: 0, pathCount: 1 }
  const startKey = stateKey(start, initialLocked)
  const dist = new Map<string, number>([[startKey, 0]])
  const count = new Map<string, number>([[startKey, 1]])
  const prev = new Map<string, string>()
  const queue: Array<{ word: string; last: number }> = [
    { word: start, last: initialLocked },
  ]
  let head = 0
  let endDist: number | undefined
  while (head < queue.length) {
    const { word: u, last } = queue[head++]
    const uKey = stateKey(u, last)
    const du = dist.get(uKey) ?? 0
    // Once every state at the end's distance is processed, deeper
    // layers cannot add shortest paths to it — but same-layer edges
    // still can, so only stop when we pass its distance.
    if (endDist !== undefined && du > endDist) break
    for (const { word: v, pos } of legalMoves(u, last, buckets)) {
      const vKey = stateKey(v, pos)
      const dv = dist.get(vKey)
      if (dv === undefined) {
        dist.set(vKey, du + 1)
        count.set(vKey, count.get(uKey) ?? 1)
        prev.set(vKey, uKey)
        queue.push({ word: v, last: pos })
        if (v === end) {
          endDist = endDist === undefined ? du + 1 : Math.min(endDist, du + 1)
        }
      } else if (dv === du + 1) {
        count.set(vKey, Math.min(cap, (count.get(vKey) ?? 0) + (count.get(uKey) ?? 1)))
      }
    }
  }
  if (endDist === undefined) return { path: null, dist: -1, pathCount: 0 }
  // The end can be reached with any last-changed position; distinct
  // shortest paths are the sum of the per-state counts at the par.
  let pathCount = 0
  let bestKey: string | null = null
  for (let last = 0; last < 4; last++) {
    const k = stateKey(end, last)
    if (dist.get(k) === endDist) {
      pathCount = Math.min(cap, pathCount + (count.get(k) ?? 0))
      if (bestKey === null) bestKey = k
    }
  }
  const path: string[] = [end]
  let cur = bestKey
  while (cur !== null && cur !== startKey) {
    const p = prev.get(cur)
    if (p === undefined) break
    path.unshift(p.split(':')[0])
    cur = p
  }
  return { path, dist: endDist, pathCount }
}

/** Next word on a shortest path from `current` to `end` (for hints). */
export function nextStepOnShortestPath(
  current: string,
  end: string,
  buckets: Buckets = GUESS_BUCKETS,
  initialLocked = -1,
): string | null {
  const path = preferredPath(current, end, buckets, initialLocked)
  return path === null || path.length < 2 ? null : path[1]
}

/**
 * Constrained distances to `target` over the state graph, optionally
 * restricted to `allowed` words (the target itself is always included,
 * and `alwaysAllow` — the walk's start word — is too). A restricted
 * distance map only walks through allowed words, so a greedy walk on it
 * produces a shortest path made of presentable words whenever one
 * exists. Distances are per (word, lastChanged) state: how far the
 * target is from that state under the lock rule.
 */
function distancesToEnd(
  target: string,
  buckets: Buckets,
  allowed?: ReadonlySet<string>,
  alwaysAllow?: string,
): Map<string, number> {
  const dist = new Map<string, number>()
  const queue: Array<{ word: string; last: number }> = []
  // Seed the four "arrived at target" states. There is no (target, -1)
  // state: no move ever leaves lastChanged at -1, so it has no
  // predecessors and must not be expanded (expanding it would credit
  // every neighbour with a 1-step distance regardless of the lock).
  for (let last = 0; last < 4; last++) {
    const k = stateKey(target, last)
    dist.set(k, 0)
    queue.push({ word: target, last })
  }
  let head = 0
  while (head < queue.length) {
    const { word: v, last: p } = queue[head++]
    const dv = dist.get(stateKey(v, p)) ?? 0
    // Predecessors of (v, p): states (u, q) whose move to v changes
    // position p, with q != p (the lock rule, read backwards).
    for (const u of neighbors(v, buckets)) {
      if (diffIndex(u, v) !== p) continue
      if (allowed !== undefined && u !== alwaysAllow && !allowed.has(u)) continue
      for (let q = -1; q < 4; q++) {
        if (q === p) continue
        const uKey = stateKey(u, q)
        if (dist.has(uKey)) continue
        dist.set(uKey, dv + 1)
        queue.push({ word: u, last: q })
      }
    }
  }
  return dist
}

/**
 * One shortest path from `start` to `end`, routed through presentable
 * words whenever a shortest path of presentable words exists. The length
 * is exactly the par (each step drops the distance-to-end by one); the
 * preference only chooses *which* shortest path to show, so hints and the
 * optimal-path reveal read like something a person would type instead of
 * routing through an obscure dictionary word the guess list happens to
 * contain. Falls back to the full guess graph when no presentable
 * shortest path exists.
 */
export function preferredPath(
  start: string,
  end: string,
  buckets: Buckets = GUESS_BUCKETS,
  initialLocked = -1,
): string[] | null {
  if (start === end) return [start]
  // The full reverse map already holds the par: the distance from the
  // start state to the end. No separate forward BFS is needed.
  const full = distancesToEnd(end, buckets)
  const par = full.get(stateKey(start, initialLocked))
  if (par === undefined) return null
  // Try the presentable subgraph first: a clean shortest path exists
  // exactly when its distance equals the par.
  const clean = distancesToEnd(end, buckets, LEGIT_SET, start)
  if (clean.get(stateKey(start, initialLocked)) === par) {
    return walkPath(start, end, clean, buckets, initialLocked)
  }
  return walkPath(start, end, full, buckets, initialLocked)
}

/** Walk from `start` to `end`, always stepping to a state one closer. */
function walkPath(
  start: string,
  end: string,
  dist: Map<string, number>,
  buckets: Buckets,
  initialLocked = -1,
): string[] | null {
  const path = [start]
  let cur = start
  let last = initialLocked
  while (cur !== end) {
    const curDist = dist.get(stateKey(cur, last))
    if (curDist === undefined || curDist === 0) return null
    const options = legalMoves(cur, last, buckets).filter(
      (m) => dist.get(stateKey(m.word, m.pos)) === curDist - 1,
    )
    if (options.length === 0) return null
    const next = pickPreferred(options.map((m) => m.word))
    if (next === null) return null
    const pos = diffIndex(cur, next)
    if (pos === -1) return null
    path.push(next)
    cur = next
    last = pos
  }
  return path
}

/** Prefer a common word, then a presentable word, then the first candidate. */
function pickPreferred(options: string[]): string | null {
  if (options.length === 0) return null
  return (
    options.find((w) => isCommonWord(w)) ??
    options.find((w) => isPresentableWord(w)) ??
    options[0]
  )
}

/** Deterministic PRNG (mulberry32) — handy for tests and seeded walks. */
export function mulberry32(seed: number): () => number {
  let s = seed | 0
  return function () {
    s = (s + 0x6d2b79f5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export interface WanderOptions {
  /** Probability of taking a step that shortens the distance to the end. */
  greediness?: number
  random?: () => number
  maxRestarts?: number
}

/**
 * A meandering legal path from `start` to `end` (the bot's line): a
 * random walk that respects the lock rule and never revisits a word,
 * biased toward the end by `greediness`. Distances come from the shared
 * reverse-BFS map, so the walk never steps somewhere the end is
 * unreachable from. Falls back to the optimal path when the walk cannot
 * finish. Lower greediness wanders further from the par.
 */
export function wanderingPath(
  start: string,
  end: string,
  options: WanderOptions = {},
  buckets: Buckets = GUESS_BUCKETS,
): string[] | null {
  const {
    greediness = 0.5,
    random = Math.random,
    maxRestarts = 200,
  } = options
  const distToEnd = distancesToEnd(end, buckets)
  const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(random() * arr.length)]
  for (let attempt = 0; attempt < maxRestarts; attempt++) {
    const path = [start]
    const used = new Set<string>([start])
    let cur = start
    let locked = -1
    let stuck = false
    while (cur !== end) {
      const curDist = distToEnd.get(stateKey(cur, locked))
      if (curDist === undefined) {
        stuck = true
        break
      }
      const moves = legalMoves(cur, locked, buckets)
        .filter((m) => !used.has(m.word))
        .map((m) => ({ ...m, d: distToEnd.get(stateKey(m.word, m.pos)) }))
        .filter((m): m is LegalMove & { d: number } => m.d !== undefined)
      if (moves.length === 0) {
        stuck = true
        break
      }
      const reducing = moves.filter((m) => m.d === curDist - 1)
      const next =
        reducing.length > 0 && random() < greediness ? pick(reducing) : pick(moves)
      path.push(next.word)
      used.add(next.word)
      locked = next.pos
      cur = next.word
      if (path.length > 40) {
        stuck = true
        break
      }
    }
    if (!stuck && cur === end) return path
  }
  return preferredPath(start, end, buckets)
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export type StepError =
  | 'Not in dictionary'
  | 'Change 1 letter'
  | 'Already used'
  | "That letter's locked for this rung"

export function validateStep(
  prev: string,
  word: string,
  used: ReadonlySet<string>,
  lockedPos = -1,
): { ok: true } | { ok: false; error: StepError } {
  const w = word.toLowerCase()
  if (!isGuessWord(w)) return { ok: false, error: 'Not in dictionary' }
  const changed = diffIndex(prev, w)
  if (changed === -1) return { ok: false, error: 'Change 1 letter' }
  if (changed === lockedPos) {
    return { ok: false, error: "That letter's locked for this rung" }
  }
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
    // The position changed on the previous step is locked for this one.
    const locked = i >= 2 ? diffIndex(lower[i - 2], lower[i - 1]) : -1
    const check = validateStep(lower[i - 1], lower[i], used, locked)
    if (!check.ok) return { ok: false, error: `${check.error} at step ${i + 1}` }
    used.add(lower[i])
  }
  return { ok: true, steps: lower.length - 1 }
}
