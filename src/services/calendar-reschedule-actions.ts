import type { ExternalCalendarConfig, CalendarRescheduleAction } from '../types';
import { parseRuleValue, validRuleKey } from './note-rules';

const owned = new Set(['tpscalendarsync', 'tags', 'kind', 'type', 'title', 'scheduled', 'start', 'end', 'allday', 'timeestimate', 'durationminutes', 'rrule', 'recurrencerule', 'recurrence', 'repeat', 'description', 'location', 'organizer', 'attendees', 'url', 'associatednote']);

/** Validate before network or mutation; a saved invalid action must never be silently dropped. */
export function calendarRescheduleUpdates(
    actions: CalendarRescheduleAction[] | undefined,
    target: CalendarRescheduleAction['target'],
    protectedKeys: string[] = [],
): Record<string, unknown> {
    if (actions === undefined) return {};
    if (!Array.isArray(actions) || actions.length > 30) throw new Error('Reschedule actions must contain at most 30 property updates.');
    const reserved = new Set([...owned, ...protectedKeys.map(key => key.toLowerCase())]);
    const updates: Record<string, unknown> = Object.create(null);
    const seen = new Set<string>();
    for (const action of actions) {
        if (!action || !['previous', 'current'].includes(action.target) || typeof action.key !== 'string'
            || !validRuleKey(action.key.trim()) || reserved.has(action.key.trim().toLowerCase())
            || typeof action.value !== 'string' || action.value.length > 4000) {
            throw new Error('Invalid reschedule property update. Use a custom property or status; calendar-owned and identity fields are protected.');
        }
        const key = action.key.trim();
        const identity = `${action.target}:${key.toLowerCase()}`;
        if (seen.has(identity)) throw new Error('A reschedule action targets the same property twice.');
        seen.add(identity);
        const value = parseRuleValue(action.value);
        if (action.target === target) updates[key] = value;
    }
    return updates;
}

export function cloneCalendarRescheduleActions(calendar: ExternalCalendarConfig): CalendarRescheduleAction[] | undefined {
    if (calendar.rescheduleActions === undefined) return undefined;
    calendarRescheduleUpdates(calendar.rescheduleActions, 'current');
    return calendar.rescheduleActions.map(action => ({ ...action }));
}
