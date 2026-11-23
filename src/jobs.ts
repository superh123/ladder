/**
 * Background-job handler — invoked by AppJobRoom (worker.ts) for every
 * job picked up from the queue. Dispatch on `job.type` and return a
 * result (captured as `job.result`) or throw to fail.
 *
 * The only job type is `scan-repo`: fetch a repo's open GitHub issues,
 * score them for first-bug-fix fit, and upsert `candidates` rows. The
 * scan engine lives in src/server/scan.ts and is shared with the hourly
 * rescan cron.
 *
 * Jobs have no built-in records/integration client, so the handler builds
 * a server context with `buildCronContext` — the SDK's server-side data
 * client, which only needs RECORD_ROOMS + APP_OWNER_JWT from env. It runs
 * as the user who enqueued the job (`job.enqueuedBy`), so rows the scan
 * creates are owned by that user and stay readable under the collections'
 * `read: 'own'` permissions; the app owner is the fallback.
 */

import type { Job, JobContext } from 'deepspace/worker'
import { buildCronContext } from 'deepspace/worker'
import { scanRepo } from './server/scan.js'

/** Minimal env shape the scan needs — a subset of the worker's Env. */
export interface ScanEnv {
  RECORD_ROOMS: DurableObjectNamespace
  APP_OWNER_JWT?: string
  OWNER_USER_ID: string
  DEEPSPACE_APP_ID: string
  API_WORKER?: Fetcher
  API_WORKER_URL?: string
}

interface ScanRepoPayload {
  repoId: string
  owner: string
  repo: string
  stack: string
}

export async function runJob(
  job: Job,
  ctx: JobContext,
  env: ScanEnv,
): Promise<unknown> {
  switch (job.type) {
    case 'scan-repo': {
      const payload = job.payload as ScanRepoPayload
      if (!payload?.repoId || !payload?.owner || !payload?.repo) {
        throw new Error('scan-repo payload needs repoId, owner, and repo')
      }
      const server = buildCronContext(
        env,
        job.enqueuedBy ?? env.OWNER_USER_ID,
        `app:${env.DEEPSPACE_APP_ID}`,
      )
      const result = await scanRepo(
        server,
        {
          recordId: payload.repoId,
          owner: payload.owner,
          repo: payload.repo,
          stack: payload.stack ?? '',
        },
        (value, message) => ctx.progress(value, message),
      )
      return result
    }
    default:
      throw new Error(`Unknown job type: ${job.type}`)
  }
}
