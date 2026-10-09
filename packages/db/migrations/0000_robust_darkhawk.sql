CREATE TYPE "public"."feature_intent" AS ENUM('bugfix', 'feature');--> statement-breakpoint
CREATE TYPE "public"."feature_status" AS ENUM('created', 'planning', 'executing', 'integrating', 'validating', 'reviewing', 'fixing', 'paused_capacity', 'awaiting_approval', 'delivering', 'rejected', 'completed', 'paused', 'cancelled', 'failed', 'needs_human');--> statement-breakpoint
CREATE TYPE "public"."harness" AS ENUM('claude-code', 'codex', 'gemini-cli', 'fake');--> statement-breakpoint
CREATE TYPE "public"."provider" AS ENUM('anthropic', 'openai', 'google');--> statement-breakpoint
CREATE TYPE "public"."task_attempt_status" AS ENUM('starting', 'working', 'completed', 'failed', 'rate_limited', 'stalled', 'cancelled', 'interrupted');--> statement-breakpoint
CREATE TYPE "public"."task_kind" AS ENUM('read', 'write');--> statement-breakpoint
CREATE TYPE "public"."task_status" AS ENUM('pending', 'ready', 'running', 'retrying', 'awaiting_answer', 'completed', 'failed', 'cancelled', 'needs_human');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"project_id" text,
	"feature_id" text,
	"task_id" text,
	"payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "features" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"objective" text NOT NULL,
	"intent" "feature_intent" NOT NULL,
	"status" "feature_status" DEFAULT 'created' NOT NULL,
	"integration_branch" text,
	"fix_iteration" integer DEFAULT 0 NOT NULL,
	"pr_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "projects" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"repo_path" text NOT NULL,
	"default_branch" text DEFAULT 'main' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "task_attempts" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"n" integer NOT NULL,
	"provider" "provider" NOT NULL,
	"harness" "harness" NOT NULL,
	"status" "task_attempt_status" DEFAULT 'starting' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"feature_id" text NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"kind" "task_kind" NOT NULL,
	"status" "task_status" DEFAULT 'pending' NOT NULL,
	"dependencies" text[] DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "features" ADD CONSTRAINT "features_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "task_attempts" ADD CONSTRAINT "task_attempts_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tasks" ADD CONSTRAINT "tasks_feature_id_features_id_fk" FOREIGN KEY ("feature_id") REFERENCES "public"."features"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
