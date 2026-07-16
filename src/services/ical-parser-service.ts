
import ICAL from 'ical.js';
import { moment } from 'obsidian';
import * as logger from "../logger";
import { ExternalCalendarEvent } from "../types";
import { isCancelledCalendarTitle } from "./external-calendar-cancellation";

interface ICalParseStats {
    vevents: number;
    parsedComponents: number;
    recurrenceExceptions: number;
    recurringMasters: number;
    cancelledSkipped: number;
    outOfRangeSkipped: number;
    preparseErrors: number;
    eventErrors: number;
    pushedEvents: number;
}

export class ICalParserService {
    public static warnedZones: Set<string> = new Set();

    // Mapping for common Windows/Outlook timezone names to IANA identifiers
    private static readonly WINDOWS_TZ_MAPPING: Record<string, string> = {
        'Central Standard Time': 'America/Chicago',
        'Eastern Standard Time': 'America/New_York',
        'Pacific Standard Time': 'America/Los_Angeles',
        'Mountain Standard Time': 'America/Denver',
        'India Standard Time': 'Asia/Kolkata',
        'China Standard Time': 'Asia/Shanghai',
        'Tokyo Standard Time': 'Asia/Tokyo',
        'GMT Standard Time': 'Europe/London',
        'Romance Standard Time': 'Europe/Paris',
        'W. Europe Standard Time': 'Europe/Berlin',
    };

