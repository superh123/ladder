/**
 * Re-validate the daily-pairs bank under the LOCK RULE (no same letter
 * position twice in a row) and repair it in place.
 *
 * Every kept pair must still be par 4-6 with at least 2 distinct
 * shortest paths under the constrained solver, have a clean
 * presentable-only constrained shortest path, and be made of presentable
 * words. Pairs that fail are replaced in their own slot by fresh pairs
 * sampled from the common-word pool (same criteria, same start-word
 * reuse cap as the original precompute), so the bank order — and
 * therefore every past and future daily — is stable for pairs that
 * still pass.
 *
 * Run: `node scripts/revalidate-pairs.mjs`
 * Output: `src/lib/daily-pairs.ts` (only rewritten when a pair changes).
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

function loadWords(file) {
  const src = readFileSync(join(root, 'src/lib', file), 'utf8')
  return [...src.matchAll(/'([a-z]{4})'/g)].map((m) => m[1])
}

const COMMON = loadWords('words-common.ts')
const GUESS = loadWords('words-guess.ts')
const LEGIT = new Set(loadWords('words-legit.ts'))
console.log(`common=${COMMON.length} guess=${GUESS.length} legit=${LEGIT.size}`)

const buckets = new Map()
for (const w of GUESS) {
  for (let i = 0; i < 4; i++) {
    const key = w.slice(0, i) + '_' + w.slice(i + 1)
    if (!buckets.has(key)) buckets.set(key, [])
    buckets.get(key).push(w)
  }
}
function neighbors(w) {
  const out = new Set()
  for (let i = 0; i < 4; i++) {
    const key = w.slice(0, i) + '_' + w.slice(i + 1)
    for (const v of buckets.get(key) ?? []) if (v !== w) out.add(v)
  }
  return [...out]
}
function diffIndex(a, b) {
  let diff = -1
  for (let i = 0; i < 4; i++) {
    if (a[i] !== b[i]) {
      if (diff !== -1) return -1
      diff = i
    }
  }
  return diff
}

// Constrained BFS over (word, lastChanged) states. -1 means "fresh
// start": any position may change first.
function bfsC(start, end) {
  if (start === end) return { dist: 0, count: 1, path: [start] }
  const dist = new Map([[`${start}:-1`, 0]])
  const count = new Map([[`${start}:-1`, 1]])
  const prev = new Map()
  const q = [{ w: start, last: -1 }]
  let head = 0
  let endDist
  while (head < q.length) {
    const { w: u, last } = q[head++]
    const uk = `${u}:${last}`
    const du = dist.get(uk)
    if (endDist !== undefined && du > endDist) break
    for (const v of neighbors(u)) {
      const p = diffIndex(u, v)
      if (p === -1 || p === last) continue
      const vk = `${v}:${p}`
      const dv = dist.get(vk)
      if (dv === undefined) {
        dist.set(vk, du + 1)
        count.set(vk, count.get(uk) ?? 1)
        prev.set(vk, uk)
        q.push({ w: v, last: p })
        if (v === end) endDist = endDist === undefined ? du + 1 : Math.min(endDist, du + 1)
      } else if (dv === du + 1) {
        count.set(vk, Math.min(3, (count.get(vk) ?? 0) + (count.get(uk) ?? 1)))
      }
    }
  }
  if (endDist === undefined) return { dist: -1, count: 0, path: null }
  let total = 0
  let best = null
  for (let last = 0; last < 4; last++) {
    const k = `${end}:${last}`
    if (dist.get(k) === endDist) {
      total = Math.min(3, total + (count.get(k) ?? 0))
      if (!best) best = k
    }
  }
  const path = [end]
  let cur = best
  while (cur && cur !== `${start}:-1`) {
    const p = prev.get(cur)
    if (!p) break
    path.unshift(p.split(':')[0])
    cur = p
  }
  return { dist: endDist, count: total, path }
}

// Constrained shortest distance using only presentable words (endpoints
// included). A clean shortest path exists exactly when this equals par.
function cleanDist(start, end) {
  if (start === end) return 0
  if (!LEGIT.has(start) || !LEGIT.has(end)) return -1
  const dist = new Map([[`${start}:-1`, 0]])
  const q = [{ w: start, last: -1 }]
  let head = 0
  while (head < q.length) {
    const { w: u, last } = q[head++]
    const du = dist.get(`${u}:${last}`)
    for (const v of neighbors(u)) {
      const p = diffIndex(u, v)
      if (p === -1 || p === last) continue
      if (!LEGIT.has(v)) continue
      const vk = `${v}:${p}`
      if (dist.has(vk)) continue
      if (v === end) return du + 1
      dist.set(vk, du + 1)
      q.push({ w: v, last: p })
    }
  }
  return -1
}

function checkPair(a, b) {
  const { dist, count } = bfsC(a, b)
  const clean = cleanDist(a, b)
  const ok =
    dist >= 4 && dist <= 6 && count >= 2 && clean === dist && LEGIT.has(a) && LEGIT.has(b)
  return { ok, dist, count, clean }
}

function mulberry32(seed) {
  return function () {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// --- Load the current bank (order matters: Ladder #N uses slot N-1). ---
const pairsSrc = readFileSync(join(root, 'src/lib/daily-pairs.ts'), 'utf8')
const pairs = [...pairsSrc.matchAll(/\['([a-z]{4})', '([a-z]{4})'\]/g)].map((m) => [m[1], m[2]])
console.log(`bank=${pairs.length}`)

const failures = []
const parHist = new Map()
for (let i = 0; i < pairs.length; i++) {
  const [a, b] = pairs[i]
  const r = checkPair(a, b)
  parHist.set(r.dist, (parHist.get(r.dist) ?? 0) + 1)
  if (!r.ok) failures.push({ index: i, a, b, ...r })
}
console.log(
  `constrained par distribution: ${[...parHist.entries()].sort().map(([d, n]) => `par${d}=${n}`).join(' ')}`,
)
if (failures.length === 0) {
  console.log('all pairs pass under the lock rule — no replacements needed')
} else {
  console.log(`failures (${failures.length}):`)
  for (const f of failures) {
    console.log(
      `  slot ${f.index}: ${f.a} -> ${f.b} par ${f.dist} paths>=${f.count} clean ${f.clean}`,
    )
  }
  // Repair: sample fresh pairs into the failed slots.
  const seenPair = new Set(pairs.map(([a, b]) => [a, b].sort().join('-')))
  const startUse = new Map()
  for (const [a, b] of pairs) {
    startUse.set(a, (startUse.get(a) ?? 0) + 1)
    startUse.set(b, (startUse.get(b) ?? 0) + 1)
  }
  const rand = mulberry32(20261123)
  let tries = 0
  for (const f of failures) {
    // Free the failed slot's words for reuse accounting.
    startUse.set(f.a, (startUse.get(f.a) ?? 0) - 1)
    startUse.set(f.b, (startUse.get(f.b) ?? 0) - 1)
    seenPair.delete([f.a, f.b].sort().join('-'))
    let replacement = null
    while (tries < 20000) {
      tries++
      const a = COMMON[Math.floor(rand() * COMMON.length)]
      const b = COMMON[Math.floor(rand() * COMMON.length)]
      if (a === b) continue
      const key = [a, b].sort().join('-')
      if (seenPair.has(key)) continue
      if ((startUse.get(a) ?? 0) >= 2 || (startUse.get(b) ?? 0) >= 2) continue
      const r = checkPair(a, b)
      if (r.ok) {
        replacement = [a, b]
        break
      }
    }
    if (!replacement) {
      console.error(`could not find a replacement for slot ${f.index}`)
      process.exit(1)
    }
    console.log(
      `  slot ${f.index}: ${f.a} -> ${f.b} replaced by ${replacement[0]} -> ${replacement[1]}`,
    )
    pairs[f.index] = replacement
    seenPair.add([replacement[0], replacement[1]].sort().join('-'))
    startUse.set(replacement[0], (startUse.get(replacement[0]) ?? 0) + 1)
    startUse.set(replacement[1], (startUse.get(replacement[1]) ?? 0) + 1)
  }
  console.log(`tries=${tries} — rewriting src/lib/daily-pairs.ts`)
  const body = pairs.map(([a, b]) => `  ['${a}', '${b}'],`).join('\n')
  const out = `/**
 * Precomputed daily pairs — generated by scripts/precompute-pairs.mjs,
 * re-validated under the lock rule by scripts/revalidate-pairs.mjs.
 * Every pair is solvable on the guess graph with par 4-6, at least 2
 * distinct shortest paths, and a shortest path made only of presentable
 * words (so hints and the optimal-path reveal read like real words) —
 * all under the lock rule: no letter position changes twice in a row.
 * Do not hand-edit: re-run the script.
 * Ladder #N (N = days since 2026-11-22 UTC + 1) uses pair (N-1) % ${pairs.length}.
 */
export const DAILY_PAIRS: readonly (readonly [string, string])[] = [
${body}
]
`
  writeFileSync(join(root, 'src/lib/daily-pairs.ts'), out)
  console.log('wrote src/lib/daily-pairs.ts')
}

// Today's pair, checked explicitly (slot 1 = Ladder #2, 2026-11-23).
const today = checkPair(pairs[1][0], pairs[1][1])
console.log(
  `today (${pairs[1][0]} -> ${pairs[1][1]}): par ${today.dist} paths>=${today.count} clean ${today.clean} ok=${today.ok}`,
)
