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
  description?: string;
  postedAt?: string;
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

export function initializeLedger(db: DatabaseSync): void {
  db.exec(`
    create table if not exists accounts (
      id text primary key,
      name text not null,
      normal_balance text not null check (normal_balance in ('debit', 'credit'))
    );
    create table if not exists transactions (
      id text primary key,
      description text,
      posted_at text not null
    );
    create table if not exists entries (
      id integer primary key autoincrement,
      transaction_id text not null references transactions(id),
      account_id text not null references accounts(id),
      side text not null check (side in ('debit', 'credit')),
      amount_cents integer not null check (amount_cents > 0)
    );
  `);
}

export function createAccount(db: DatabaseSync, account: AccountInput): void {
  if (!account.id || !account.name || !["debit", "credit"].includes(account.normalBalance)) {
    throw new Error("Invalid account");
  }

  db.prepare("insert into accounts (id, name, normal_balance) values (?, ?, ?)").run(
    account.id,
    account.name,
    account.normalBalance
  );
}

export function postTransaction(db: DatabaseSync, transaction: TransactionInput): PostedTransaction {
  validateTransactionShape(transaction);

  const debitTotalCents = totalForSide(transaction.entries, "debit");
  const creditTotalCents = totalForSide(transaction.entries, "credit");
  if (debitTotalCents !== creditTotalCents) {
    throw new Error("Transaction is not balanced");
  }

  db.exec("begin");
  try {
    db.prepare("insert into transactions (id, description, posted_at) values (?, ?, ?)").run(
      transaction.id,
      transaction.description ?? null,
      transaction.postedAt ?? new Date(0).toISOString()
    );

    const insertEntry = db.prepare(
      "insert into entries (transaction_id, account_id, side, amount_cents) values (?, ?, ?, ?)"
    );
    const accountExists = db.prepare("select 1 from accounts where id = ?");

    for (const entry of transaction.entries) {
      if (!accountExists.get(entry.accountId)) {
        throw new Error(`Unknown account ${entry.accountId}`);
      }
      insertEntry.run(transaction.id, entry.accountId, entry.side, entry.amountCents);
    }

    db.exec("commit");
  } catch (error) {
    db.exec("rollback");
    throw error;
  }

  return {
    id: transaction.id,
    debitTotalCents,
    creditTotalCents,
    entryCount: transaction.entries.length,
  };
}

export function getAccountBalance(db: DatabaseSync, accountId: string): number {
  const account = db.prepare("select normal_balance from accounts where id = ?").get(accountId) as
    | { normal_balance: NormalBalance }
    | undefined;
  if (!account) {
    throw new Error(`Unknown account ${accountId}`);
  }

  const totals = db
    .prepare(
      `
      select
        coalesce(sum(case when side = 'debit' then amount_cents else 0 end), 0) as debit,
        coalesce(sum(case when side = 'credit' then amount_cents else 0 end), 0) as credit
      from entries
      where account_id = ?
    `
    )
    .get(accountId) as { debit: number; credit: number };

  return account.normal_balance === "debit" ? totals.debit - totals.credit : totals.credit - totals.debit;
}

export function listAccountBalances(db: DatabaseSync): AccountBalance[] {
  const accounts = db.prepare("select id, name, normal_balance from accounts order by id").all() as Array<{
    id: string;
    name: string;
    normal_balance: NormalBalance;
  }>;

  return accounts.map((account) => ({
    accountId: account.id,
    name: account.name,
    normalBalance: account.normal_balance,
    balanceCents: getAccountBalance(db, account.id),
  }));
}

function validateTransactionShape(transaction: TransactionInput): void {
  if (!transaction.id) {
    throw new Error("Transaction id is required");
  }
  if (!Array.isArray(transaction.entries) || transaction.entries.length < 2) {
    throw new Error("Transaction must have at least two entries");
  }
  for (const entry of transaction.entries) {
    if (entry.side !== "debit" && entry.side !== "credit") {
      throw new Error("Entry side must be debit or credit");
    }
    if (!Number.isInteger(entry.amountCents) || entry.amountCents <= 0) {
      throw new Error("Entry amountCents must be a positive integer");
    }
  }
}

function totalForSide(entries: LedgerEntryInput[], side: EntrySide): number {
  return entries.filter((entry) => entry.side === side).reduce((sum, entry) => sum + entry.amountCents, 0);
}
