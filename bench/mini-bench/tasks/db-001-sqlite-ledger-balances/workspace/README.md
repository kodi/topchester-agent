# SQLite Ledger Balances

Implement a small double-entry ledger in `src/ledger.ts` using Node's built-in `node:sqlite` module.

The public API is already declared in `src/ledger.ts`.

Functions:

- `initializeLedger(db)`: create all required tables if they do not exist.
- `createAccount(db, account)`: create one account.
- `postTransaction(db, transaction)`: validate and atomically insert a balanced transaction and its entries.
- `getAccountBalance(db, accountId)`: return the account balance in the account's normal direction.
- `listAccountBalances(db)`: return all account balances sorted by account id.

Rules:

- Account ids are strings.
- Account `normalBalance` is either `debit` or `credit`.
- Transaction ids are strings and must be unique.
- Each transaction must have at least two entries.
- Entry `side` is either `debit` or `credit`.
- Entry `amountCents` must be a positive integer.
- Every entry account must already exist.
- Total debit cents must equal total credit cents.
- Invalid transactions must throw an `Error`.
- Invalid transactions must not leave partial rows behind.
- `postTransaction` should use a SQLite transaction.
- `getAccountBalance` returns:
  - `debits - credits` for debit-normal accounts,
  - `credits - debits` for credit-normal accounts.
- Unknown account balances should throw an `Error`.

Run:

```sh
pnpm test
```
