-- Needs the index that online/0000_anchored_code_key.sql builds after 0000: it must run first.
ALTER TABLE "anchored"."anchored" ADD CONSTRAINT "anchored_code_key" UNIQUE USING INDEX "anchored_code_key";
