ALTER TABLE "widgets" ADD COLUMN "sku" text;--> statement-breakpoint
ALTER TABLE "widgets" ADD CONSTRAINT "widgets_sku_unique" UNIQUE("sku");