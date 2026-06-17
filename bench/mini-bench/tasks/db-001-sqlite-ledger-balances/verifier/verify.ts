import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import type { AssertionResult, TaskVerifier } from "../../../src/types.ts";

interface LedgerModule {
  initializeLedger?: (db: DatabaseSync) => void;
  createAccount?: (db: DatabaseSync, account: unknown) => void;
  postTransaction?: (db: DatabaseSync, transaction: unknown) => unknown;
  getAccountBalance?: (db: DatabaseSync, accountId: string) => unknown;
  listAccountBalances?: (db: DatabaseSync) => unknown;
}

const verify: TaskVerifier = async (context) => {
  const modulePath = resolve(context.workspacePath, "src", "ledger.ts");
  const { DatabaseSync } = await importSqlite();
  const imported = (await import(`${pathToFileURL(modulePath).href}?cacheBust=${Date.now()}`)) as LedgerModule;
  const assertions: AssertionResult[] = [];

  assertions.push({
    name: "exports ledger functions",
    passed:
      typeof imported.initializeLedger === "function" &&
      typeof imported.createAccount === "function" &&
      typeof imported.postTransaction === "function" &&
      typeof imported.getAccountBalance === "function" &&
      typeof imported.listAccountBalances === "function",
    message:
      "initializeLedger, createAccount, postTransaction, getAccountBalance, and listAccountBalances must be exported.",
  });

  if (!assertions[0]?.passed) {
    return { passed: false, score: 0, assertions };
  }

  runCase(assertions, "posts balanced transactions and returns normal-direction balances", () => {
    const db = setupLedger(DatabaseSync, imported);

    assert.deepEqual(
      imported.postTransaction?.(db, {
        id: "sale-1",
        description: "sale",
        entries: [
          { accountId: "cash", side: "debit", amountCents: 20000 },
          { accountId: "revenue", side: "credit", amountCents: 18000 },
          { accountId: "tax_payable", side: "credit", amountCents: 2000 },
        ],
      }),
      {
        id: "sale-1",
        debitTotalCents: 20000,
        creditTotalCents: 20000,
        entryCount: 3,
      }
    );

    imported.postTransaction?.(db, {
      id: "refund-1",
      entries: [
        { accountId: "revenue", side: "debit", amountCents: 2500 },
        { accountId: "tax_payable", side: "debit", amountCents: 300 },
        { accountId: "cash", side: "credit", amountCents: 2800 },
      ],
    });

    assert.equal(imported.getAccountBalance?.(db, "cash"), 17200);
    assert.equal(imported.getAccountBalance?.(db, "revenue"), 15500);
    assert.equal(imported.getAccountBalance?.(db, "tax_payable"), 1700);
    assert.deepEqual(imported.listAccountBalances?.(db), [
      { accountId: "cash", name: "Cash", normalBalance: "debit", balanceCents: 17200 },
      { accountId: "expense", name: "Expense", normalBalance: "debit", balanceCents: 0 },
      { accountId: "revenue", name: "Revenue", normalBalance: "credit", balanceCents: 15500 },
      { accountId: "tax_payable", name: "Tax Payable", normalBalance: "credit", balanceCents: 1700 },
    ]);
  });

  runCase(assertions, "rejects invalid transactions without partial writes", () => {
    const db = setupLedger(DatabaseSync, imported);

    assert.throws(() =>
      imported.postTransaction?.(db, {
        id: "bad-unknown-account",
        entries: [
          { accountId: "cash", side: "debit", amountCents: 1000 },
          { accountId: "missing", side: "credit", amountCents: 1000 },
        ],
      })
    );

    assert.throws(() =>
      imported.postTransaction?.(db, {
        id: "bad-single-entry",
        entries: [{ accountId: "cash", side: "debit", amountCents: 1000 }],
      })
    );

    assert.throws(() =>
      imported.postTransaction?.(db, {
        id: "bad-unbalanced",
        entries: [
          { accountId: "cash", side: "debit", amountCents: 1000 },
          { accountId: "revenue", side: "credit", amountCents: 999 },
        ],
      })
    );

    assert.equal(imported.getAccountBalance?.(db, "cash"), 0);
    assert.equal(imported.getAccountBalance?.(db, "revenue"), 0);
    assert.equal(imported.getAccountBalance?.(db, "tax_payable"), 0);
    assert.deepEqual(imported.listAccountBalances?.(db), [
      { accountId: "cash", name: "Cash", normalBalance: "debit", balanceCents: 0 },
      { accountId: "expense", name: "Expense", normalBalance: "debit", balanceCents: 0 },
      { accountId: "revenue", name: "Revenue", normalBalance: "credit", balanceCents: 0 },
      { accountId: "tax_payable", name: "Tax Payable", normalBalance: "credit", balanceCents: 0 },
    ]);

    assert.deepEqual(
      imported.postTransaction?.(db, {
        id: "bad-unknown-account",
        entries: [
          { accountId: "cash", side: "debit", amountCents: 1000 },
          { accountId: "revenue", side: "credit", amountCents: 1000 },
        ],
      }),
      {
        id: "bad-unknown-account",
        debitTotalCents: 1000,
        creditTotalCents: 1000,
        entryCount: 2,
      }
    );
  });

  runCase(assertions, "enforces duplicate transaction ids and entry validation", () => {
    const db = setupLedger(DatabaseSync, imported);

    imported.postTransaction?.(db, {
      id: "unique-id",
      entries: [
        { accountId: "cash", side: "debit", amountCents: 500 },
        { accountId: "revenue", side: "credit", amountCents: 500 },
      ],
    });

    assert.throws(() =>
      imported.postTransaction?.(db, {
        id: "unique-id",
        entries: [
          { accountId: "cash", side: "debit", amountCents: 500 },
          { accountId: "revenue", side: "credit", amountCents: 500 },
        ],
      })
    );

    assert.throws(() =>
      imported.postTransaction?.(db, {
        id: "bad-amount",
        entries: [
          { accountId: "cash", side: "debit", amountCents: 10.5 },
          { accountId: "revenue", side: "credit", amountCents: 10.5 },
        ],
      })
    );

    assert.throws(() =>
      imported.postTransaction?.(db, {
        id: "bad-side",
        entries: [
          { accountId: "cash", side: "left", amountCents: 500 },
          { accountId: "revenue", side: "credit", amountCents: 500 },
        ],
      })
    );

    assert.equal(imported.getAccountBalance?.(db, "cash"), 500);
    assert.equal(imported.getAccountBalance?.(db, "revenue"), 500);
    assert.throws(() => imported.getAccountBalance?.(db, "missing"));
  });

  const passed = assertions.every((assertion) => assertion.passed);
  return {
    passed,
    score: passed ? 1 : 0,
    assertions,
  };
};

