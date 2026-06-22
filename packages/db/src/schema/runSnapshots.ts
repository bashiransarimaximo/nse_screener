import { pgTable, serial, text, timestamp, jsonb, integer } from "drizzle-orm/pg-core";

export const runSnapshots = pgTable("run_snapshots", {
  id: serial("id").primaryKey(),
  runDate: text("run_date").notNull().unique(),
  scoredAt: timestamp("scored_at", { withTimezone: true }).defaultNow().notNull(),
  symbolCount: integer("symbol_count").notNull(),
  results: jsonb("results").$type<object[]>().notNull(),
});

export type RunSnapshotRow = typeof runSnapshots.$inferSelect;
