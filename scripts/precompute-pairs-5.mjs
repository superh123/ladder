/**
 * Precompute the 5-letter practice/bot/1v1 pair bank (run once, not at
 * runtime). Same quality bar as the 4-letter daily bank, under the LOCK
 * RULE (no same letter position twice in a row): every pair par 4-7,
 * at least 2 distinct shortest paths, a clean presentable-only shortest
 * path, and presentable endpoints.
 *
 * Run: `node scripts/precompute-pairs-5.mjs`
 * Output: `src/lib/practice-pairs-5.ts` (60 pairs).
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const LEN = 5

function loadWords(file) {
  const src = readFileSync(join(root, 'src/lib', file), 'utf8')
  return [...src.matchAll(/'([a-z]{5})'/g)].map((m) => m[1])
}

const COMMON = loadWords('words-common-5.ts')
const GUESS = loadWords('words-guess-5.ts')
const LEGIT = new Set(loadWords('words-legit-5.ts'))
console.log(`common=${COMMON.length} guess=${GUESS.length} legit=${LEGIT.size}`)

const buckets = new Map()
for (const w of GUESS) {
  for (let i = 0; i < LEN; i++) {
    const key = w.slice(0, i) + '_' + w.slice(i + 1)
    if (!buckets.has(key)) buckets.set(key, [])
    buckets.get(key).push(w)
  }
}
function neighbors(w) {
  const out = new Set()
  for (let i = 0; i < LEN; i++) {
    const key = w.slice(0, i) + '_' + w.slice(i + 1)
    for (const v of buckets.get(key) ?? []) if (v !== w) out.add(v)
  }
  return [...out]
}
function diffIndex(a, b) {
  let diff = -1
  for (let i = 0; i < LEN; i++) {
    if (a[i] !== b[i]) {
      if (diff !== -1) return -1
      diff = i
    }
  }
  return diff
}

// Constrained BFS over (word, lastChanged) states. -1 means "fresh start".
function bfsC(start, end) {
  if (start === end) return { dist: 0, count: 1 }
  const dist = new Map([[`${start}:-1`, 0]])
  const count = new Map([[`${start}:-1`, 1]])
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
        q.push({ w: v, last: p })
        if (v === end) endDist = endDist === undefined ? du + 1 : Math.min(endDist, du + 1)
      } else if (dv === du + 1) {
        count.set(vk, Math.min(3, (count.get(vk) ?? 0) + (count.get(uk) ?? 1)))
      }
    }
  }
  if (endDist === undefined) return { dist: -1, count: 0 }
  let total = 0
  for (let last = 0; last < LEN; last++) {
    const k = `${end}:${last}`
    if (dist.get(k) === endDist) total = Math.min(3, total + (count.get(k) ?? 0))
  }
  return { dist: endDist, count: total }
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
    dist >= 4 && dist <= 7 && count >= 2 && clean === dist && LEGIT.has(a) && LEGIT.has(b)
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

const rand = mulberry32(20261123)
const TARGET = 60
const pairs = []
const seenPair = new Set()
const startUse = new Map()
const parHist = new Map()
let tries = 0
const t0 = Date.now()
while (pairs.length < TARGET && tries < 20000) {
  tries++
  const a = COMMON[Math.floor(rand() * COMMON.length)]
  const b = COMMON[Math.floor(rand() * COMMON.length)]
  if (a === b) continue
  const key = [a, b].sort().join('-')
  if (seenPair.has(key)) continue
  if ((startUse.get(a) ?? 0) >= 2 || (startUse.get(b) ?? 0) >= 2) continue
  const { dist, count, clean } = checkPair(a, b)
  if (dist >= 4 && dist <= 7 && count >= 2 && clean === dist) {
    pairs.push([a, b, dist, count])
    parHist.set(dist, (parHist.get(dist) ?? 0) + 1)
    seenPair.add(key)
    startUse.set(a, (startUse.get(a) ?? 0) + 1)
    startUse.set(b, (startUse.get(b) ?? 0) + 1)
  }
  if (tries % 1000 === 0) {
    console.log(`tries=${tries} kept=${pairs.length} (${Math.round((Date.now() - t0) / 1000)}s)`)
  }
}
console.log(`tries=${tries} kept=${pairs.length} in ${Math.round((Date.now() - t0) / 1000)}s`)
console.log(`par distribution: ${[...parHist.entries()].sort().map(([d, n]) => `par${d}=${n}`).join(' ')}`)
for (const [a, b, par, count] of pairs) {
  console.log(`${a} -> ${b} par ${par} paths>=${count}`)
}
if (pairs.length < TARGET) {
  console.error(`only ${pairs.length} pairs — refusing to write a short bank`)
  process.exit(1)
}
const body = pairs.map(([a, b]) => `  ['${a}', '${b}'],`).join('\n')
const out = `/**
 * Precomputed 5-letter pairs for Practice, Bot and 1v1 modes —
 * generated by scripts/precompute-pairs-5.mjs.
 * Every pair is solvable on the 5-letter guess graph with par 4-7, at
 * least 2 distinct shortest paths, and a shortest path made only of
 * presentable words (so hints and the optimal-path reveal read like
 * real words) — all under the lock rule: no letter position changes
 * twice in a row. Do not hand-edit: re-run the script.
 * Practice picks a random pair; 1v1 hashes the match id into this bank.
 */
export const PRACTICE_PAIRS_5: readonly (readonly [string, string])[] = [
${body}
]
`
writeFileSync(join(root, 'src/lib/practice-pairs-5.ts'), out)
console.log('wrote src/lib/practice-pairs-5.ts')
