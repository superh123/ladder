/**
 * Ladder — public API routes. No sign-in anywhere: the daily puzzle,
 * validation, hints and leaderboard are all anonymous.
 *
 * Anti-cheat shape: the client only ever learns the start/end words.
 * Step validation, hints and the par/optimal path are computed here,
 * server-side, from the guess graph — and the par is revealed only
 * after a fully re-validated finish in /api/submit.
 *
 * All record access goes through a CronContext built with the app-owner
 * identity (see src/server/ladder.ts), so the `scores` collection can
 * stay admin-only in the schema.
 */

import type { Hono } from 'hono'
import { buildCronContext } from 'deepspace/worker'
import type { CronContext } from 'deepspace/worker'
import {
  bfs,
  dailyPairFor,
  diffIndex,
  GUESS_BUCKETS,
  isValidDateStr,
  ladderNumberFor,
  nextStepOnShortestPath,
  preferredPath,
  utcDateString,
  validatePath,
  validateStep,
} from '../lib/ladder.js'
import { DAILY_PAIRS } from '../lib/daily-pairs.js'
import {
  ensureSeeded,
  readBoard,
  rowData,
  rowId,
  toNum,
  toStr,
} from './ladder.js'
import type { AppContext, Env } from '../../worker.js'

function serverContext(env: Env): CronContext {
  return buildCronContext(env, env.OWNER_USER_ID, `app:${env.DEEPSPACE_APP_ID}`)
}

async function readJson(c: {
  req: { json: <T>() => Promise<T> }
}): Promise<Record<string, unknown>> {
  try {
    const body = await c.req.json<unknown>()
    return typeof body === 'object' && body !== null
      ? (body as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

function cleanName(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const name = value.trim()
  if (name.length < 1 || name.length > 20) return null
  if (!/^[A-Za-z0-9][A-Za-z0-9 _-]*$/.test(name)) return null
  return name
}

function cleanSeconds(value: unknown): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : 0
  return Math.max(0, Math.min(86_400, n))
}

function cleanHints(value: unknown): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : 0
  return Math.max(0, n)
}

function wordList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((w): w is string => typeof w === 'string')
    .map((w) => w.toLowerCase())
    .filter((w) => /^[a-z]{4}$/.test(w))
}

