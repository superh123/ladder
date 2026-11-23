/**
 * Candidates Feature - Schema
 *
 * One row per open GitHub issue found by a scan, scored for fit as a
 * first bug-fix for the tracking user's stack. The triage queue on the
 * home page shows rows with `state` = `queued`, highest score first.
 *
 * `state`: queued | saved | dismissed. A rescan refreshes score/reasons
 * but never overwrites a user's save/dismiss decision.
 */

import type { CollectionSchema } from 'deepspace/schema'

export const candidatesSchema: CollectionSchema = {
  name: 'candidates',
  columns: [
    { name: 'repoId', storage: 'text', interpretation: 'plain' },
    { name: 'number', storage: 'number', interpretation: 'plain' },
    { name: 'title', storage: 'text', interpretation: 'plain' },
    { name: 'url', storage: 'text', interpretation: 'plain' },
    // comma-joined label names
    { name: 'labels', storage: 'text', interpretation: 'plain' },
    // GitHub issue created_at, ISO text
    { name: 'createdAt', storage: 'text', interpretation: 'plain' },
    { name: 'comments', storage: 'number', interpretation: 'plain' },
    { name: 'state', storage: 'text', interpretation: 'plain' },
    // 0-100 fit score (deterministic, or AI-judged when available)
    { name: 'score', storage: 'number', interpretation: 'plain' },
    { name: 'fitReasons', storage: 'text', interpretation: 'plain' },
    { name: 'judgedAt', storage: 'text', interpretation: 'plain' },
  ],
  permissions: {
    viewer: { read: 'own', create: false, update: false, delete: false },
    member: { read: 'own', create: true, update: 'own', delete: 'own' },
    admin: { read: true, create: true, update: true, delete: true },
  },
}
