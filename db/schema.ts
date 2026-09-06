import { integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const expenses = sqliteTable('expenses', {
  id: text('id').primaryKey(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  payer: text('payer').notNull(),
  merchant: text('merchant').notNull(),
  amount: real('amount').notNull(),
  category: text('category').notNull().default('Other'),
  imageKey: text('image_key'),
  settled: integer('settled', { mode: 'boolean' }).notNull().default(false),
});
