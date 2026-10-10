CREATE TYPE "public"."project_agent_lifecycle" AS ENUM('persistent', 'dynamic');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "project_agents" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"role_id" text NOT NULL,
	"lifecycle" "project_agent_lifecycle" NOT NULL,
	"execution_preference" jsonb,
	"memory_namespace" text,
	"conversation_thread_id" text,
	"enabled" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "config_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "task_attempts" ADD COLUMN "model" text;--> statement-breakpoint
ALTER TABLE "task_attempts" ADD COLUMN "failure_kind" text;--> statement-breakpoint
ALTER TABLE "task_attempts" ADD COLUMN "pid" integer;--> statement-breakpoint
ALTER TABLE "task_attempts" ADD COLUMN "log_path" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "execution_preference" jsonb;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "worktree_path" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "branch" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "project_agents" ADD CONSTRAINT "project_agents_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
