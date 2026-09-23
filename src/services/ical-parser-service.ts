
import ICAL from 'ical.js';
import { moment } from 'obsidian';
import * as logger from "../logger";
import { ExternalCalendarEvent } from "../types";
import { isCancelledCalendarTitle } from "./external-calendar-cancellation";

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
        icalData: string, rangeStart?: Date, rangeEnd?: Date,
        includeCancelled = false, strict = false,
    ): ExternalCalendarEvent[] {
        const startedAt = Date.now();
        const stats = { components: 0, series: 0, recurringMasters: 0, exceptions: 0, revisionsDiscarded: 0 };
        logger.flow("ICalParser", "parse:start", { includeCancelled, strict });
        try {
            if (typeof icalData !== 'string' || (!icalData.trim().toUpperCase().startsWith('BEGIN:VCALENDAR') || !icalData.trim().toUpperCase().endsWith('END:VCALENDAR'))) {
                throw new Error('The calendar response is not an iCalendar document.');
            }
            const comp = new ICAL.Component(ICAL.parse(icalData.trim()));
            stats.components = comp.getAllSubcomponents('vevent').length;
            const groups = new Map<string, ICAL.Component[]>();
            for (const component of comp.getAllSubcomponents('vevent')) {
                const uid = this.extractString(component, 'uid', '').trim();
                if (!uid) throw new Error('Calendar component is missing UID.');
                const group = groups.get(uid) || [];
                group.push(component);
                groups.set(uid, group);
            }
            stats.series = groups.size;
            const events: ExternalCalendarEvent[] = [];
            for (const [uid, components] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
                const masters = components.filter(component => !component.hasProperty('recurrence-id'));
                const masterComponent = masters.length ? this.latestRevision(masters) : null;
                // ICAL.Event otherwise attaches every exception in its parent calendar,
                // including unrelated UIDs. Only explicitly selected exceptions belong here.
                const master = masterComponent ? new ICAL.Event(masterComponent, { exceptions: [] }) : null;
                if (master && !master.startDate) throw new Error('Calendar master is missing DTSTART.');
                const masterZone = masterComponent ? this.timezone(masterComponent, 'dtstart') : null;
                const exceptions = new Map<string, ICAL.Component[]>();
                for (const component of components.filter(item => item.hasProperty('recurrence-id'))) {
                    const time = component.getFirstPropertyValue('recurrence-id') as ICAL.Time;
                    const original = master ? this.inMasterClock(time, this.timezone(component, 'recurrence-id'), master, masterZone) : time;
                    const key = this.icalTimeToStableString(original);
                    const same = exceptions.get(key) || [];
                    same.push(component);
                    exceptions.set(key, same);
                }
                const selected = [...exceptions.entries()].sort(([a], [b]) => a.localeCompare(b))
                    .map(([key, versions]) => ({ key, component: this.latestRevision(versions) }));
                stats.exceptions += selected.length;
                stats.revisionsDiscarded += components.length - selected.length - (master ? 1 : 0);
                const exceptionEvents = selected.map(({ key, component }) => {
                    // Work on a clone: zone/clock normalization must not mutate revision evidence.
                    const copy = new ICAL.Component(JSON.parse(JSON.stringify(component.toJSON())));
                    const event = new ICAL.Event(copy, { exceptions: [] });
                    if (!event.startDate && this.isCancelled(copy)) event.startDate = event.recurrenceId.clone();
                    if (!event.startDate) throw new Error('Calendar exception is missing DTSTART.');
                    const range = String(copy.getFirstProperty('recurrence-id')?.getParameter('range') || '').toUpperCase();
                    if (range && range !== 'THISANDFUTURE') throw new Error('Unsupported recurrence exception range.');
                    if (master) {
                        const start = this.inMasterClock(event.startDate, this.timezone(copy, 'dtstart'), master, masterZone);
                        const end = this.inMasterClock(event.endDate, this.timezone(copy, 'dtend') || this.timezone(copy, 'dtstart'), master, masterZone);
                        event.recurrenceId = this.inMasterClock(event.recurrenceId, this.timezone(copy, 'recurrence-id'), master, masterZone);
                        event.startDate = start;
                        event.endDate = end;
                    }
                    return { key, event, range };
                });
                if (master) {
                    for (const item of exceptionEvents) master.relateException(item.event);
                    const recurring = master.isRecurring() || masterComponent!.hasProperty('rrule') || masterComponent!.hasProperty('rdate');
                    if (recurring) {
                        stats.recurringMasters++;
                        const iterator = master.iterator(master.startDate);
                        const exceptionKeys = new Set(exceptionEvents.map(item => item.key));
                        // A range exception can move a future original occurrence back into
                        // this window. Expand through its maximum shift before filtering output.
                        const margin = exceptionEvents.reduce((max, item) => Math.max(max,
                            Math.abs(item.event.startDate.subtractDate(item.event.recurrenceId).toSeconds()) * 1000), 0);
                        const scanEnd = rangeEnd ? new Date(rangeEnd.getTime() + margin + 2 * 86400000) : undefined;
                        const maximum = this.getMaxIterations(masterComponent!, master.startDate, scanEnd);
                        let count = 0;
                        let next: ICAL.Time | null;
                        while ((next = iterator.next())) {
                            if (scanEnd && this.normalizeTime(next, masterZone) > scanEnd) break;
                            if (++count > maximum) throw new Error('Calendar recurrence expansion limit reached; refusing an incomplete sync.');
                            const key = this.icalTimeToStableString(next);
                            if (exceptionKeys.has(key)) continue;
                            const occurrence = master.getOccurrenceDetails(next);
                            this.emitOccurrence(events, uid, `${uid}-${key}`, true,
                                occurrence.item.component, masterComponent!, occurrence.startDate, occurrence.endDate,
                                masterZone, rangeStart, rangeEnd, includeCancelled);
                        }
                    } else {
                        this.emitOccurrence(events, uid, uid, false, masterComponent!, null,
                            master.startDate, master.endDate, masterZone, rangeStart, rangeEnd, includeCancelled);
                    }
                }
                // Explicit exceptions are emitted independently: a moved instance can enter
                // the window even when its original date was excluded or outside that window.
                for (const { key, event } of exceptionEvents) {
                    this.emitOccurrence(events, uid, `${uid}-${key}`, true, event.component, masterComponent,
                        event.startDate, event.endDate, master ? masterZone : this.timezone(event.component, 'dtstart'),
                        rangeStart, rangeEnd, includeCancelled);
                }
            }
            events.sort((a, b) => a.startDate.getTime() - b.startDate.getTime() || a.id.localeCompare(b.id));
            logger.flow("ICalParser", "parse:done", { ...stats, events: events.length, durationMs: Date.now() - startedAt });
            return events;
        } catch (error) {
            logger.flowError("ICalParser", "parse:failed", error, { ...stats, incomplete: true, durationMs: Date.now() - startedAt });
            if (strict) throw error;
            return [];
        }
    }

    private revision(component: ICAL.Component): [number, number, number] {
        const sequence = Number(component.getFirstPropertyValue('sequence') || 0);
        if (!Number.isSafeInteger(sequence) || sequence < 0) throw new Error('Invalid calendar sequence.');
        const timestamp = (name: string): number => {
            const value = component.getFirstPropertyValue(name) as ICAL.Time | null;
            const seconds = value ? value.toUnixTime() : 0;
            if (!Number.isFinite(seconds)) throw new Error('Invalid calendar revision timestamp.');
            return seconds;
        };
        return [sequence, timestamp('last-modified'), timestamp('dtstamp')];
    }

    private latestRevision(components: ICAL.Component[]): ICAL.Component {
        const compare = (a: number[], b: number[]) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
        const sorted = components.map(component => ({ component, rank: this.revision(component) }))
            .sort((a, b) => compare(b.rank, a.rank));
        const best = sorted[0];
        const canonical = (component: ICAL.Component): string => {
            const json = JSON.parse(JSON.stringify(component.toJSON()));
            json[1].sort((a: unknown, b: unknown) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
            json[2].sort((a: unknown, b: unknown) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
            return JSON.stringify(json);
        };
        for (const other of sorted.slice(1)) {
            if (compare(best.rank, other.rank) === 0 && canonical(best.component) !== canonical(other.component)) {
                throw new Error('Conflicting calendar revisions have identical sequence/timestamps; no deterministic winner.');
            }
        }
        return best.component;
    }

    private timezone(component: ICAL.Component, property: string): string | null {
        const value = component.getFirstProperty(property)?.getParameter('tzid');
        return typeof value === 'string' ? value.replace(/^["']|["']$/g, '') : null;
    }

    private inMasterClock(time: ICAL.Time, zone: string | null, master: ICAL.Event, masterZone: string | null): ICAL.Time {
        if (time.isDate !== master.startDate.isDate) throw new Error('Recurrence DATE and DATE-TIME types disagree.');
        const sameClock = zone === masterZone && time.zone.toString() === master.startDate.zone.toString();
        let result = time.clone();
        if (!time.isDate && !sameClock) {
            const instant = this.normalizeTime(time, zone);
            if (masterZone) {
                const target = ICalParserService.WINDOWS_TZ_MAPPING[masterZone] || masterZone;
                const parts = new Intl.DateTimeFormat('en-US', { timeZone: target, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(instant);
                const fields = Object.fromEntries(parts.map(part => [part.type, Number(part.value)]));
                result = new ICAL.Time({ year: fields.year, month: fields.month, day: fields.day, hour: fields.hour, minute: fields.minute, second: fields.second }, master.startDate.zone);
            } else if (master.startDate.zone.toString() === 'UTC') {
                result = ICAL.Time.fromJSDate(instant, true);
            } else if (zone || time.zone.toString() !== 'floating') {
                throw new Error('Cannot match a zoned recurrence exception to a floating master.');
            }
        }
        result.zone = master.startDate.zone;
        return result;
    }

    private isCancelled(component: ICAL.Component, fallback?: ICAL.Component | null): boolean {
        const status = this.extractString(component, 'status', fallback ? this.extractString(fallback, 'status', '') : '').trim().toUpperCase();
        const summary = this.extractString(component, 'summary', fallback ? this.extractString(fallback, 'summary', '') : '');
        return status === 'CANCELLED' || status === 'CANCELED' || isCancelledCalendarTitle(summary);
    }

    private emitOccurrence(events: ExternalCalendarEvent[], uid: string, identity: string, recurring: boolean,
        component: ICAL.Component, fallback: ICAL.Component | null, start: ICAL.Time, end: ICAL.Time,
        zone: string | null, rangeStart?: Date, rangeEnd?: Date, includeCancelled = false): void {
        const isCancelled = this.isCancelled(component, fallback);
        if (isCancelled && !includeCancelled) return;
        const startDate = this.normalizeTime(start, zone);
        const endDate = this.normalizeTime(end, zone);
        if (!Number.isFinite(startDate.getTime()) || !Number.isFinite(endDate.getTime()) || endDate < startDate) {
            throw new Error('Calendar occurrence has invalid timing.');
        }
        const text = (key: string, defaultValue = '') => this.extractString(component, key, fallback ? this.extractString(fallback, key, defaultValue) : defaultValue);
        this.pushEvent(events, startDate, endDate, start.isDate, {
            uid, id: recurring ? identity : `${uid}-${this.icalTimeToStableString(start)}`,
            occurrenceIdentity: identity, isRecurring: recurring,
            summary: text('summary', 'Untitled Event'), description: text('description'), location: text('location'),
            organizer: this.extractOrganizer(component) || (fallback ? this.extractOrganizer(fallback) : ''),
            attendees: component.hasProperty('attendee') ? this.extractAttendees(component) : fallback ? this.extractAttendees(fallback) : [],
            url: text('url'), isCancelled, sourceRevision: this.revision(component),
            sourceRevisionOrigin: component.hasProperty('recurrence-id') ? String(component.getFirstPropertyValue('recurrence-id')) : 'master',
        }, rangeStart, rangeEnd);
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
            occurrenceIdentity?: string;
            isRecurring?: boolean;
            sourceRevision?: [number, number, number];
            sourceRevisionOrigin?: string;
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
            occurrenceIdentity: props.occurrenceIdentity || props.id || props.uid,
            isRecurring: props.isRecurring === true,
            sourceRevision: props.sourceRevision,
            sourceRevisionOrigin: props.sourceRevisionOrigin,
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
