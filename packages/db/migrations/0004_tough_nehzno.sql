ALTER TABLE "features" ADD COLUMN "plan" jsonb;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "seq" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "role" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "expected_paths" text[];--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "actual_changed_paths" text[];--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "artifacts" jsonb;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "summary" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "origin" text DEFAULT 'plan' NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "workspace_mode" text;