function setupLedger(Database: typeof DatabaseSync, imported: LedgerModule): DatabaseSync {
  const db = new Database(":memory:");
  imported.initializeLedger?.(db);
  imported.createAccount?.(db, { id: "cash", name: "Cash", normalBalance: "debit" });
  imported.createAccount?.(db, { id: "revenue", name: "Revenue", normalBalance: "credit" });
  imported.createAccount?.(db, { id: "tax_payable", name: "Tax Payable", normalBalance: "credit" });
  imported.createAccount?.(db, { id: "expense", name: "Expense", normalBalance: "debit" });
  return db;
}

async function importSqlite(): Promise<typeof import("node:sqlite")> {
  const emitWarning = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...args: unknown[]) => {
    const message = warning instanceof Error ? warning.message : warning;
    if (typeof message === "string" && message.includes("SQLite is an experimental feature")) {
      return;
    }
    return Reflect.apply(emitWarning, process, [warning, ...args]);
  }) as typeof process.emitWarning;

  try {
    return await import("node:sqlite");
  } finally {
    process.emitWarning = emitWarning;
  }
}

function runCase(assertions: AssertionResult[], name: string, fn: () => void): void {
  try {
    fn();
    assertions.push({
      name,
      passed: true,
      message: "Behavior matched hidden case.",
    });
  } catch (error) {
    assertions.push({
      name,
      passed: false,
      message: `Behavior did not match the hidden case. ${formatError(error)}`,
    });
  }
}

function formatError(error: unknown): string {
  if (!(error instanceof Error) || !error.message) {
    return "";
  }

  const compact = error.message
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .slice(0, 14)
    .join("\n");
  return compact.length <= 1_200 ? compact : `${compact.slice(0, 1_200)}...`;
}

export default verify;
