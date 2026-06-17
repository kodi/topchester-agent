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

export function summarizeUsers(users: User[]): UserSummary {
  const names = new Set<string>();
  const domains = new Set<string>();
  const countByRole: Record<UserRole, number> = {
    admin: 0,
    member: 0,
    guest: 0,
  };
  let totalActive = 0;

  for (const user of users) {
    if (!user.active) {
      continue;
    }

    const name = user.name.trim();
    if (!name) {
      continue;
    }

    totalActive += 1;
    names.add(name);
    countByRole[user.role] += 1;

    const atIndex = user.email.lastIndexOf("@");
    if (atIndex >= 0 && atIndex < user.email.length - 1) {
      domains.add(user.email.slice(atIndex + 1).toLowerCase());
    }
  }

  return {
    totalActive,
    names: [...names].sort((a, b) => a.localeCompare(b)),
    domains: [...domains].sort((a, b) => a.localeCompare(b)),
    countByRole,
  };
}
