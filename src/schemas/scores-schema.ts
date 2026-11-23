/**
 * Scores Feature - Schema
 *
 * One row per (date, player name) best result on the daily ladder.
 * All writes go through the worker's public routes (/api/submit) using
 * the app-owner server context — clients never write this collection
 * directly, so it is admin-only here. `seeded` rows are the deterministic
 * daily board filler (see src/server/ladder.ts); `seeded: false` rows are
 * real player submissions.
 *
 * `steps` counts rungs beyond the start word. `seconds` is the player's
 * own reported solve time, used only as a tiebreak.
 */

import type { CollectionSchema } from 'deepspace/schema'

export const scoresSchema: CollectionSchema = {
  name: 'scores',
  columns: [
    { name: 'date', storage: 'text', interpretation: 'plain' },
    { name: 'name', storage: 'text', interpretation: 'plain' },
    { name: 'steps', storage: 'number', interpretation: 'plain' },
    { name: 'seconds', storage: 'number', interpretation: 'plain' },
    { name: 'seeded', storage: 'number', interpretation: 'plain' },
    { name: 'createdAt', storage: 'text', interpretation: 'plain' },
  ],
  permissions: {
    viewer: { read: false, create: false, update: false, delete: false },
    member: { read: false, create: false, update: false, delete: false },
    admin: { read: true, create: true, update: true, delete: true },
  },
}
