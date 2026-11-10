CREATE SCHEMA IF NOT EXISTS "catalog";--> statement-breakpoint
CREATE TYPE "catalog"."order_status" AS ENUM('open', 'closed');--> statement-breakpoint
CREATE TABLE "catalog"."regions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"name" text NOT NULL
);--> statement-breakpoint
SELECT app.make_reference('catalog.regions');--> statement-breakpoint
CREATE TABLE "catalog"."orders" (
	"tenant_id" uuid NOT NULL,
	"id" uuid DEFAULT uuidv7() NOT NULL,
	"status" "catalog"."order_status" DEFAULT 'open' NOT NULL,
	CONSTRAINT "orders_tenant_id_id_pk" PRIMARY KEY("tenant_id","id")
);--> statement-breakpoint
SELECT app.distribute_by_tenant('catalog.orders');--> statement-breakpoint
CREATE TABLE "catalog"."order_lines" (
	"tenant_id" uuid NOT NULL,
	"id" uuid DEFAULT uuidv7() NOT NULL,
	"order_id" uuid NOT NULL,
	"region_id" uuid NOT NULL,
	CONSTRAINT "order_lines_tenant_id_id_pk" PRIMARY KEY("tenant_id","id")
);--> statement-breakpoint
SELECT app.distribute_by_tenant('catalog.order_lines');--> statement-breakpoint
CREATE INDEX "order_lines_tenant_id_order_id_idx" ON "catalog"."order_lines" USING btree ("tenant_id","order_id");--> statement-breakpoint
ALTER TABLE "catalog"."order_lines" ADD CONSTRAINT "order_lines_order_fk" FOREIGN KEY ("tenant_id","order_id") REFERENCES "catalog"."orders"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog"."order_lines" ADD CONSTRAINT "order_lines_region_id_regions_id_fk" FOREIGN KEY ("region_id") REFERENCES "catalog"."regions"("id") ON DELETE no action ON UPDATE no action;
