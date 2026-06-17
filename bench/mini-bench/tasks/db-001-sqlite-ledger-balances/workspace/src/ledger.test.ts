import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createAccount, getAccountBalance, initializeLedger, listAccountBalances, postTransaction } from "./ledger.ts";

const db = new DatabaseSync(":memory:");
initializeLedger(db);

createAccount(db, { id: "cash", name: "Cash", normalBalance: "debit" });
createAccount(db, { id: "revenue", name: "Revenue", normalBalance: "credit" });
createAccount(db, { id: "fees", name: "Fees", normalBalance: "debit" });

assert.deepEqual(
  postTransaction(db, {
    id: "txn-001",
    description: "invoice paid",
    postedAt: "2026-06-17T12:00:00Z",
    entries: [
      { accountId: "cash", side: "debit", amountCents: 12500 },
      { accountId: "revenue", side: "credit", amountCents: 12500 },
    ],
  }),
  {
    id: "txn-001",
    debitTotalCents: 12500,
    creditTotalCents: 12500,
    entryCount: 2,
  }
);

postTransaction(db, {
  id: "txn-002",
  entries: [
    { accountId: "fees", side: "debit", amountCents: 300 },
    { accountId: "cash", side: "credit", amountCents: 300 },
  ],
});

assert.equal(getAccountBalance(db, "cash"), 12200);
assert.equal(getAccountBalance(db, "revenue"), 12500);
assert.equal(getAccountBalance(db, "fees"), 300);

assert.deepEqual(listAccountBalances(db), [
  { accountId: "cash", name: "Cash", normalBalance: "debit", balanceCents: 12200 },
  { accountId: "fees", name: "Fees", normalBalance: "debit", balanceCents: 300 },
  { accountId: "revenue", name: "Revenue", normalBalance: "credit", balanceCents: 12500 },
]);

assert.throws(() =>
  postTransaction(db, {
    id: "bad-unbalanced",
    entries: [
      { accountId: "cash", side: "debit", amountCents: 100 },
      { accountId: "revenue", side: "credit", amountCents: 99 },
    ],
  })
);

assert.equal(getAccountBalance(db, "cash"), 12200);

console.log("ledger tests passed");
