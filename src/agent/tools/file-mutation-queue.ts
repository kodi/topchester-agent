const mutationQueues = new Map<string, Promise<unknown>>();

export async function enqueueFileMutation<T>(path: string, mutate: () => Promise<T>): Promise<T> {
  const previousMutation = mutationQueues.get(path) ?? Promise.resolve();
  const mutation = previousMutation.catch(() => undefined).then(mutate);
  const queueTail = mutation
    .catch(() => undefined)
    .finally(() => {
      if (mutationQueues.get(path) === queueTail) {
        mutationQueues.delete(path);
      }
    });

  mutationQueues.set(path, queueTail);
  return mutation;
}
