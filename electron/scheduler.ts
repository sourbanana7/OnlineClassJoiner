// Background schedule monitor with robust time-window matching, early warnings, and auto-leave triggers

import { AutomationEngine } from './automation';
import { ConfigStore } from './store';
import { ClassSchedule, DayOfWeek, NextClassInfo } from './types';

export const DAY_MAP: DayOfWeek[] = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export interface ParsedTime {
  hours: number;
  minutes: number;
  totalMinutes: number;
  hhmm: string;
}

/**
 * Normalizes any day representation ('Sunday', 'sun', 'SUN', 'Sun') to standard DayOfWeek.
 */
export function normalizeDayOfWeek(day: string | undefined | null): DayOfWeek | null {
  if (!day || typeof day !== 'string') return null;
  const clean = day.trim().toLowerCase();
  const map: Record<string, DayOfWeek> = {
    sun: 'Sun',
    sunday: 'Sun',
    mon: 'Mon',
    monday: 'Mon',
    tue: 'Tue',
    tues: 'Tue',
    tuesday: 'Tue',
    wed: 'Wed',
    wednesday: 'Wed',
    thu: 'Thu',
    thur: 'Thu',
    thurs: 'Thu',
    thursday: 'Thu',
    fri: 'Fri',
    friday: 'Fri',
    sat: 'Sat',
    saturday: 'Sat',
  };
  return map[clean] || null;
}

/**
 * Parses 24-hour ("09:40", "9:40") or 12-hour ("9:40 AM", "1:30 PM", "12:00 PM") strings.
 * Returns normalized hours, minutes, totalMinutes from midnight, and 24h formatted "HH:mm".
 */
export function parseTimeTo24H(timeStr: string | undefined | null): ParsedTime | null {
  if (!timeStr || typeof timeStr !== 'string') return null;
  const trimmed = timeStr.trim();
  if (!trimmed) return null;

  // Match H:MM or HH:MM with optional seconds and optional AM/PM
  const match = trimmed.match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*([aApP][mM])?$/);
  if (!match) return null;

  let hours = parseInt(match[1], 10);
  const minutes = parseInt(match[2], 10);
  const ampm = match[3]?.toUpperCase();

  if (isNaN(hours) || isNaN(minutes) || minutes < 0 || minutes > 59) {
    return null;
  }

  if (ampm) {
    if (hours < 1 || hours > 12) return null;
    if (ampm === 'AM') {
      hours = hours === 12 ? 0 : hours;
    } else if (ampm === 'PM') {
      hours = hours === 12 ? 12 : hours + 12;
    }
  } else {
    if (hours < 0 || hours > 23) return null;
  }

  const totalMinutes = hours * 60 + minutes;
  const hhmm = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
  return { hours, minutes, totalMinutes, hhmm };
}

export class ClassScheduler {
  private store: ConfigStore;
  private engine: AutomationEngine;
  private timer: NodeJS.Timeout | null = null;
  private onClassesUpdated: (classes: ClassSchedule[]) => void;
  private onNotify?: (title: string, body: string) => void;
  /** Track classes that have already received early warnings today (keyed by `${id}-${YYYY-MM-DD}`) */
  private warnedClasses: Set<string> = new Set();
  /** Track classes that have auto-left today (keyed by `${id}-${YYYY-MM-DD}`) */
  private leftClasses: Set<string> = new Set();
  private lastPrunedDate: string = '';

  constructor(
    store: ConfigStore,
    engine: AutomationEngine,
    onClassesUpdated: (classes: ClassSchedule[]) => void,
    onNotify?: (title: string, body: string) => void
  ) {
    this.store = store;
    this.engine = engine;
    this.onClassesUpdated = onClassesUpdated;
    this.onNotify = onNotify;
  }

