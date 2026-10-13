CREATE SCHEMA IF NOT EXISTS "gadgets";--> statement-breakpoint
CREATE TABLE "gadgets"."gadgets" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"name" text NOT NULL
);
