/**
 * Cron task definitions — registered into the AppCronRoom DO at construction
 * time (worker.ts). The DO alarm fires `runTask(name, env)` on the schedule
 * declared here.
 *
 * - `seed-board` (00:05 UTC daily): seed today's leaderboard with its
 *   deterministic rows (see src/server/ladder.ts) so the board looks
 *   alive from the first read. Reads also seed lazily, so the board is
 *   never empty even if this run is missed.
 */

import type { CronTask } from 'deepspace/worker'
import { buildCronContext } from 'deepspace/worker'
import { ensureSeeded } from './server/ladder.js'
import { utcDateString } from './lib/ladder.js'
import type { ScanEnv } from './jobs.js'

type CronEnv = ScanEnv & { JOB_ROOMS: DurableObjectNamespace }

export const tasks: CronTask[] = [
  { name: 'seed-board', schedule: '5 0 * * *', timezone: 'UTC' },
]

export async function runTask(name: string, env: CronEnv): Promise<void> {
  if (name === 'seed-board') {
    const server = buildCronContext(env, env.OWNER_USER_ID, `app:${env.DEEPSPACE_APP_ID}`)
    await ensureSeeded(server, utcDateString(new Date()))
    return
  }
  throw new Error(`Unknown cron task: ${name}`)
}
