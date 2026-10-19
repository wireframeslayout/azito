/** An operation that ran past the time it was given. */
export class DeadlineExceededError extends Error {
  constructor(what: string) {
    super(`${what} ran past its deadline`);
    this.name = 'DeadlineExceededError';
  }
}

/**
 * `promise`, unless `deadlineAtMs` (an epoch time on this machine) comes first: then a `DeadlineExceededError`. The operation
 * itself is not cancelled (the host stops it by its own time budget); only the wait for it ends.
 */
export function raceDeadline<T>(promise: Promise<T>, deadlineAtMs: number, what: string): Promise<T> {
  const remaining = deadlineAtMs - Date.now();
  if (remaining <= 0) {
    promise.catch(() => undefined);
    return Promise.reject(new DeadlineExceededError(what));
  }
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      promise.catch(() => undefined);
      reject(new DeadlineExceededError(what));
    }, remaining);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err: unknown) => { clearTimeout(timer); reject(err); },
    );
  });
}
