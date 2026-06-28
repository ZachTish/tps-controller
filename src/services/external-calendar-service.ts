
import { requestUrl } from 'obsidian';
import * as logger from "../logger";
import { ExternalCalendarEvent } from "../types";
import { ICalParserService } from "./ical-parser-service";

export interface ExternalCalendarFetchResult {
  events: ExternalCalendarEvent[];
  ok: boolean;
  normalizedUrl: string | null;
  fromCache: boolean;
  statusCode?: number;
  error?: unknown;
}

export class ExternalCalendarService {
  private cache: Map<string, { events: ExternalCalendarEvent[]; expiry: number }> = new Map();
  private readonly CACHE_TTL = 5 * 60 * 1000; // 5 minutes
  private readonly FETCH_TIMEOUT_MS = 15000; // 15 seconds
  private parser: ICalParserService = new ICalParserService();

  async fetchEvents(
    calendarUrl: string,
    rangeStart?: Date,
    rangeEnd?: Date,
    includeCancelled: boolean = false,
    forceRefresh: boolean = false
  ): Promise<ExternalCalendarEvent[]> {
    const result = await this.fetchEventsWithStatus(
      calendarUrl,
      rangeStart,
      rangeEnd,
      includeCancelled,
      forceRefresh
    );
    return result.events;
  }

  async fetchEventsWithStatus(
    calendarUrl: string,
    rangeStart?: Date,
    rangeEnd?: Date,
    includeCancelled: boolean = false,
    forceRefresh: boolean = false
  ): Promise<ExternalCalendarFetchResult> {
    const normalizedUrl = this.normalizeUrl(calendarUrl);
    if (!normalizedUrl) {
      return {
        events: [],
        ok: false,
        normalizedUrl: null,
        fromCache: false,
        error: new Error("Invalid calendar URL"),
      };
    }

    const cacheKey = this.getCacheKey(normalizedUrl, rangeStart, rangeEnd, includeCancelled);

    // Check cache
    const cached = this.cache.get(cacheKey);
    if (!forceRefresh && cached && Date.now() < cached.expiry) {
      return {
        events: cached.events,
        ok: true,
        normalizedUrl,
        fromCache: true,
      };
    }

    try {
      const fetchPromise = requestUrl({
        url: normalizedUrl,
        method: 'GET',
        headers: {
          Accept: 'text/calendar, text/plain;q=0.9, */*;q=0.8',
        },
      });
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Fetch timed out after ${this.FETCH_TIMEOUT_MS}ms`)), this.FETCH_TIMEOUT_MS)
      );
      const response = await Promise.race([fetchPromise, timeoutPromise]);

      if (response.status !== 200) {
        logger.error('[ExternalCalendar] Failed to fetch calendar:', response.status);
        return {
          events: [],
          ok: false,
          normalizedUrl,
          fromCache: false,
          statusCode: response.status,
          error: new Error(`Unexpected status code: ${response.status}`),
        };
      }

      const events = this.parser.parseICalData(response.text, rangeStart, rangeEnd, includeCancelled).map((evt) => ({
        ...evt,
        sourceUrl: normalizedUrl,
      }));

      // Cache the results
      this.cache.set(cacheKey, {
        events,
        expiry: Date.now() + this.CACHE_TTL,
      });

      return {
        events,
        ok: true,
        normalizedUrl,
        fromCache: false,
      };
    } catch (error) {
      logger.error('[ExternalCalendar] Error fetching calendar:', error);
      return {
        events: [],
        ok: false,
        normalizedUrl,
        fromCache: false,
        error,
      };
    }
  }

  clearCache(): void {
    this.cache.clear();
  }

  private normalizeUrl(url: string | null | undefined): string | null {
    if (!url) return null;
    const trimmed = url.trim();
    if (!trimmed) return null;
    if (trimmed.toLowerCase().startsWith('webcal://')) {
      return 'https://' + trimmed.slice('webcal://'.length);
    }
    return trimmed;
  }

  private getCacheKey(url: string, rangeStart?: Date, rangeEnd?: Date, includeCancelled?: boolean): string {
    const startKey = rangeStart ? rangeStart.toISOString().split('T')[0] : 'none';
    const endKey = rangeEnd ? rangeEnd.toISOString().split('T')[0] : 'none';
    return `${url}::${startKey}::${endKey}::${includeCancelled}`;
  }
}
