const MIN_FILE_REMINDER_LIVE_WINDOW_MS = 60 * 1000;
const MAX_FILE_REMINDER_LIVE_WINDOW_MS = 5 * 60 * 1000;

export function getFileReminderLiveWindowMs(pollMinutes: number): number {
    const pollMs = Math.max(30 * 1000, Number(pollMinutes) * 60 * 1000 || 0);
    return Math.min(
        MAX_FILE_REMINDER_LIVE_WINDOW_MS,
        Math.max(MIN_FILE_REMINDER_LIVE_WINDOW_MS, pollMs * 2),
    );
}

export function shouldSkipStaleOneShotReminder(
    now: number,
    triggerTime: number,
    repeatUntilComplete: boolean,
    liveWindowMs: number,
): boolean {
    return !repeatUntilComplete && now - triggerTime > Math.max(0, liveWindowMs);
}
