import type { DatabaseSync } from "node:sqlite";

export type EntrySide = "debit" | "credit";
export type NormalBalance = "debit" | "credit";

export interface AccountInput {
  id: string;
  name: string;
  normalBalance: NormalBalance;
}

export interface LedgerEntryInput {
  accountId: string;
  side: EntrySide;
  amountCents: number;
}

export interface TransactionInput {
  id: string;
  entries: LedgerEntryInput[];
}

export interface PostedTransaction {
  id: string;
  debitTotalCents: number;
  creditTotalCents: number;
  entryCount: number;
}

export interface AccountBalance {
  accountId: string;
  name: string;
  normalBalance: NormalBalance;
  balanceCents: number;
}

export function initializeLedger(_db: DatabaseSync): void {}

export function createAccount(_db: DatabaseSync, _account: AccountInput): void {}

export function postTransaction(_db: DatabaseSync, transaction: TransactionInput): PostedTransaction {
  return {
    id: transaction.id,
    debitTotalCents: 0,
    creditTotalCents: 0,
    entryCount: transaction.entries.length,
  };
}

export function getAccountBalance(_db: DatabaseSync, _accountId: string): number {
  return 0;
}

export function listAccountBalances(_db: DatabaseSync): AccountBalance[] {
  return [];
}
