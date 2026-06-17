import type { Pool } from "pg";

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

export async function initializeSchema(_pool: Pool): Promise<void> {
  // Implement me.
}

export async function getDailyRevenueReport(_pool: Pool): Promise<DailyRevenueRow[]> {
  return [];
}

export async function getCustomerLifetimeValue(_pool: Pool, _minNetCents = 0): Promise<CustomerLifetimeValueRow[]> {
  return [];
}