    public parseICalData(
        icalData: string,
        rangeStart?: Date,
        rangeEnd?: Date,
        includeCancelled: boolean = false
    ): ExternalCalendarEvent[] {
        const events: ExternalCalendarEvent[] = [];
        const stats: ICalParseStats = {
            vevents: 0,
            parsedComponents: 0,
            recurrenceExceptions: 0,
            recurringMasters: 0,
            cancelledSkipped: 0,
            outOfRangeSkipped: 0,
            preparseErrors: 0,
            eventErrors: 0,
            pushedEvents: 0,
        };
        const context = {
            rangeStart: rangeStart?.toISOString() || "",
            rangeEnd: rangeEnd?.toISOString() || "",
            includeCancelled,
        };
        try {
            if (!icalData || typeof icalData !== 'string') {
                logger.flowWarn("ICalParser", "parse:invalid-input", {
                    ...context,
                    type: typeof icalData,
                });
                return [];
            }

            const trimmed = icalData.trim();
            if (!trimmed.toUpperCase().includes('BEGIN:VCALENDAR')) {
                logger.flowWarn("ICalParser", "parse:not-calendar", {
                    ...context,
                    bytes: icalData.length,
                });
                return [];
            }

            const jcalData = ICAL.parse(icalData);
            const comp = new ICAL.Component(jcalData);
            const vevents = comp.getAllSubcomponents('vevent');
            stats.vevents = vevents.length;
            logger.flow("ICalParser", "parse:start", {
                ...context,
                bytes: icalData.length,
                vevents: stats.vevents,
            });


            const exceptions = new Map<string, ICAL.Time[]>();
            const parsedEvents: { event: ICAL.Event; vevent: ICAL.Component }[] = [];

            // Pass 1: Gather recurrence exceptions and count UIDs
            for (const vevent of vevents) {
                try {
                    const event = new ICAL.Event(vevent);
                    parsedEvents.push({ event, vevent });
                    stats.parsedComponents++;

                    const hasRecurrenceRule = !!vevent.getFirstProperty('rrule') || !!vevent.getFirstProperty('rdate');
                    const isRecurringMaster = (event.isRecurring() || hasRecurrenceRule) && !event.recurrenceId;
                    if (isRecurringMaster) stats.recurringMasters++;

                    if (event.recurrenceId) {
                        stats.recurrenceExceptions++;
                        const uid = event.uid;
                        if (!exceptions.has(uid)) {
                            exceptions.set(uid, []);
                        }
                        exceptions.get(uid)?.push(event.recurrenceId);
                    }
                } catch (e) {
                    stats.preparseErrors++;
                    logger.flowWarn("ICalParser", "event:preparse-failed", { error: logger.errorSummary(e) });
                }
            }

            // Pass 2: Process events
            for (const { event, vevent } of parsedEvents) {
                try {
                    // Skip cancelled events (handle both spellings)
                    const statusProp = vevent.getFirstProperty('status');
                    const rawStatus = this.extractString(vevent, 'status', '');
                    const status = (typeof rawStatus === 'string' ? rawStatus : '').trim().toUpperCase();

                    const summary = this.extractString(vevent, 'summary', 'Untitled Event');
                    const isExplicitCancelled = status === 'CANCELLED' || status === 'CANCELED';
                    const hasRecurrenceRule = !!vevent.getFirstProperty('rrule') || !!vevent.getFirstProperty('rdate');
                    const isRecurringMaster = (event.isRecurring() || hasRecurrenceRule) && !event.recurrenceId;

                    // Outlook sometimes publishes cancellation only as a summary prefix,
                    // including on recurring masters, without STATUS:CANCELLED.
                    const isCancelled = (!!statusProp && isExplicitCancelled && !isRecurringMaster)
                        || isCancelledCalendarTitle(summary);

                    if (isCancelled && !includeCancelled) {
                        stats.cancelledSkipped++;
                        continue;
                    }

                    const description = this.extractString(vevent, 'description', '');
                    const location = this.extractString(vevent, 'location', '');
                    const uid = this.extractString(vevent, 'uid', `${event.startDate.toUnixTime()}`);
                    const url = this.extractString(vevent, 'url', '');

                    const organizer = this.extractOrganizer(vevent);
                    const attendees = this.extractAttendees(vevent);

                    // TZID Logic
                    const dtstartProp = vevent.getFirstProperty('dtstart');
                    let explicitTzid: string | null = null;
                    if (dtstartProp) {
                        const tzidParam = dtstartProp.getParameter('tzid');
                        if (typeof tzidParam === 'string') {
                            explicitTzid = tzidParam.replace(/^["']|["']$/g, '');
                        }

                        // FORCE FLOATING logic
                        if (explicitTzid) {
                            const rawValue = dtstartProp.getFirstValue() as ICAL.Time;
                            if (rawValue && rawValue.zone && rawValue.zone.toString() !== 'floating') {
                                const floatingStart = new (ICAL.Time as any)({
                                    year: rawValue.year,
                                    month: rawValue.month,
                                    day: rawValue.day,
                                    hour: rawValue.hour,
                                    minute: rawValue.minute,
                                    second: rawValue.second,
                                    isDate: rawValue.isDate
                                });
                                event.startDate = floatingStart;

                                const dtendProp = vevent.getFirstProperty('dtend');
                                if (dtendProp) {
                                    const rawEndValue = dtendProp.getFirstValue() as ICAL.Time;
                                    if (rawEndValue && rawEndValue.zone && rawEndValue.zone.toString() !== 'floating') {
                                        const floatingEnd = new (ICAL.Time as any)({
                                            year: rawEndValue.year,
                                            month: rawEndValue.month,
                                            day: rawEndValue.day,
                                            hour: rawEndValue.hour,
                                            minute: rawEndValue.minute,
                                            second: rawEndValue.second,
                                            isDate: rawEndValue.isDate
                                        });
                                        event.endDate = floatingEnd;
                                    }
                                }
                            }
                        }
                    }

                    if (isRecurringMaster) {
                        const iterator = event.iterator(event.startDate);
                        let next: ICAL.Time | null = null;
                        let iterationCount = 0;
                        const MAX_ITERATIONS = this.getMaxIterations(vevent, event.startDate, rangeEnd);
                        const rangeStartTime = rangeStart ? ICAL.Time.fromJSDate(rangeStart) : null;

                        while ((next = iterator.next())) {
                            iterationCount++;
                            if (iterationCount > MAX_ITERATIONS) break;
                            if (rangeEnd && next.compare(ICAL.Time.fromJSDate(rangeEnd)) > 0) break;
                            if (rangeStartTime && next.compare(rangeStartTime) < 0) {
                                continue;
                            }

                            // Check exceptions
                            const eventUid = event.uid;

                            if (exceptions.has(eventUid) && next) {
                                const exceptionTimes = exceptions.get(eventUid);
                                const isException = exceptionTimes?.some(exTime => {
                                    // (Existing debug logs omitted for brevity)
                                    if (exTime.compare(next!) === 0) return true;

                                    const t1 = exTime.toUnixTime();
                                    const t2 = next!.toUnixTime();
                                    if (Math.abs(t1 - t2) < 60) return true;

                                    if (
                                        exTime.year === next!.year &&
                                        exTime.month === next!.month &&
                                        exTime.day === next!.day &&
                                        exTime.hour === next!.hour &&
                                        exTime.minute === next!.minute
                                    ) {
                                        return true;
                                    }

                                    return false;
                                });

                                if (isException) {
                                    continue;
                                }
                            }

                            const occurrence = event.getOccurrenceDetails(next);
                            const startDate = this.normalizeTime(occurrence.startDate, explicitTzid);
                            const endDate = this.normalizeTime(occurrence.endDate, explicitTzid);

                            // Stable ID: use raw ICAL.Time components to build a deterministic
                            // string that doesn't depend on timezone conversion to JS Date.
                            // This prevents different normalizeTime() fallback paths from
                            // producing different IDs across syncs.
                            const occurrenceId = `${uid}-${this.icalTimeToStableString(next)}`;

                            if (!this.pushEvent(
                                events,
                                startDate,
                                endDate,
                                occurrence.startDate.isDate,
                                {
                                    uid,
                                    id: occurrenceId, // Pass the generated ID
                                    summary,
                                    description,
                                    location,
                                    organizer,
                                    attendees,
                                    url,
                                    isCancelled
                                },
                                rangeStart,
                                rangeEnd
                            )) {
                                stats.outOfRangeSkipped++;
                            } else {
                                stats.pushedEvents++;
                            }
                        }
                    } else {
                        // Single Event
                        const end = event.endDate ?? event.startDate.clone();
                        if (!event.endDate && event.duration) {
                            end.addDuration(event.duration);
                        }

                        const startDate = this.normalizeTime(event.startDate, explicitTzid);
                        const endDate = this.normalizeTime(end, explicitTzid);

                        let stableId: string | undefined;
                        if (event.recurrenceId) {
                            // Use raw ICAL.Time components for deterministic ID
                            stableId = `${uid}-${this.icalTimeToStableString(event.recurrenceId)}`;
                        } else {
                            // Keep single-event identity stable across sync runs.
                            // Always suffix with start components to avoid ID drift when
                            // feeds intermittently include/exclude duplicate UIDs.
                            stableId = `${uid}-${this.icalTimeToStableString(event.startDate)}`;
                        }

                        if (!this.pushEvent(
                            events,
                            startDate,
                            endDate,
                            event.startDate.isDate,
                            { uid, id: stableId, summary, description, location, organizer, attendees, url, isCancelled },
                            rangeStart,
                            rangeEnd
                        )) {
                            stats.outOfRangeSkipped++;
                        } else {
                            stats.pushedEvents++;
                        }
                    }
                } catch (innerError) {
                    stats.eventErrors++;
                    logger.flowWarn("ICalParser", "event:parse-failed", { error: logger.errorSummary(innerError) });
                    continue;
                }
            }
            logger.flow("ICalParser", "parse:done", {
                ...context,
                ...stats,
                events: events.length,
            });
            return events;
        } catch (error) {
            logger.flowError("ICalParser", "parse:failed", error, {
                ...context,
                ...stats,
                events: events.length,
            });
            // Return whatever we scraped so far instead of empty array
            return events;
        }
    }

    private normalizeTime(icalTime: ICAL.Time, explicitTzid: string | null): Date {
        if (icalTime.isDate) {
            return icalTime.toJSDate();
        }

        if (icalTime.zone && icalTime.zone.toString() !== 'floating' && !explicitTzid) {
            return icalTime.toJSDate();
        }

        let targetTzid = explicitTzid;
        if (targetTzid && ICalParserService.WINDOWS_TZ_MAPPING[targetTzid]) {
            targetTzid = ICalParserService.WINDOWS_TZ_MAPPING[targetTzid];
        }

        if (targetTzid && (moment as any).tz && (moment as any).tz.zone(targetTzid)) {
            const pad = (n: number) => String(n).padStart(2, '0');
            const isoString = `${icalTime.year}-${pad(icalTime.month)}-${pad(icalTime.day)}T${pad(icalTime.hour)}:${pad(icalTime.minute)}:${pad(icalTime.second)}`;

            const m = (moment as any).tz(isoString, targetTzid);

            if (m.isValid()) {
                return m.toDate();
            }

            if (!ICalParserService.warnedZones.has(targetTzid)) {
                logger.flowWarn("ICalParser", "timezone:moment-conversion-failed", {
                    isoString,
                    targetTzid,
                    fallback: 'using manual offset calculation'
                });
                ICalParserService.warnedZones.add(targetTzid);
            }
        } else if (targetTzid) {
            if (!ICalParserService.warnedZones.has(targetTzid)) {
                logger.flowWarn("ICalParser", "timezone:zone-unavailable", {
                    targetTzid,
                    momentTzAvailable: !!(moment as any).tz
                });
                ICalParserService.warnedZones.add(targetTzid);
            }
        }

        if (targetTzid) {
            try {
                const pad = (n: number) => String(n).padStart(2, '0');
                const dateStr = `${icalTime.year}-${pad(icalTime.month)}-${pad(icalTime.day)}T${pad(icalTime.hour)}:${pad(icalTime.minute)}:${pad(icalTime.second)}`;
                const resolvedDate = this.parseDateInTimezone(dateStr, targetTzid);
                if (resolvedDate) {
                    return resolvedDate;
                }
            } catch (error) {
                logger.flowWarn("ICalParser", "timezone:manual-offset-failed", {
                    targetTzid,
                    error: logger.errorSummary(error),
                });
            }
        }

        return icalTime.toJSDate();
    }

    private parseDateInTimezone(dateStr: string, tzid: string): Date | null {
        try {
            const match = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/);
            if (!match) return null;

            const [, yearStr, monthStr, dayStr, hourStr, minuteStr, secondStr] = match;
            const year = parseInt(yearStr);
            const month = parseInt(monthStr);
            const day = parseInt(dayStr);
            const hour = parseInt(hourStr);
            const minute = parseInt(minuteStr);
            const second = parseInt(secondStr);

            try {
                const utcDate = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
                const formatter = new Intl.DateTimeFormat('en-US', {
                    timeZone: tzid,
                    year: 'numeric',
                    month: '2-digit',
                    day: '2-digit',
                    hour: '2-digit',
                    minute: '2-digit',
                    second: '2-digit',
                    hour12: false
                });

                const parts = formatter.formatToParts(utcDate);
                const formatted: Record<string, string> = {};
                for (const part of parts) {
                    if (part.type !== 'literal') {
                        formatted[part.type] = part.value;
                    }
                }

                const displayedMs = Date.UTC(
                    parseInt(formatted.year),
                    parseInt(formatted.month) - 1,
                    parseInt(formatted.day),
                    parseInt(formatted.hour),
                    parseInt(formatted.minute),
                    parseInt(formatted.second)
                );

                const utcMs = utcDate.getTime();
                const offset = displayedMs - utcMs;
                const desiredMs = Date.UTC(year, month - 1, day, hour, minute, second);
                const correctUTC = desiredMs - offset;

                return new Date(correctUTC);

            } catch (e) {
                return null;
            }

        } catch (error) {
            return null;
        }
    }

    private getMaxIterations(vevent: ICAL.Component, eventStart: ICAL.Time, rangeEnd?: Date): number {
        const baseMax = 2000;
        if (!rangeEnd) return baseMax;

        const startMs = eventStart.toJSDate().getTime();
        const endMs = rangeEnd.getTime();
        if (!Number.isFinite(startMs) || endMs <= startMs) return baseMax;

        const rrule = vevent.getFirstPropertyValue('rrule') as ICAL.Recur | null;
        const interval = rrule && typeof (rrule as any).interval === 'number' ? (rrule as any).interval : 1;
        const freqRaw = rrule && typeof (rrule as any).freq === 'string' ? (rrule as any).freq : null;
        const freq = freqRaw ? freqRaw.toUpperCase() : null;

        const dayMs = 24 * 60 * 60 * 1000;
        let msPer = dayMs;
        switch (freq) {
            case 'SECONDLY':
                msPer = 1000 * Math.max(1, interval);
                break;
            case 'MINUTELY':
                msPer = 60 * 1000 * Math.max(1, interval);
                break;
            case 'HOURLY':
                msPer = 60 * 60 * 1000 * Math.max(1, interval);
                break;
            case 'DAILY':
                msPer = dayMs * Math.max(1, interval);
                break;
            case 'WEEKLY':
                msPer = 7 * dayMs * Math.max(1, interval);
                break;
            case 'MONTHLY':
                msPer = 30 * dayMs * Math.max(1, interval);
                break;
            case 'YEARLY':
                msPer = 365 * dayMs * Math.max(1, interval);
                break;
            default:
                msPer = dayMs * Math.max(1, interval);
                break;
        }

        const estimated = Math.ceil((endMs - startMs) / msPer) + 10;
        // Match Calendar Base's hard guard so sync and rendered views cannot
        // disagree solely because one service expands an unbounded dense rule.
        const HARD_MAX_ITERATIONS = 10000;
        const capped = Math.min(HARD_MAX_ITERATIONS, Math.max(baseMax, estimated));
        return capped;
    }

    private pushEvent(
        events: ExternalCalendarEvent[],
        startDate: Date,
        endDate: Date,
        isAllDay: boolean,
        props: {
            uid: string;
            id?: string;
            summary: string;
            description: string;
            location: string;
            organizer: string;
            attendees: string[];
            url: string;
            isCancelled?: boolean;
        },
        rangeStart?: Date,
        rangeEnd?: Date
    ): boolean {
        if (rangeStart && endDate < rangeStart) return false;
        if (rangeEnd && startDate > rangeEnd) return false;

        events.push({
            id: props.id || `${props.uid}-${startDate.getTime()}`,
            uid: props.uid,
            title: props.summary,
            description: props.description,
            startDate,
            endDate,
            location: props.location,
            organizer: props.organizer,
            attendees: props.attendees,
            isAllDay,
            url: props.url,
            isCancelled: props.isCancelled,
        });
        return true;
    }

    private extractString(vevent: ICAL.Component, propName: string, fallback: string): string {
        try {
            const val = vevent.getFirstPropertyValue(propName);
            if (val === null || val === undefined) return fallback;

            if (Array.isArray(val)) {
                return val.map(v => (typeof v === 'string' ? v : String(v))).join(', ');
            }
            if (typeof val === 'string') return val;

            const strVal = String(val);
            if (strVal === '[object Object]') {
                if (typeof (val as any).toJSDate === 'function') {
                    return (val as any).toJSDate().toISOString();
                }
                return fallback;
            }
            return strVal;
        } catch (e) {
            return fallback;
        }
    }

    private extractOrganizer(vevent: ICAL.Component): string {
        const prop = vevent.getFirstProperty('organizer');
        if (!prop) return '';
        const cn = prop.getParameter('cn');
        const cnStr = Array.isArray(cn) ? cn[0] : cn;
        const val = prop.getFirstValue();
        const email = Array.isArray(val) ? String(val[0]) : (typeof val === 'string' ? val : String(val));
        return cnStr || email.replace('mailto:', '') || '';
    }

    private extractAttendees(vevent: ICAL.Component): string[] {
        const attendees: string[] = [];
        const props = vevent.getAllProperties('attendee');
        for (const prop of props) {
            const cn = prop.getParameter('cn');
            const cnStr = Array.isArray(cn) ? cn[0] : cn;
            const val = prop.getFirstValue();
            const email = Array.isArray(val) ? String(val[0]) : (typeof val === 'string' ? val : String(val));
            const attendee = cnStr || email.replace('mailto:', '') || '';
            if (attendee) attendees.push(attendee);
        }
        return attendees;
    }

    /**
     * Build a deterministic string from an ICAL.Time's raw components.
     * This avoids converting to JS Date (which goes through timezone resolution)
     * so the same logical time always produces the same string regardless of
     * which normalizeTime() fallback path runs.
     * Format: "YYYYMMDDTHHmmss" (e.g. "20240226T093000")
     */
    private icalTimeToStableString(t: ICAL.Time): string {
        const pad2 = (n: number) => String(n).padStart(2, '0');
        return `${t.year}${pad2(t.month)}${pad2(t.day)}T${pad2(t.hour)}${pad2(t.minute)}${pad2(t.second)}`;
    }
}
