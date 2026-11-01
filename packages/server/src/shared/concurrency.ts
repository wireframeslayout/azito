/** Run `tasks` with at most `limit` in flight. Order of completion is irrelevant to callers. */
export async function runWithConcurrency(tasks: Array<() => Promise<void>>, limit: number): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    while (next < tasks.length) {
      await tasks[next++]();
    }
  });
  await Promise.all(workers);
}

