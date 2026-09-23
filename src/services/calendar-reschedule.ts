import type { ExternalCalendarEvent } from '../types';
import { parseCalendarRecordId } from './calendar-record-identity';

/** Written with the imported event, so local schedule edits cannot masquerade as feed changes. */
export const CALENDAR_SYNC_PROPERTY = 'tpsCalendarSync';
export interface CalendarSyncStamp {
    occurrenceId: string;
    schedule: string;
    retired?: true;
    revision?: [number, number, number];
    revisionOrigin?: string;
}
export function readCalendarSyncStamp(frontmatter: Record<string, unknown>): CalendarSyncStamp | null {
    const keys = Object.keys(frontmatter).filter(key => key.toLowerCase() === CALENDAR_SYNC_PROPERTY.toLowerCase());
    if (!keys.length) return null;
    if (keys.length > 1) throw new Error('Ambiguous calendar schedule tracking property.');
    const value = frontmatter[keys[0]] as Partial<CalendarSyncStamp>;
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || typeof value.occurrenceId !== 'string' || !parseCalendarRecordId(value.occurrenceId)
        || typeof value.schedule !== 'string' || !value.schedule
        || (value.revisionOrigin !== undefined && typeof value.revisionOrigin !== 'string')
        || (value.retired !== undefined && value.retired !== true)
        || (value.revision !== undefined && (!Array.isArray(value.revision) || value.revision.length !== 3
            || value.revision.some(part => !Number.isFinite(part))))) {
        throw new Error('Invalid calendar schedule tracking property. Restore it before syncing this event.');
    }
    return value as CalendarSyncStamp;
}
export function calendarScheduleSignature(event: ExternalCalendarEvent): string {
    if (!Number.isFinite(event.startDate.getTime()) || !Number.isFinite(event.endDate.getTime())) throw new Error('Cannot track an invalid calendar schedule.');
    const format = event.isAllDay ? localDay : (date: Date) => date.toISOString();
    return `${event.isAllDay ? 'day' : 'time'}|${format(event.startDate)}|${format(event.endDate)}`;
}
function localDay(date: Date): string {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
