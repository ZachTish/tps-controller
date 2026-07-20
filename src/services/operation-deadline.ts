export class OperationDeadlineError extends Error {
    constructor(readonly timeoutMs: number) {
        super(`Operation did not settle within ${timeoutMs}ms.`);
        this.name = "OperationDeadlineError";
    }
}

/**
 * Bounds how long a caller waits. The underlying operation is not cancelled,
 * so callers must not retry an externally mutating operation unless its own
 * result contract proves that no attempt occurred.
 */
export async function withOperationDeadline<T>(
    operation: PromiseLike<T>,
    timeoutMs: number,
): Promise<T> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
        throw new Error("A positive integer operation deadline is required.");
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new OperationDeadlineError(timeoutMs)), timeoutMs);
    });
    try {
        return await Promise.race([Promise.resolve(operation), timeout]);
    } finally {
        if (timer !== undefined) clearTimeout(timer);
    }
}
