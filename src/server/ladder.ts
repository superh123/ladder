/**
 * Ladder — server-side data helpers.
 *
 * Shared by the public routes (src/server/ladder-routes.ts) and the
 * seed-board cron (src/cron.ts). All access goes through a CronContext
 * built with the app-owner identity, so the `scores` collection can stay
 * admin-only in the schema: no anonymous client ever writes it directly.
 */

import type { CronContext } from 'deepspace/worker'
import { bfs, dailyPairFor } from '../lib/ladder.js'

// ---------------------------------------------------------------------------
// Defensive shape helpers — RecordRoom rows arrive as
// { recordId, data, createdBy, ... }.
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : null
}

export function rowData(row: unknown): Record<string, unknown> {
  const rec = asRecord(row)
  if (!rec) return {}
  return asRecord(rec.data) ?? rec
}

export function rowId(row: unknown): string {
  return String(asRecord(row)?.recordId ?? '')
}

export function toStr(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

export function toNum(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

export function toBool(value: unknown): boolean {
  return value === true
}

// ---------------------------------------------------------------------------
// Leaderboard
// ---------------------------------------------------------------------------

export interface BoardEntry {
  name: string
  steps: number
  seconds: number
  seeded: boolean
}

export function boardSort(a: BoardEntry, b: BoardEntry): number {
  return a.steps - b.steps || a.seconds - b.seconds
}

export async function readBoard(
  server: CronContext,
  date: string,
): Promise<BoardEntry[]> {
  const rows = await server.records.query('scores', {
    where: { date },
    limit: 500,
  })
  return rows
    .map((row) => {
      const data = rowData(row)
      return {
        name: toStr(data.name),
        steps: toNum(data.steps, 0),
        seconds: toNum(data.seconds, 0),
        seeded: toBool(data.seeded),
      } satisfies BoardEntry
    })
    .filter((e) => e.name && e.steps > 0)
    .sort(boardSort)
}

// ---------------------------------------------------------------------------
// Seeded board — deterministic per date, so the board looks alive on day
// one and is identical on every read. Steps are par + a small delta, so a
// seeded row can never claim fewer steps than the true par.
// ---------------------------------------------------------------------------

const SEED_NAMES = [
  'Maya',
  'Jonas',
  'Priya',
  'Sam',
  'Alex',
  'Nora',
  'Felix',
  'June',
  'Omar',
  'Tess',
  'Hugo',
  'Iris',
]

function hashSeed(text: string): number {
  let h = 2166136261
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function seededEntriesFor(date: string): BoardEntry[] {
  const { start, end } = dailyPairFor(date)
  const par = bfs(start, end).dist
  const rand = mulberry32(hashSeed(`ladder-seed:${date}`))
  // Deltas: mostly +1/+2, sometimes par itself, sometimes +3.
  const deltas = [0, 1, 1, 1, 2, 2, 2, 3, 1, 2, 0, 3]
  return SEED_NAMES.map((name, i) => ({
    name,
    steps: Math.max(1, par + deltas[i % deltas.length]),
    seconds: Math.round(45 + rand() * 380),
    seeded: true,
  })).sort(boardSort)
}

/**
 * Insert the seeded rows for `date` exactly once. Idempotent via the
 * check-first query; a rare concurrent double-seed would only duplicate
 * a name on the board, and the cron (00:05 UTC) normally seeds before
 * any reader gets there.
 */
export async function ensureSeeded(
  server: CronContext,
  date: string,
): Promise<void> {
  const existing = await server.records.query('scores', {
    where: { date, seeded: true },
    limit: 1,
  })
  if (existing.length > 0) return
  const nowIso = new Date().toISOString()
  for (const entry of seededEntriesFor(date)) {
    await server.records.create('scores', {
      date,
      name: entry.name,
      steps: entry.steps,
      seconds: entry.seconds,
      seeded: true,
      createdAt: nowIso,
    })
  }
}
