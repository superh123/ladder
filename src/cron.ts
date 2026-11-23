/**
 * Cron task definitions — registered into the AppCronRoom DO at construction
 * time (worker.ts). The DO alarm fires `runTask(name, env)` on the schedule
 * declared here.
 *
 * - `rescan-repos` (hourly): enqueue a `scan-repo` job for every repo whose
 *   status is `idle`. Enqueued as the repo's owner (`enqueuedBy`), so the
 *   scan job writes rows that user can read.
 * - `daily-digest` (09:00 America/Los_Angeles): email each repo owner their
 *   new queued high-fit candidates (score >= 70). The email integration
 *   ignores any `from` — mail comes from notifications@updates.app.space —
 *   so none is set. If the owner's email isn't in the `users` collection,
 *   that owner is skipped; no address is ever invented.
 */

import type { CronTask } from 'deepspace/worker'
import { buildCronContext, enqueueJob } from 'deepspace/worker'
import { rowCreatedBy, rowData, rowId } from './server/scan.js'
import type { ScanEnv } from './jobs.js'

type CronEnv = ScanEnv & { JOB_ROOMS: DurableObjectNamespace }

export const tasks: CronTask[] = [
  { name: 'rescan-repos', intervalMinutes: 60 },
  { name: 'daily-digest', schedule: '0 9 * * *', timezone: 'America/Los_Angeles' },
]

function toStr(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function toNum(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

async function rescanRepos(env: CronEnv): Promise<void> {
  const server = buildCronContext(env, env.OWNER_USER_ID, `app:${env.DEEPSPACE_APP_ID}`)
  const repos = await server.records.query('repos', {
    where: { status: 'idle' },
    limit: 50,
  })
  for (const row of repos) {
    const data = rowData(row)
    const recordId = rowId(row)
    if (!recordId) continue
    await enqueueJob(
      env.JOB_ROOMS,
      `app:${env.DEEPSPACE_APP_ID}`,
      'scan-repo',
      {
        repoId: recordId,
        owner: toStr(data.owner),
        repo: toStr(data.repo),
        stack: toStr(data.stack),
      },
      { enqueuedBy: rowCreatedBy(row) || undefined },
    )
  }
}

async function dailyDigest(env: CronEnv): Promise<void> {
  const server = buildCronContext(env, env.OWNER_USER_ID, `app:${env.DEEPSPACE_APP_ID}`)

  const repos = await server.records.query('repos', { limit: 50 })
  if (repos.length === 0) return

  // Owner email lookup: users rows keyed by recordId (== auth user id).
  const users = await server.records.query('users', { limit: 100 })
  const emailByUserId = new Map<string, string>()
  for (const row of users) {
    const data = rowData(row)
    const email = toStr(data.email)
    if (rowId(row) && email) emailByUserId.set(rowId(row), email)
  }

  // Group high-fit queued candidates by repo owner.
  const linesByOwner = new Map<string, string[]>()
  for (const repoRow of repos) {
    const repo = rowData(repoRow)
    const ownerId = rowCreatedBy(repoRow)
    if (!ownerId) continue
    const candidates = await server.records.query('candidates', {
      where: { repoId: rowId(repoRow), state: 'queued' },
      limit: 100,
    })
    const hot = candidates
      .map((c) => rowData(c))
      .filter((c) => toNum(c.score, 0) >= 70)
      .sort((a, b) => toNum(b.score, 0) - toNum(a.score, 0))
      .slice(0, 10)
    if (hot.length === 0) continue
    const lines = linesByOwner.get(ownerId) ?? []
    lines.push(`${toStr(repo.owner)}/${toStr(repo.repo)}:`)
    for (const c of hot) {
      lines.push(`  • [${toNum(c.score, 0)}] #${toNum(c.number, 0)} ${toStr(c.title)} — ${toStr(c.url)}`)
    }
    linesByOwner.set(ownerId, lines)
  }

  for (const [ownerId, lines] of linesByOwner) {
    const email = emailByUserId.get(ownerId)
    if (!email) continue // never invent an address
    await server.integrations.call('email/send', {
      to: email,
      subject: 'Issue Radar: new high-fit issues to triage',
      text: [
        'New issues scored 70+ for a first bug-fix landed in your Issue Radar queue:',
        '',
        ...lines,
        '',
        'Open Issue Radar to save or dismiss them.',
      ].join('\n'),
    })
  }
}

export async function runTask(name: string, env: CronEnv): Promise<void> {
  if (name === 'rescan-repos') {
    await rescanRepos(env)
    return
  }
  if (name === 'daily-digest') {
    await dailyDigest(env)
    return
  }
  throw new Error(`Unknown cron task: ${name}`)
}
