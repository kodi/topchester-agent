export interface DailyRevenueRow {
  day: string;
  region: string;
  orderCount: number;
  grossCents: number;
  refundCents: number;
  netCents: number;
  uniqueCustomers: number;
}

export interface CustomerLifetimeValueRow {
  customerId: number;
  email: string;
  region: string;
  completedOrders: number;
  grossCents: number;
  refundCents: number;
  netCents: number;
}

interface PoolLike {
  query: (sql: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
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

export async function getDailyRevenueReport(pool: PoolLike): Promise<DailyRevenueRow[]> {
  const result = await pool.query(`
    WITH completed_orders AS (
      SELECT o.id, o.customer_id, o.placed_at::date::text AS day, c.region
      FROM orders o
      JOIN customers c ON c.id = o.customer_id
      WHERE o.status IN ('paid', 'shipped', 'delivered')
    ),
    order_gross AS (
      SELECT order_id, SUM(quantity * unit_price_cents)::bigint AS gross_cents
      FROM order_items
      GROUP BY order_id
    ),
    order_refunds AS (
      SELECT order_id, SUM(amount_cents)::bigint AS refund_cents
      FROM refunds
      GROUP BY order_id
    )
    SELECT
      co.day,
      co.region,
      COUNT(*)::integer AS order_count,
      COALESCE(SUM(og.gross_cents), 0)::integer AS gross_cents,
      COALESCE(SUM(orv.refund_cents), 0)::integer AS refund_cents,
      (COALESCE(SUM(og.gross_cents), 0) - COALESCE(SUM(orv.refund_cents), 0))::integer AS net_cents,
      COUNT(DISTINCT co.customer_id)::integer AS unique_customers
    FROM completed_orders co
    LEFT JOIN order_gross og ON og.order_id = co.id
    LEFT JOIN order_refunds orv ON orv.order_id = co.id
    GROUP BY co.day, co.region
    ORDER BY co.day, co.region
  `);

  return result.rows.map((row) => ({
    day: String(row.day),
    region: String(row.region),
    orderCount: Number(row.order_count),
    grossCents: Number(row.gross_cents),
    refundCents: Number(row.refund_cents),
    netCents: Number(row.net_cents),
    uniqueCustomers: Number(row.unique_customers),
  }));
}

export async function getCustomerLifetimeValue(pool: PoolLike, minNetCents = 0): Promise<CustomerLifetimeValueRow[]> {
  const result = await pool.query(
    `
      WITH completed AS (
        SELECT id, customer_id
        FROM orders
        WHERE status IN ('paid', 'shipped', 'delivered')
      ),
      order_gross AS (
        SELECT order_id, SUM(quantity * unit_price_cents)::bigint AS gross_cents
        FROM order_items
        GROUP BY order_id
      ),
      order_refunds AS (
        SELECT order_id, SUM(amount_cents)::bigint AS refund_cents
        FROM refunds
        GROUP BY order_id
      ),
      customer_totals AS (
        SELECT
          c.customer_id,
          COUNT(*)::integer AS completed_orders,
          COALESCE(SUM(og.gross_cents), 0)::integer AS gross_cents,
          COALESCE(SUM(orv.refund_cents), 0)::integer AS refund_cents
        FROM completed c
        LEFT JOIN order_gross og ON og.order_id = c.id
        LEFT JOIN order_refunds orv ON orv.order_id = c.id
        GROUP BY c.customer_id
      )
      SELECT
        cu.id::integer AS customer_id,
        cu.email,
        cu.region,
        ct.completed_orders,
        ct.gross_cents,
        ct.refund_cents,
        (ct.gross_cents - ct.refund_cents)::integer AS net_cents
      FROM customer_totals ct
      JOIN customers cu ON cu.id = ct.customer_id
      WHERE (ct.gross_cents - ct.refund_cents) >= $1
      ORDER BY cu.id
    `,
    [minNetCents]
  );

  return result.rows.map((row) => ({
    customerId: Number(row.customer_id),
    email: String(row.email),
    region: String(row.region),
    completedOrders: Number(row.completed_orders),
    grossCents: Number(row.gross_cents),
    refundCents: Number(row.refund_cents),
    netCents: Number(row.net_cents),
  }));
}
