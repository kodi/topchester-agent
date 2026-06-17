import type { AssertionResult, TaskVerifier } from "../types.ts";

export interface UserSummaryForTask000 {
  totalActive: number;
  names: string[];
  domains: string[];
  countByRole: {
    admin: number;
    member: number;
    guest: number;
  };
}

export type { AssertionResult, TaskVerifier };
