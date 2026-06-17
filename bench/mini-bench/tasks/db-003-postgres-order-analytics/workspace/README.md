# Postgres Order Analytics

Implement `src/analytics.ts` using `pg` / node-postgres.

The public API is already declared in `src/analytics.ts`.

Functions:

- `initializeSchema(pool)`: create all required tables if they do not exist.
- `getDailyRevenueReport(pool)`: query completed orders and return daily revenue rows.
- `getCustomerLifetimeValue(pool, minNetCents = 0)`: query completed orders and return customer lifetime value rows.

`initializeSchema` should create these tables:

- `customers(id, email, region, status)`
- `orders(id, customer_id, placed_at, status, currency)`
- `order_items(order_id, sku, quantity, unit_price_cents)`
- `refunds(id, order_id, refunded_at, amount_cents)`

Order statuses `paid`, `shipped`, and `delivered` are completed orders. Other statuses must be ignored by all reporting.

## `getDailyRevenueReport(pool)`

Return rows with fields:

- `day` date: `orders.placed_at::date`
- `region` text
- `orderCount` number: count of completed orders
- `grossCents` number: sum of completed order item revenue
- `refundCents` number: sum of refunds for completed orders
- `netCents` number: gross minus refunds
- `uniqueCustomers` number: count of distinct customers

Rows should be grouped by `day` and `region`, sorted by `day` then `region`.

Be careful not to multiply refunds when an order has multiple line items.

## `getCustomerLifetimeValue(pool, minNetCents = 0)`

Return rows with fields:

- `customerId` number
- `email` text
- `region` text
- `completedOrders` number
- `grossCents` number
- `refundCents` number
- `netCents` number

Return one row per customer with at least one completed order and `netCents >= minNetCents`.

Rows should be sorted by `customer_id`.

Run:

```sh
pnpm test
```