  public start(): void {
    if (this.timer) clearInterval(this.timer);
    this.engine.log('info', 'Background schedule monitor active (checking system clock every 5s).');
    this.tick();
    this.timer = setInterval(() => this.tick(), 5000);
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private notify(title: string, body: string): void {
    if (this.onNotify) {
      try {
        this.onNotify(title, body);
      } catch (err) {
        console.warn('[Scheduler] Failed to trigger notification:', err);
      }
    }
  }

  private tick(): void {
    const now = new Date();
    const currentDay: DayOfWeek = DAY_MAP[now.getDay()];
    const currentHours = now.getHours();
    const currentMinutes = now.getMinutes();
    const currentTotalMin = currentHours * 60 + currentMinutes;
    const todayDateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(
      2,
      '0'
    )}-${String(now.getDate()).padStart(2, '0')}`;

    // Clean up warning / auto-leave keys for previous dates to prevent unbounded memory growth
    if (this.lastPrunedDate !== todayDateStr) {
      for (const key of Array.from(this.warnedClasses)) {
        if (!key.endsWith(todayDateStr)) this.warnedClasses.delete(key);
      }
      for (const key of Array.from(this.leftClasses)) {
        if (!key.endsWith(todayDateStr)) this.leftClasses.delete(key);
      }
      this.lastPrunedDate = todayDateStr;
    }

    const classes = this.store.getClasses();

    for (const cls of classes) {
      if (!cls.enabled) continue;

      // Skip classes that haven't been configured or are flagged as needing schedule
      if (cls.needsSchedule === true) continue;
      if (cls.isScheduleConfigured === false) continue;
      if (!cls.startTime || !cls.days || cls.days.length === 0) continue;

      // Normalize days and check if today is a scheduled day
      const normalizedDays = cls.days
        .map((d) => normalizeDayOfWeek(d) || d)
        .filter(Boolean) as DayOfWeek[];

      if (!normalizedDays.includes(currentDay)) continue;

      // Parse and normalize start time (handles 24h & 12h AM/PM formats)
      const parsedStart = parseTimeTo24H(cls.startTime);
      if (!parsedStart) continue;

      const minutesUntilStart = parsedStart.totalMinutes - currentTotalMin;
      const minutesPastStart = currentTotalMin - parsedStart.totalMinutes;

      // 1-minute early notification: warn once when class is 1 minute away
      const warnKey = `${cls.id}-${todayDateStr}`;
      if (minutesUntilStart === 1 && !this.warnedClasses.has(warnKey)) {
        this.warnedClasses.add(warnKey);
        this.engine.log(
          'warn',
          `Class ${cls.courseCode} (${cls.courseName}) starts in 1 minute at ${parsedStart.hhmm}!`,
          cls.courseCode
        );
        this.notify(
          'Upcoming Class in 1 Minute',
          `${cls.courseCode}: ${cls.courseName} begins at ${parsedStart.hhmm}. Preparing automation.`
        );
      }

      // Auto-join window: triggers at exact minute (0 min past start) or within 2-minute grace window
      // Ensures no classes are missed even if app started slightly late or machine woke from sleep
      const isWithinJoinWindow = minutesPastStart >= 0 && minutesPastStart <= 2;

      if (isWithinJoinWindow && cls.lastJoinedDate !== todayDateStr) {
        // If engine is currently busy joining another class, wait for next tick within grace window
        const botStatus = this.engine.getStatus();
        const isBusy =
          botStatus.state === 'SCANNING_CLASSROOM' ||
          botStatus.state === 'WAITING_RETRY' ||
          botStatus.state === 'JOINING_MEET' ||
          botStatus.state === 'SYNCING_CLASSROOM';

        if (isBusy && botStatus.activeClassId !== cls.id) {
          continue;
        }

        const updated = this.store.markClassJoinedToday(cls.id, todayDateStr);
        this.onClassesUpdated(updated);

        this.engine.log(
          'info',
          `Scheduled start time (${parsedStart.hhmm}) reached for ${cls.courseCode}! Launching automation...`,
          cls.courseCode
        );
        this.notify(
          'Joining Scheduled Class Now',
          `Opening Google Classroom & Meet for ${cls.courseCode} (${cls.courseName})`
        );

        void this.engine.runClassJoinWorkflow(cls).catch((err) => {
          this.engine.log(
            'error',
            `Failed to start join workflow for ${cls.courseCode}: ${err?.message || err}`,
            cls.courseCode
          );
        });
      }

      // Check auto-leave trigger if enabled and class end time is reached
      if (cls.autoLeaveAtEnd && cls.endTime) {
        const parsedEnd = parseTimeTo24H(cls.endTime);
        if (parsedEnd) {
          const minutesPastEnd = currentTotalMin - parsedEnd.totalMinutes;
          const leaveKey = `${cls.id}-${todayDateStr}`;
          const botStatus = this.engine.getStatus();

          if (
            minutesPastEnd >= 0 &&
            minutesPastEnd <= 2 &&
            botStatus.state === 'IN_CLASS' &&
            botStatus.activeClassId === cls.id &&
            !this.leftClasses.has(leaveKey)
          ) {
            this.leftClasses.add(leaveKey);
            void this.engine.leaveCurrentMeetSession(cls);
          }
        }
      }
    }
  }

  /**
   * Helper calculation to find the next scheduled class across all configured courses.
   */
  public static calculateNextClass(
    classes: ClassSchedule[],
    fromDate: Date = new Date()
  ): NextClassInfo | null {
    const currentDay: DayOfWeek = DAY_MAP[fromDate.getDay()];
    const currentTotalMin = fromDate.getHours() * 60 + fromDate.getMinutes();

    let best: NextClassInfo | null = null;
    let bestMinutes = Infinity;

    for (const cls of classes) {
      if (!cls.enabled) continue;
      if (cls.isScheduleConfigured === false) continue;
      if (cls.needsSchedule) continue;
      if (!cls.days || cls.days.length === 0) continue;
      if (!cls.startTime) continue;

      const parsedStart = parseTimeTo24H(cls.startTime);
      if (!parsedStart) continue;

      const normalizedDays = cls.days
        .map((d) => normalizeDayOfWeek(d) || d)
        .filter(Boolean) as DayOfWeek[];

      // Check occurrences across 7 days
      for (let dayOffset = 0; dayOffset < 7; dayOffset++) {
        const checkDayIndex = (fromDate.getDay() + dayOffset) % 7;
        const checkDay = DAY_MAP[checkDayIndex];

        if (!normalizedDays.includes(checkDay)) continue;

        let minutesUntil: number;
        if (dayOffset === 0) {
          minutesUntil = parsedStart.totalMinutes - currentTotalMin;
          if (minutesUntil < 0) continue; // Already passed earlier today
        } else {
          minutesUntil = dayOffset * 24 * 60 + parsedStart.totalMinutes - currentTotalMin;
        }

        if (minutesUntil < bestMinutes) {
          bestMinutes = minutesUntil;
          best = {
            courseCode: cls.courseCode,
            courseName: cls.courseName,
            startTime: parsedStart.hhmm,
            minutesUntil,
          };
        }

        // Only the first/nearest occurrence of this class
        break;
      }
    }

    return best;
  }
}
