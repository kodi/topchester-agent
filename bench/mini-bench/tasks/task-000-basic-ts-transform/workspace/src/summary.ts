export type UserRole = "admin" | "member" | "guest";

export interface User {
  name: string;
  email: string;
  role: UserRole;
  active: boolean;
}

export interface UserSummary {
  totalActive: number;
  names: string[];
  domains: string[];
  countByRole: Record<UserRole, number>;
}

export function summarizeUsers(_users: User[]): UserSummary {
  return {
    totalActive: 0,
    names: [],
    domains: [],
    countByRole: {
      admin: 0,
      member: 0,
      guest: 0,
    },
  };
}
