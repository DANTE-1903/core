import { err, ok, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";

export interface RateLimiterOptions {
  maxRetries?: number;
  initialBackoffMs?: number;
  /**
   * Maximum number of requests waiting to start. Requests beyond this limit
   * fail with `RATE_LIMITED`; active operations are not counted. Omitted means
   * the queue remains unbounded for backwards compatibility.
   */
  maxQueueSize?: number;
}

export interface RateLimiter {
  execute<T>(operation: () => Promise<T>): Promise<SorokitResult<T>>;
  readonly pending: number;
}

const inFlightRequests = new Map<string, Promise<SorokitResult<unknown>>>();

export function deduplicateRequest<T>(
  key: string,
  operation: () => Promise<T>,
): Promise<SorokitResult<T>> {
  const existing = inFlightRequests.get(key);
  if (existing) return existing as Promise<SorokitResult<T>>;

  const pending = Promise.resolve()
    .then(operation)
    .then(ok)
    .catch((cause: unknown) =>
      err<T>(
        SorokitErrorCode.NETWORK_ERROR,
        cause instanceof Error ? cause.message : "Request failed",
        cause,
      ),
    )
    .finally(() => inFlightRequests.delete(key));
  inFlightRequests.set(key, pending);
  return pending;
}

export function createRateLimiter(
  limit: number,
  windowMs: number,
  options: RateLimiterOptions = {},
): RateLimiter {
  if (!Number.isInteger(limit) || limit <= 0 || !Number.isFinite(windowMs) || windowMs <= 0) {
    throw new RangeError("limit and windowMs must be positive numbers");
  }
  if (options.maxQueueSize !== undefined &&
    (!Number.isInteger(options.maxQueueSize) || options.maxQueueSize < 0)) {
    throw new RangeError("maxQueueSize must be a non-negative integer");
  }

  const queue: Array<() => void> = [];
  const starts: number[] = [];
  const maxRetries = options.maxRetries ?? 2;
  const initialBackoffMs = options.initialBackoffMs ?? 100;
  const maxQueueSize = options.maxQueueSize;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const drain = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    const now = Date.now();
    while (starts.length > 0 && now - starts[0]! >= windowMs) starts.shift();
    while (queue.length > 0 && starts.length < limit) {
      starts.push(Date.now());
      queue.shift()!();
    }
    if (queue.length > 0 && starts.length > 0) {
      timer = setTimeout(drain, Math.max(1, windowMs - (Date.now() - starts[0]!)));
    }
  };

  const acquire = (): Promise<void> => {
    drain();
    if (
      maxQueueSize !== undefined &&
      queue.length >= maxQueueSize &&
      starts.length >= limit
    ) {
      return Promise.reject(new Error("Rate limiter queue is full."));
    }
    return new Promise((resolve) => {
      queue.push(resolve);
      drain();
    });
  };

  return {
    get pending() { return queue.length; },
    async execute<T>(operation: () => Promise<T>): Promise<SorokitResult<T>> {
      try {
        await acquire();
      } catch (cause) {
        return err(
          SorokitErrorCode.RATE_LIMITED,
          "Rate limiter queue is full.",
          cause,
        );
      }
      let lastCause: unknown;
      for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
        try {
          return ok(await operation());
        } catch (cause) {
          lastCause = cause;
          if (attempt < maxRetries) {
            await new Promise((resolve) => setTimeout(resolve, initialBackoffMs * 2 ** attempt));
          }
        }
      }
      return err(
        SorokitErrorCode.NETWORK_ERROR,
        lastCause instanceof Error ? lastCause.message : "Rate-limited request failed",
        lastCause,
      );
    },
  };
}