export function registerLadderRoutes(app: Hono<AppContext>): void {
  // Today's (or a requested) daily puzzle. The par is never included.
  app.get('/api/daily', (c) => {
    const raw = c.req.query('date')
    const date = raw && isValidDateStr(raw) ? raw : utcDateString(new Date())
    const { start, end } = dailyPairFor(date)
    return c.json({ date, number: ladderNumberFor(date), start, end })
  })

  // Validate one proposed rung against the path so far.
  // Body: { start, end, path: string[] (including start), word }
  // The lock rule is enforced from the path: the position changed on
  // the previous step is locked for this one.
  app.post('/api/validate', async (c) => {
    const body = await readJson(c)
    const path = wordList(body.path)
    const word = typeof body.word === 'string' ? body.word.toLowerCase() : ''
    if (path.length === 0 || !/^[a-z]{4}$/.test(word)) {
      return c.json({ ok: false, error: 'Not in dictionary' }, 400)
    }
    const prev = path[path.length - 1]
    const locked =
      path.length >= 2 ? diffIndex(path[path.length - 2], prev) : -1
    const used = new Set(path)
    const check = validateStep(prev, word, used, locked)
    if (!check.ok) return c.json({ ok: false, error: check.error })
    return c.json({ ok: true })
  })

  // Next word on a shortest path from `current` to `end`.
  // Body: { start, end, current, path?: string[] } — when the path is
  // sent, the locked position is derived from its last two rungs so the
  // hint never suggests changing a locked letter.
  app.post('/api/hint', async (c) => {
    const body = await readJson(c)
    const current = typeof body.current === 'string' ? body.current.toLowerCase() : ''
    const end = typeof body.end === 'string' ? body.end.toLowerCase() : ''
    if (!/^[a-z]{4}$/.test(current) || !/^[a-z]{4}$/.test(end)) {
      return c.json({ next: null }, 400)
    }
    const path = wordList(body.path)
    const locked =
      path.length >= 2
        ? diffIndex(path[path.length - 2], path[path.length - 1])
        : -1
    return c.json({
      next: nextStepOnShortestPath(current, end, GUESS_BUCKETS, locked),
    })
  })

  // Reveal the par for a finished practice ladder (no persistence).
  // Body: { start, end, path, hintsUsed }
  app.post('/api/reveal', async (c) => {
    const body = await readJson(c)
    const start = typeof body.start === 'string' ? body.start.toLowerCase() : ''
    const end = typeof body.end === 'string' ? body.end.toLowerCase() : ''
    const path = wordList(body.path)
    if (!/^[a-z]{4}$/.test(start) || !/^[a-z]{4}$/.test(end)) {
      return c.json({ valid: false, error: 'Bad pair' }, 400)
    }
    const check = validatePath(start, end, path)
    if (!check.ok) {
      return c.json({ valid: false, error: check.error }, 400)
    }
    const steps = check.steps ?? path.length - 1
    const { dist: par } = bfs(start, end)
    const optimalPath = preferredPath(start, end) ?? []
    return c.json({
      valid: true,
      steps,
      par,
      optimalPath,
      isPar: steps === par && cleanHints(body.hintsUsed) === 0,
    })
  })

  // A random pair for practice mode. The par is never included.
  app.get('/api/practice', (c) => {
    const idx = Math.floor(Math.random() * DAILY_PAIRS.length)
    const [start, end] = DAILY_PAIRS[idx]
    return c.json({ start, end })
  })

  // Forfeit: reveal par + optimal path for the current pair without
  // scoring. This is a deliberate forfeit — the run is not saved and the
  // streak is untouched — so the answer is only ever revealed after the
  // player chooses to give up (or finishes). Body: { start, end }.
  app.post('/api/giveup', async (c) => {
    const body = await readJson(c)
    const start = typeof body.start === 'string' ? body.start.toLowerCase() : ''
    const end = typeof body.end === 'string' ? body.end.toLowerCase() : ''
    if (!/^[a-z]{4}$/.test(start) || !/^[a-z]{4}$/.test(end)) {
      return c.json({ par: -1, optimalPath: [] }, 400)
    }
    const { dist: par } = bfs(start, end)
    const optimalPath = preferredPath(start, end) ?? []
    return c.json({ par, optimalPath })
  })

  // Submit a finished daily ladder. The server re-validates everything:
  // the date's pair, every step, and the finish — then upserts the
  // player's best score for (date, name) and reveals par + optimal path.
  // Body: { date, path, name, seconds, hintsUsed }
  app.post('/api/submit', async (c) => {
    const body = await readJson(c)
    const date = typeof body.date === 'string' ? body.date : ''
    if (!isValidDateStr(date)) {
      return c.json({ valid: false, error: 'Bad date' }, 400)
    }
    const name = cleanName(body.name)
    if (!name) {
      return c.json({ valid: false, error: 'Name must be 1-20 letters, numbers, spaces, _ or -' }, 400)
    }
    const { start, end } = dailyPairFor(date)
    const path = wordList(body.path)
    const check = validatePath(start, end, path)
    if (!check.ok) {
      return c.json({ valid: false, error: check.error }, 400)
    }
    const steps = check.steps ?? path.length - 1
    const seconds = cleanSeconds(body.seconds)
    const hintsUsed = cleanHints(body.hintsUsed)
    const { dist: par } = bfs(start, end)
    const optimalPath = preferredPath(start, end) ?? []

    const server = serverContext(c.env)
    const nowIso = new Date().toISOString()
    const existing = await server.records.query('scores', {
      where: { date, name },
      limit: 10,
    })
    let ownRecordId: string | null = null
    let ownSteps = Number.POSITIVE_INFINITY
    let ownSeconds = Number.POSITIVE_INFINITY
    for (const row of existing) {
      const data = rowData(row)
      if (toNum(data.seeded, 0) === 1) continue // seeded rows are never a player's own
      ownRecordId = rowId(row)
      ownSteps = toNum(data.steps, Number.POSITIVE_INFINITY)
      ownSeconds = toNum(data.seconds, Number.POSITIVE_INFINITY)
    }
    const better =
      steps < ownSteps || (steps === ownSteps && seconds < ownSeconds)
    let isBest = false
    if (ownRecordId === null) {
      await server.records.create('scores', {
        date,
        name,
        steps,
        seconds,
        seeded: 0,
        createdAt: nowIso,
      })
      isBest = true
    } else if (better) {
      await server.records.update('scores', ownRecordId, {
        steps,
        seconds,
        createdAt: nowIso,
      })
      isBest = true
    }

    const board = await readBoard(server, date)
    const rank =
      board.filter((e) => e.steps < steps || (e.steps === steps && e.seconds < seconds))
        .length + 1
    return c.json({
      valid: true,
      steps,
      par,
      optimalPath,
      isPar: steps === par && hintsUsed === 0,
      isBest,
      rank,
      total: board.length,
    })
  })

  // Today's board (seeded rows + real submissions), best first.
  app.get('/api/leaderboard', async (c) => {
    const raw = c.req.query('date')
    const date = raw && isValidDateStr(raw) ? raw : utcDateString(new Date())
    const server = serverContext(c.env)
    await ensureSeeded(server, date)
    const entries = await readBoard(server, date)
    const { start, end } = dailyPairFor(date)
    return c.json({
      date,
      number: ladderNumberFor(date),
      par: bfs(start, end).dist,
      entries,
    })
  })
}
