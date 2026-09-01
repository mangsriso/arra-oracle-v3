/**
 * TypeBox schemas for knowledge routes.
 */

import { t } from 'elysia';

export const LearnBody = t.Object({
  pattern: t.String({ minLength: 1 }),
  source: t.Optional(t.String()),
  concepts: t.Optional(t.Array(t.String())),
  origin: t.Optional(t.String()),
  project: t.Optional(t.String()),
  cwd: t.Optional(t.String()),
  idempotency_key: t.Optional(t.String({ minLength: 1 })),
}, { additionalProperties: false });
export const HandoffBody = t.Any();

export const InboxQuery = t.Object({
  limit: t.Optional(t.String()),
  offset: t.Optional(t.String()),
  type: t.Optional(t.String()),
});
