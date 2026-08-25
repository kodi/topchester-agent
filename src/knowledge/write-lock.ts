import { resolve } from "node:path";

const tails = new Map<string, Promise<void>>();

export async function withKnowledgeWriteLock<T>(workspaceRoot: string, work: () => Promise<T>): Promise<T> {
  const key = resolve(workspaceRoot);
  const previous = tails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolveCurrent) => {
    release = resolveCurrent;
  });
  const tail = previous.then(() => current);
  tails.set(key, tail);

  await previous;
  try {
    return await work();
  } finally {
    release();
    if (tails.get(key) === tail) tails.delete(key);
  }
}
