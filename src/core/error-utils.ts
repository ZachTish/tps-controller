import { isRecord } from './type-guards';

/**
 * Extract a human-readable error message from any caught value.
 * Safe to call with `unknown` directly from a catch block.
 */
export function getErrorMessage(error: unknown, fallback = 'Unknown error'): string {
    if (error instanceof Error && typeof error.message === 'string' && error.message.trim()) {
        return error.message.trim();
    }
    if (typeof error === 'string' && error.trim()) {
        return error.trim();
    }
    if (isRecord(error) && typeof error.message === 'string' && (error.message as string).trim()) {
        return (error.message as string).trim();
    }
    if (typeof error === 'number' || typeof error === 'boolean' || typeof error === 'bigint') {
        return String(error);
    }
    if (isRecord(error)) {
        try { return JSON.stringify(error); } catch { return fallback; }
    }
    return fallback;
}
