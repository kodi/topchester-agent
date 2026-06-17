interface PoolLike {
  query: (sql: string) => Promise<unknown>;
}

export async function initializeSchema(pool: PoolLike): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS customers (
      id bigint PRIMARY KEY,
      email text NOT NULL,
      region text NOT NULL,
      status text NOT NULL
    );

    CREATE TABLE IF NOT EXISTS orders (
      id bigint PRIMARY KEY,
      customer_id bigint NOT NULL REFERENCES customers(id),
      placed_at timestamptz NOT NULL,
      status text NOT NULL,
      currency text NOT NULL
    );

    CREATE TABLE IF NOT EXISTS order_items (
      order_id bigint NOT NULL REFERENCES orders(id),
      sku text NOT NULL,
      quantity integer NOT NULL,
      unit_price_cents integer NOT NULL
    );

    CREATE TABLE IF NOT EXISTS refunds (
      id bigint PRIMARY KEY,
      order_id bigint NOT NULL REFERENCES orders(id),
      refunded_at timestamptz NOT NULL,
      amount_cents integer NOT NULL
    );
  `);
}

export async function getDailyRevenueReport(_pool: PoolLike): Promise<unknown[]> {
  return [];
}

export async function getCustomerLifetimeValue(_pool: PoolLike, _minNetCents = 0): Promise<unknown[]> {
  return [];
}
