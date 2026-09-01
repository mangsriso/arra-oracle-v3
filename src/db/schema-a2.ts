import { sqliteTable, text, integer, index, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const learnReservationsV2 = sqliteTable('learn_reservations_v2', {
  requestFingerprint: text('request_fingerprint').primaryKey(),
  idempotencyKeyHash: text('idempotency_key_hash'),
  docId: text('doc_id').notNull(), sourceFile: text('source_file').notNull(),
  storageRoot: text('storage_root').notNull(), createdAt: integer('created_at').notNull(),
  contentHash: text('content_hash'), state: text('state').notNull(),
  generation: integer('generation').notNull().default(1), ownerToken: text('owner_token'),
  leaseUntil: integer('lease_until'), committedAt: integer('committed_at'),
}, (table) => [
  uniqueIndex('uq_learn_reservation_key').on(table.idempotencyKeyHash),
  uniqueIndex('uq_learn_reservation_doc').on(table.docId),
  uniqueIndex('uq_learn_reservation_file').on(table.sourceFile),
  index('idx_learn_reservation_state').on(table.state, table.leaseUntil),
]);

export const indexingJobsV2 = sqliteTable('indexing_jobs_v2', {
  id: text('id').primaryKey(), docId: text('doc_id').notNull(),
  modelKey: text('model_key').notNull(), collection: text('collection').notNull(),
  contentHash: text('content_hash').notNull(), indexRevision: text('index_revision').notNull(),
  status: text('status').notNull().default('pending'),
  attempts: integer('attempts').notNull().default(0), createdAt: integer('created_at').notNull(),
  nextAttemptAt: integer('next_attempt_at').notNull(), claimToken: text('claim_token'),
  claimedBy: text('claimed_by'), claimedAt: integer('claimed_at'),
  leaseUntil: integer('lease_until'), heartbeatAt: integer('heartbeat_at'),
  finishedAt: integer('finished_at'), error: text('error'),
  cancellationRequestedAt: integer('cancellation_requested_at'),
  externalWriteStartedAt: integer('external_write_started_at'),
  cancellationTooLateAt: integer('cancellation_too_late_at'),
}, (table) => [
  uniqueIndex('uq_indexing_jobs_v2_logical').on(
    table.docId, table.modelKey, table.contentHash, table.indexRevision,
  ),
  index('idx_indexing_jobs_v2_due').on(
    table.modelKey, table.status, table.nextAttemptAt, table.leaseUntil,
  ),
  index('idx_indexing_jobs_v2_doc').on(table.docId),
]);

export const indexingJobAttemptsV2 = sqliteTable('indexing_job_attempts_v2', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  jobId: text('job_id').notNull().references(() => indexingJobsV2.id),
  attemptNo: integer('attempt_no').notNull(), claimToken: text('claim_token'),
  workerId: text('worker_id'), startedAt: integer('started_at').notNull(),
  finishedAt: integer('finished_at'), outcome: text('outcome').notNull(), error: text('error'),
}, (table) => [
  uniqueIndex('uq_indexing_job_attempt_v2').on(table.jobId, table.attemptNo),
  index('idx_indexing_job_attempts_v2_job').on(table.jobId, table.startedAt),
]);

export const indexingJobEventsV2 = sqliteTable('indexing_job_events_v2', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  jobId: text('job_id').notNull().references(() => indexingJobsV2.id),
  eventType: text('event_type').notNull(), reason: text('reason').notNull(),
  createdAt: integer('created_at').notNull(),
}, (table) => [
  index('idx_indexing_job_events_v2_job').on(table.jobId, table.createdAt, table.id),
]);
