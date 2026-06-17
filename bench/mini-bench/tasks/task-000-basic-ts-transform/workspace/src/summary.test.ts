import assert from "node:assert/strict";
import { summarizeUsers, type User } from "./summary.ts";

const users: User[] = [
  { name: " Ada ", email: "ada@Example.COM", role: "admin", active: true },
  { name: "Grace", email: "grace@tools.dev", role: "member", active: true },
  { name: "Inactive", email: "inactive@example.com", role: "guest", active: false },
  { name: "   ", email: "blank@example.com", role: "guest", active: true },
];

assert.deepEqual(summarizeUsers(users), {
  totalActive: 2,
  names: ["Ada", "Grace"],
  domains: ["example.com", "tools.dev"],
  countByRole: {
    admin: 1,
    member: 1,
    guest: 0,
  },
});

console.log("summary tests passed");
