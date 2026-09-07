import type { Transfer } from '@/lib/settlements';

export type Household = {
  id: string;
  name: string;
  join_code: string;
  created_by?: string;
};
export type Member = {
  id: string;
  household_id: string;
  user_id: string;
  name: string;
  color: string;
  role: 'admin' | 'user';
};
export type Expense = {
  id: string;
  householdId: string;
  payerId: string;
  payerName: string;
  merchant: string;
  amount: number;
  category: string;
  receiptDate: string;
  createdAt: string;
  image?: string;
  imagePath?: string;
  settled: boolean;
  ocrStatus: string;
  ocrModel?: string;
  notes?: string;
  syncStatus?: 'pending' | 'failed';
  syncError?: string;
};
export type Cycle = {
  id: string;
  settled_at: string;
  total_amount: number;
  member_count: number;
  transfers: Transfer[];
  period_start?: string | null;
  period_end?: string | null;
};
export type Activity = {
  id: number;
  actor_name: string | null;
  summary: string;
  action: string;
  created_at: string;
};
export type HouseholdCategory = { id: string; name: string };
export type ReceiptFlag = {
  id: string;
  expense_id: string;
  reported_by: string;
  reason: string | null;
  status: 'open' | 'resolved';
  created_at: string;
};
export type Draft = {
  merchant: string;
  amount: string;
  category: string;
  receiptDate: string;
  payerId: string;
  image: string;
  imagePath: string;
  scanJobId: string;
  file: File | null;
  notes: string;
  ocrStatus: string;
  ocrProcessedAt: string | null;
  duplicate: boolean;
  duplicateExpenseId: string;
  lowConfidence: boolean;
};
export type ToastState = {
  message: string;
  action?: { label: string; run: () => void };
};
export type AppTab =
  | 'home'
  | 'receipts'
  | 'insights'
  | 'household'
  | 'settings';

export const defaultCategories = [
  'Groceries',
  'Utilities',
  'Household',
  'Dining',
  'Other',
];
export const money = new Intl.NumberFormat('en-AU', {
  style: 'currency',
  currency: 'AUD',
});
export const blankDraft = (): Draft => ({
  merchant: '',
  amount: '',
  category: 'Groceries',
  receiptDate: '',
  payerId: '',
  image: '',
  imagePath: '',
  scanJobId: '',
  file: null,
  notes: '',
  ocrStatus: 'not_requested',
  ocrProcessedAt: null,
  duplicate: false,
  duplicateExpenseId: '',
  lowConfidence: false,
});

export function localDate() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}
