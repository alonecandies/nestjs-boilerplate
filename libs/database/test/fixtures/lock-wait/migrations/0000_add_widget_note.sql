-- Takes ACCESS EXCLUSIVE on widgets (unqualified, like the widgets fixture that created it):
-- blocked by any open transaction that read the table.
ALTER TABLE "widgets" ADD COLUMN "note" text;
