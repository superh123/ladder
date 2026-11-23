/**
 * Repos Feature - Schema
 *
 * One row per GitHub repo a user tracks. The scan job (src/jobs.ts) reads
 * these rows and writes `candidates`; the cron rescan (src/cron.ts) picks
 * up rows whose status is `idle`.
 *
 * `createdBy` is the tracking user — the digest cron uses it to find the
 * owner's email in the `users` collection.
 */

import type { CollectionSchema } from 'deepspace/schema'

export const reposSchema: CollectionSchema = {
  name: 'repos',
  columns: [
    { name: 'owner', storage: 'text', interpretation: 'plain' },
    { name: 'repo', storage: 'text', interpretation: 'plain' },
    { name: 'stack', storage: 'text', interpretation: 'plain' },
    // idle | scanning | error
    { name: 'status', storage: 'text', interpretation: 'plain' },
    { name: 'lastScannedAt', storage: 'text', interpretation: 'plain' },
    { name: 'error', storage: 'text', interpretation: 'plain' },
  ],
  permissions: {
    viewer: { read: 'own', create: false, update: false, delete: false },
    member: { read: 'own', create: true, update: 'own', delete: 'own' },
    admin: { read: true, create: true, update: true, delete: true },
  },
}
