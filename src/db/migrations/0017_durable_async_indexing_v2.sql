CREATE TABLE `learn_reservations_v2` (
	`request_fingerprint` text PRIMARY KEY NOT NULL,
	`idempotency_key_hash` text,
	`doc_id` text NOT NULL,
	`source_file` text NOT NULL,
	`storage_root` text NOT NULL,
	`created_at` integer NOT NULL,
	`content_hash` text,
	`state` text NOT NULL CHECK (`state` IN ('preparing','published','committed')),
	`generation` integer DEFAULT 1 NOT NULL,
	`owner_token` text,
	`lease_until` integer,
	`committed_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_learn_reservation_key` ON `learn_reservations_v2` (`idempotency_key_hash`);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_learn_reservation_doc` ON `learn_reservations_v2` (`doc_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_learn_reservation_file` ON `learn_reservations_v2` (`source_file`);
--> statement-breakpoint
CREATE INDEX `idx_learn_reservation_state` ON `learn_reservations_v2` (`state`,`lease_until`);
--> statement-breakpoint
CREATE TABLE `indexing_jobs_v2` (
	`id` text PRIMARY KEY NOT NULL,
	`doc_id` text NOT NULL,
	`model_key` text NOT NULL,
	`collection` text NOT NULL,
	`content_hash` text NOT NULL,
	`index_revision` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL CHECK (`status` IN ('pending','claimed','retry_wait','done','failed_permanent','exhausted','skipped_missing','superseded','blocked_projection','cancelled')),
	`attempts` integer DEFAULT 0 NOT NULL CHECK (`attempts` >= 0),
	`created_at` integer NOT NULL,
	`next_attempt_at` integer NOT NULL,
	`claim_token` text,
	`claimed_by` text,
	`claimed_at` integer,
	`lease_until` integer,
	`heartbeat_at` integer,
	`finished_at` integer,
	`error` text,
	`cancellation_requested_at` integer,
	`external_write_started_at` integer,
	`cancellation_too_late_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_indexing_jobs_v2_logical` ON `indexing_jobs_v2` (`doc_id`,`model_key`,`content_hash`,`index_revision`);
--> statement-breakpoint
CREATE INDEX `idx_indexing_jobs_v2_due` ON `indexing_jobs_v2` (`model_key`,`status`,`next_attempt_at`,`lease_until`);
--> statement-breakpoint
CREATE INDEX `idx_indexing_jobs_v2_doc` ON `indexing_jobs_v2` (`doc_id`);
--> statement-breakpoint
CREATE TABLE `indexing_job_attempts_v2` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`job_id` text NOT NULL,
	`attempt_no` integer NOT NULL,
	`claim_token` text,
	`worker_id` text,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`outcome` text NOT NULL,
	`error` text,
	FOREIGN KEY (`job_id`) REFERENCES `indexing_jobs_v2`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_indexing_job_attempt_v2` ON `indexing_job_attempts_v2` (`job_id`,`attempt_no`);
--> statement-breakpoint
CREATE INDEX `idx_indexing_job_attempts_v2_job` ON `indexing_job_attempts_v2` (`job_id`,`started_at`);
--> statement-breakpoint
CREATE TABLE `indexing_job_events_v2` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`job_id` text NOT NULL,
	`event_type` text NOT NULL,
	`reason` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `indexing_jobs_v2`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_indexing_job_events_v2_job` ON `indexing_job_events_v2` (`job_id`,`created_at`,`id`);
