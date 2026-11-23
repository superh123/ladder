/**
 * Background-job handler — invoked by AppJobRoom (worker.ts) for every
 * job picked up from the queue.
 *
 * Ladder has no background jobs: the daily puzzle is deterministic
 * (computed from the date), scoring is a synchronous server check, and
 * the board is seeded by cron. This file stays as the stub the worker
 * expects, plus the shared server-env shape used by cron and routes.
 */

import type { Job, JobContext } from 'deepspace/worker'

/** Minimal env shape server-side code needs — a subset of the worker's Env. */
export interface ScanEnv {
  RECORD_ROOMS: DurableObjectNamespace
  APP_OWNER_JWT?: string
  OWNER_USER_ID: string
  DEEPSPACE_APP_ID: string
  API_WORKER?: Fetcher
  API_WORKER_URL?: string
}

export async function runJob(
  job: Job,
  _ctx: JobContext,
  _env: ScanEnv,
): Promise<unknown> {
  throw new Error(`Unknown job type: ${job.type}`)
}
