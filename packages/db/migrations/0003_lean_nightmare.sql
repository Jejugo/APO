CREATE TYPE "public"."provider_availability" AS ENUM('available', 'degraded', 'exhausted', 'unknown');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "handovers" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"from_attempt_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "provider_capacity" (
	"provider" "provider" PRIMARY KEY NOT NULL,
	"availability" "provider_availability" DEFAULT 'unknown' NOT NULL,
	"usage_percent" integer,
	"reset_at" timestamp with time zone,
	"reason" text,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "routing_decisions" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"router" text NOT NULL,
	"resolution_source" text NOT NULL,
	"input" jsonb,
	"output" jsonb,
	"final_target" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "task_attempts" ADD COLUMN "target_id" text;--> statement-breakpoint
ALTER TABLE "task_attempts" ADD COLUMN "resolution_source" text;--> statement-breakpoint
ALTER TABLE "task_attempts" ADD COLUMN "handover_id" text;--> statement-breakpoint
ALTER TABLE "task_attempts" ADD COLUMN "failure_message" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "handovers" ADD CONSTRAINT "handovers_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "handovers" ADD CONSTRAINT "handovers_from_attempt_id_task_attempts_id_fk" FOREIGN KEY ("from_attempt_id") REFERENCES "public"."task_attempts"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "routing_decisions" ADD CONSTRAINT "routing_decisions_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
