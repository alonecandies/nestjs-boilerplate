-- The anchored-steps fixture (review #4): a plain table whose unique constraint is built online.
CREATE SCHEMA IF NOT EXISTS "anchored";--> statement-breakpoint
CREATE TABLE "anchored"."anchored" (
	"id" integer PRIMARY KEY,
	"code" text NOT NULL
);
