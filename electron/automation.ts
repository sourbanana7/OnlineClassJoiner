// Written and refined by Gemini - Continuing from previous agent's milestone
// Core Playwright automation engine for Google Classroom scraping, Meet detection, Mic/Cam toggles, and lobby joining

import { chromium, BrowserContext, Page } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import {
  AppSettings,
  BotStatusPayload,
  ClassSchedule,
  DayOfWeek,
  ImportedCourse,
  LogEntry,
  LogLevel,
  NextClassInfo,
} from './types';
import { ConfigStore } from './store';

type StatusEmitter = (status: BotStatusPayload) => void;
type LogEmitter = (log: LogEntry) => void;

const DAY_MAP: DayOfWeek[] = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export class AutomationEngine {
  private store: ConfigStore;
  private context: BrowserContext | null = null;
  private activePage: Page | null = null;
  private emitStatus: StatusEmitter;
  private emitLog: LogEmitter;
  private currentStatus: BotStatusPayload = {
    state: 'IDLE',
    activeClassId: null,
    activeClassName: null,
    message: 'Waiting for scheduled class time...',
  };
  private abortController: AbortController | null = null;
  private logs: LogEntry[] = [];

  constructor(store: ConfigStore, emitStatus: StatusEmitter, emitLog: LogEmitter) {
    this.store = store;
    this.emitStatus = emitStatus;
    this.emitLog = emitLog;
  }

  public getStatus(): BotStatusPayload {
    return this.currentStatus;
  }

  public getLogs(): LogEntry[] {
    return this.logs;
  }

  public clearLogs(): void {
    this.logs = [];
  }

  public log(level: LogLevel, message: string, courseCode?: string): void {
    const entry: LogEntry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      timestamp: new Date().toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      }),
      level,
      message,
      courseCode,
    };
    this.logs = [entry, ...this.logs].slice(0, 250);
    this.emitLog(entry);
  }

  private setStatus(partial: Partial<BotStatusPayload>): void {
    this.currentStatus = { ...this.currentStatus, ...partial };
    this.emitStatus(this.currentStatus);
  }

  /**
   * Resolves a system browser executable on Linux/Windows/macOS if available to ensure
   * smooth Google OAuth login, or gracefully falls back to bundled Playwright Chromium.
   */
  private detectSystemBrowserExecutable(): string | undefined {
    const candidates: string[] =
      process.platform === 'win32'
        ? [
            'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
            'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
            `${process.env.LOCALAPPDATA || ''}\\Google\\Chrome\\Application\\chrome.exe`,
            `${process.env.PROGRAMFILES || ''}\\Google\\Chrome\\Application\\chrome.exe`,
            'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
            'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
          ]
        : process.platform === 'darwin'
        ? [
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
            '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
            '/Applications/Chromium.app/Contents/MacOS/Chromium',
          ]
        : [
            '/usr/bin/google-chrome-stable',
            '/usr/bin/google-chrome',
            '/usr/bin/chromium',
            '/usr/bin/chromium-browser',
            '/usr/bin/brave-browser',
            '/snap/bin/chromium',
          ];

    for (const candidate of candidates) {
      if (candidate && fs.existsSync(candidate)) {
        return candidate;
      }
    }
    return undefined;
  }

  /**
   * Removes stale Chromium singleton lock and socket files from the profile directory.
   */
  private cleanStaleProfileLocks(userDataDir: string): void {
    try {
      if (!fs.existsSync(userDataDir)) {
        fs.mkdirSync(userDataDir, { recursive: true });
        return;
      }

      const lockFiles = [
        'SingletonLock',
        'SingletonCookie',
        'SingletonSocket',
        'parent.lock',
      ];

      for (const file of lockFiles) {
        const fullPath = path.join(userDataDir, file);
        if (fs.existsSync(fullPath)) {
          try {
            fs.rmSync(fullPath, { force: true, recursive: true });
          } catch {
            // Actively locked by running instance
          }
        }
      }

      // Check for any globbed SingletonSocket-* socket files
      try {
        const entries = fs.readdirSync(userDataDir);
        for (const entry of entries) {
          if (entry.startsWith('SingletonSocket') || entry.startsWith('SingletonLock')) {
            try {
              fs.rmSync(path.join(userDataDir, entry), { force: true, recursive: true });
            } catch {
              // Ignore
            }
          }
        }
      } catch {
        // Ignore read errors
      }
    } catch {
      // Ignore directory level errors
    }
  }

  /**
   * Launches or reuses the persistent Chromium profile.
   * Handles remote debugging CDP reconnection, stale lock cleaning, and crash resilience.
   */
  private async ensurePersistentContext(): Promise<BrowserContext> {
    if (this.context) {
      try {
        // Check if context is still alive
        this.context.pages();
        return this.context;
      } catch {
        this.context = null;
        this.activePage = null;
      }
    }

    // Check if an existing browser window is already running with remote debugging
    try {
      const cdpBrowser = await chromium.connectOverCDP('http://127.0.0.1:9222', { timeout: 1500 });
      const cdpContexts = cdpBrowser.contexts();
      if (cdpContexts.length > 0) {
        this.context = cdpContexts[0];
        this.log('info', 'Connected to already opened browser window via port 9222.');
        return this.context;
      }
    } catch {
      // No running CDP browser found, proceeding with profile launch
    }

    const userDataDir = this.store.getProfileDirectory();
    this.cleanStaleProfileLocks(userDataDir);

    const executablePath = this.detectSystemBrowserExecutable();

    const launchOptions: Parameters<typeof chromium.launchPersistentContext>[1] = {
      headless: false,
      viewport: null,
      ignoreDefaultArgs: ['--enable-automation'],
      permissions: ['microphone', 'camera', 'notifications'],
      args: [
        '--remote-debugging-port=9222',
        '--disable-blink-features=AutomationControlled',
        '--start-maximized',
        '--use-fake-ui-for-media-stream',
        '--disable-infobars',
        '--no-default-browser-check',
        '--disable-session-crashed-bubble',
        '--disable-features=TranslateUI',
      ],
    };

    if (executablePath) {
      launchOptions.executablePath = executablePath;
      this.log('info', `Using browser binary: ${executablePath}`);
    } else {
      this.log('info', 'Launching bundled Playwright Chromium engine...');
    }

    try {
      this.context = await chromium.launchPersistentContext(userDataDir, launchOptions);
    } catch (launchErr: any) {
      this.log(
        'warn',
        `Browser launch attempt encountered: ${launchErr?.message || String(launchErr)}. Cleaning stale locks and retrying...`
      );
      this.cleanStaleProfileLocks(userDataDir);
      await this.sleep(1000);
      this.context = await chromium.launchPersistentContext(userDataDir, launchOptions);
    }

    // Mask automation fingerprint so Google Workspace login never blocks sign-in
    await this.context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', {
        get: () => undefined,
      });
    });

    this.context.on('close', () => {
      this.context = null;
      this.activePage = null;
      if (this.currentStatus.state !== 'IDLE') {
        this.setStatus({
          state: 'IDLE',
          activeClassId: null,
          activeClassName: null,
          message: 'Browser window closed. Waiting for next scheduled class...',
          attempt: undefined,
          maxAttempts: undefined,
          nextRetryInSeconds: undefined,
        });
      }
    });

    return this.context;
  }

  /**
   * Searches all open tabs across the browser context to find an existing Google Classroom,
   * Google Meet, Google Accounts, or blank tab. Gracefully reuses open pages to prevent tab bloat.
   */
  public findExistingPage(context: BrowserContext, targetUrlSubstring?: string): Page | null {
    let pages: Page[] = [];
    try {
      pages = context.pages().filter((p) => {
        try {
          return !p.isClosed();
        } catch {
          return false;
        }
      });
    } catch {
      return null;
    }

    if (pages.length === 0) return null;

    // 1. Look for specific target URL match if provided
    if (targetUrlSubstring) {
      for (const p of pages) {
        try {
          if (p.url().includes(targetUrlSubstring)) {
            return p;
          }
        } catch {
          // Ignore
        }
      }
    }

    // 2. Look for an existing tab on Google Classroom
    for (const p of pages) {
      try {
        if (p.url().includes('classroom.google.com')) {
          return p;
        }
      } catch {
        // Ignore
      }
    }

    // 3. Look for an existing Google Meet tab
    for (const p of pages) {
      try {
        if (p.url().includes('meet.google.com')) {
          return p;
        }
      } catch {
        // Ignore
      }
    }

    // 4. Look for an existing tab on Google Accounts / login
    for (const p of pages) {
      try {
        if (p.url().includes('accounts.google.com')) {
          return p;
        }
      } catch {
        // Ignore
      }
    }

    // 5. Look for an empty/blank tab that can be repurposed without opening a new tab
    for (const p of pages) {
      try {
        const u = p.url();
        if (u === 'about:blank' || u === '' || u.startsWith('chrome://newtab')) {
          return p;
        }
      } catch {
        // Ignore
      }
    }

    return null;
  }

  /**
   * Reuses an existing open tab or safely allocates a new page in the given context.
   */
  private async getOrCreateUsablePage(
    context: BrowserContext,
    targetUrlSubstring?: string
  ): Promise<Page> {
    // 1. Check if existing activePage is still valid and alive
    if (this.activePage) {
      try {
        if (!this.activePage.isClosed()) {
          if (targetUrlSubstring && this.activePage.url().includes(targetUrlSubstring)) {
            await this.activePage.bringToFront().catch(() => {});
            return this.activePage;
          }
        }
      } catch {
        this.activePage = null;
      }
    }

    // 2. Search context for a suitable open tab
    const matched = this.findExistingPage(context, targetUrlSubstring);
    if (matched) {
      this.activePage = matched;
      await matched.bringToFront().catch(() => {});
      this.setupPageErrorHandlers(matched);
      return matched;
    }

    // 3. Check for any blank tab in context
    try {
      const openPages = context.pages().filter((p) => !p.isClosed());
      const blankPage = openPages.find((p) => {
        try {
          const u = p.url();
          return u === 'about:blank' || u === '' || u.startsWith('chrome://newtab');
        } catch {
          return false;
        }
      });
      if (blankPage) {
        this.activePage = blankPage;
        await blankPage.bringToFront().catch(() => {});
        this.setupPageErrorHandlers(blankPage);
        return blankPage;
      }
    } catch {
      // Ignore
    }

    // 4. Create new page if needed
    const newPage = await context.newPage();
    this.activePage = newPage;
    await newPage.bringToFront().catch(() => {});
    this.setupPageErrorHandlers(newPage);
    return newPage;
  }

  private setupPageErrorHandlers(page: Page): void {
    page.on('crash', () => {
      this.log('warn', 'Browser tab crashed unexpectedly.');
      if (this.activePage === page) {
        this.activePage = null;
      }
    });
  }

  /**
   * Checks if the page is currently authenticated into Google Classroom.
   */
  public async checkIfGoogleClassroomLoggedIn(page: Page): Promise<boolean> {
    try {
      const url = page.url();
      if (url.includes('accounts.google.com')) {
        return false;
      }
      if (!url.includes('classroom.google.com')) {
        return false;
      }

      // Check DOM for authenticated user elements
      const authenticated = await page.evaluate(() => {
        // If login inputs are visible, definitely not logged in
        if (document.querySelector('input[type="email"], input[type="password"]')) {
          return false;
        }

        // Check for Google account avatar, course cards, or classroom main header
        const hasAccountAvatar = !!document.querySelector(
          '[aria-label*="Google Account" i], [aria-label*="Google-konto" i], [aria-label*="Cuenta de Google" i], a[href*="SignOutOptions"], img[src*="googleusercontent.com"]'
        );
        const hasCoursesOrClasses = !!document.querySelector(
          'a[href*="/c/"], [data-course-id], .YVvGBb, main, [role="main"], [role="listitem"]'
        );
        const hasGoogleBar = !!document.querySelector('header, [role="banner"]');

        return (hasAccountAvatar || hasCoursesOrClasses) && hasGoogleBar;
      });

      return authenticated;
    } catch {
      return false;
    }
  }

  /**
   * Opens or checks Google Classroom authentication:
   * 1. Checks for already opened browser windows/tabs first.
   * 2. Brings existing window to front instead of opening duplicates.
   * 3. Verifies session automatically and saves auth status.
   */
  public async openGoogleAuthentication(): Promise<void> {
    try {
      this.setStatus({
        state: 'AUTH_OPEN',
        activeClassId: null,
        activeClassName: null,
        message: 'Checking for opened Google Classroom windows...',
      });
      this.log('info', 'Checking for opened Google Classroom windows and tabs first...');

      const context = await this.ensurePersistentContext();
      const page = await this.getOrCreateUsablePage(context, 'classroom.google.com');

      // Step 2: Check current page URL & authentication status
      const currentUrl = page.url();

      if (currentUrl.includes('classroom.google.com')) {
        this.log('info', 'Verifying login status on existing Google Classroom page...');
        const isLoggedIn = await this.checkIfGoogleClassroomLoggedIn(page);
        if (isLoggedIn) {
          this.store.updateSettings({ isGoogleAuthenticated: true });
          this.setStatus({
            state: 'IDLE',
            activeClassId: null,
            activeClassName: null,
            message: 'Already logged in to Google Classroom! Session verified.',
          });
          this.log('success', 'Existing Google Classroom session verified! You are already logged in.');
          return;
        }
      }

      // Step 3: If not on Classroom or Accounts, navigate the existing page to Classroom
      if (!currentUrl.includes('classroom.google.com') && !currentUrl.includes('accounts.google.com')) {
        this.log('info', 'Navigating existing window to https://classroom.google.com...');
        await page.goto('https://classroom.google.com', {
          waitUntil: 'domcontentloaded',
          timeout: 60000,
        });
      }

      await page.bringToFront().catch(() => {});

      // Step 4: Check if login was preserved/instant
      await this.sleep(2500);
      const isLoggedInNow = await this.checkIfGoogleClassroomLoggedIn(page);
      if (isLoggedInNow) {
        this.store.updateSettings({ isGoogleAuthenticated: true });
        this.setStatus({
          state: 'IDLE',
          activeClassId: null,
          activeClassName: null,
          message: 'Google Classroom session verified and saved!',
        });
        this.log('success', 'Google Classroom session active. Saved automatically!');
      } else {
        this.setStatus({
          state: 'AUTH_OPEN',
          activeClassId: null,
          activeClassName: null,
          message: 'Google Classroom login window ready. Please complete sign-in in the browser.',
        });
        this.log('info', 'Please complete sign-in in the focused browser window. Your login will be saved.');
      }
    } catch (error: any) {
      const msg = error?.message || String(error);
      this.log('error', `Failed to verify or open Google Classroom authentication: ${msg}`);
      this.setStatus({
        state: 'ERROR',
        message: `Auth error: ${msg}`,
      });
    }
  }

  /**
   * Cancels any ongoing Refresh & Scan loop.
   */
  public async cancelActiveTask(): Promise<void> {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    this.log('warn', 'Active automation scan cancelled by user.');
    this.setStatus({
      state: 'IDLE',
      activeClassId: null,
      activeClassName: null,
      message: 'Waiting for scheduled class time...',
      attempt: undefined,
      maxAttempts: undefined,
      nextRetryInSeconds: undefined,
    });
  }

  /**
   * Core "Refresh & Scan" Engine:
   * 1. Navigates to the course's Google Classroom URL.
   * 2. Scans the DOM for an active Google Meet link (banner button or stream post).
   * 3. If not found, refreshes every interval seconds for up to maxScanDuration.
   * 4. Once found, navigates to Meet, mutes Mic & Cam, and joins the session.
   */
  public async runClassJoinWorkflow(cls: ClassSchedule): Promise<void> {
    if (
      this.currentStatus.state === 'SCANNING_CLASSROOM' ||
      this.currentStatus.state === 'WAITING_RETRY' ||
      this.currentStatus.state === 'JOINING_MEET'
    ) {
      this.log(
        'warn',
        `Skipping trigger for ${cls.courseCode} because an automation workflow is already running.`,
        cls.courseCode
      );
      return;
    }

    this.abortController = new AbortController();
    const { signal } = this.abortController;
    const settings: AppSettings = this.store.getSettings();

    const intervalSec = Math.max(10, settings.scanIntervalSeconds || 30);
    const maxDurationMin = Math.max(1, settings.maxScanDurationMinutes || 5);
    const maxAttempts = Math.floor((maxDurationMin * 60) / intervalSec) + 1;

    try {
      this.log(
        'info',
        `Starting Refresh & Scan Engine for ${cls.courseCode} (${cls.courseName})`,
        cls.courseCode
      );

      const context = await this.ensurePersistentContext();
      const page = await this.getOrCreateUsablePage(context, cls.classroomUrl);

      let meetUrl: string | null = null;

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        if (signal.aborted) return;

        this.setStatus({
          state: 'SCANNING_CLASSROOM',
          activeClassId: cls.id,
          activeClassName: `${cls.courseCode} - ${cls.courseName}`,
          message:
            attempt === 1
              ? `Opening Classroom page for ${cls.courseCode}...`
              : `Refreshing Classroom page (Attempt ${attempt}/${maxAttempts})...`,
          attempt,
          maxAttempts,
          nextRetryInSeconds: undefined,
        });

        if (attempt === 1) {
          if (!page.url().includes(cls.classroomUrl)) {
            this.log('info', `Navigating to Classroom URL: ${cls.classroomUrl}`, cls.courseCode);
            await page.goto(cls.classroomUrl, {
              waitUntil: 'domcontentloaded',
              timeout: 45000,
            });
          } else {
            this.log('info', `Already on course page: ${cls.classroomUrl}`, cls.courseCode);
          }
        } else {
          this.log(
            'info',
            `Refreshing Classroom page (Scan ${attempt} of ${maxAttempts})...`,
            cls.courseCode
          );
          await page.reload({
            waitUntil: 'domcontentloaded',
            timeout: 45000,
          });
        }

        // Wait 4 seconds for Google Classroom SPA components & stream posts to hydrate
        await this.sleep(4000, signal);
        if (signal.aborted) return;

        // Scan DOM for active Google Meet link
        meetUrl = await this.scanClassroomDomForMeetLink(page);

        if (meetUrl) {
          this.log('success', `Active Google Meet link found: ${meetUrl}`, cls.courseCode);
          break;
        }

        if (attempt < maxAttempts) {
          this.log(
            'warn',
            `No active Meet link found yet. Auto-refreshing in ${intervalSec} seconds (Attempt ${attempt}/${maxAttempts})...`,
            cls.courseCode
          );

          for (let remaining = intervalSec; remaining > 0; remaining--) {
            if (signal.aborted) return;
            this.setStatus({
              state: 'WAITING_RETRY',
              activeClassId: cls.id,
              activeClassName: `${cls.courseCode} - ${cls.courseName}`,
              message: `Meet link not posted yet. Refreshing in ${remaining}s...`,
              attempt,
              maxAttempts,
              nextRetryInSeconds: remaining,
            });
            await this.sleep(1000, signal);
          }
        }
      }

      if (signal.aborted) return;

      if (!meetUrl) {
        this.log(
          'error',
          `Timed out after ${maxDurationMin} minutes scanning Classroom for ${cls.courseCode}. Instructor has not posted a Meet link.`,
          cls.courseCode
        );
        this.setStatus({
          state: 'IDLE',
          activeClassId: null,
          activeClassName: null,
          message: `No Meet link found for ${cls.courseCode} after ${maxDurationMin}m window.`,
          attempt: undefined,
          maxAttempts: undefined,
        });
        return;
      }

      // Navigate to Google Meet & join
      await this.joinGoogleMeetSession(page, meetUrl, cls, settings, signal);
    } catch (error: any) {
      if (signal.aborted) return;
      const errMsg = error?.message || String(error);
      this.log('error', `Automation error for ${cls.courseCode}: ${errMsg}`, cls.courseCode);
      this.setStatus({
        state: 'ERROR',
        activeClassId: cls.id,
        activeClassName: `${cls.courseCode} - ${cls.courseName}`,
        message: `Error: ${errMsg}`,
      });
    }
  }

  /**
   * Resilient Google Meet Link Discovery Engine:
   * Accurately detects:
   * Tier 1: Dedicated Top Banner Meet button / cards (official header Meet link).
   * Tier 2: Stream announcements and posts in chronological order (direct links, Google redirect links, or raw text).
   * Tier 3: DOM-wide anchor and text fallback.
   * Supports standard codes (xxx-yyyy-zzz), lookup links (lookup/abc), and URL-encoded redirects.
   */
  public async scanClassroomDomForMeetLink(page: Page): Promise<string | null> {
    try {
      // If current page is already a valid Meet URL, return it immediately
      const currentUrl = page.url();
      if (/https?:\/\/meet\.google\.com\/(?:[a-z]{3}-[a-z]{4}-[a-z]{3}|lookup\/[^\s/?#]+|[a-zA-Z0-9_-]{10,})/i.test(currentUrl)) {
        return currentUrl;
      }

      const foundLink = await page.evaluate(() => {
        const meetRegex =
          /https?:\/\/meet\.google\.com\/(?:[a-z]{3}-[a-z]{4}-[a-z]{3}|lookup\/[a-zA-Z0-9_-]+|[a-zA-Z0-9_-]{10,})(?:\?[^\s"'<>]*)?/i;
        const rawCodeRegex = /\b([a-z]{3}-[a-z]{4}-[a-z]{3})\b/i;

        const cleanAndValidate = (urlCandidate: string): string | null => {
          if (!urlCandidate) return null;
          let cleaned = urlCandidate.trim();

          // Strip wrapping quotes, brackets, or trailing punctuation
          cleaned = cleaned.replace(/^["'(<[]+|[.,)"'>\]]+$/g, '');

          // Decode URL if it's a Google redirect link (google.com/url?q=...)
          if (cleaned.includes('google.com/url?') || cleaned.includes('/url?q=')) {
            try {
              const urlObj = new URL(cleaned);
              const qParam = urlObj.searchParams.get('q');
              if (qParam) {
                cleaned = decodeURIComponent(qParam);
              }
            } catch {
              const qMatch = cleaned.match(/[?&]q=([^&]+)/);
              if (qMatch) {
                try {
                  cleaned = decodeURIComponent(qMatch[1]);
                } catch {
                  cleaned = qMatch[1];
                }
              }
            }
          }

          // Prepend https:// if raw meet.google.com
          if (/^meet\.google\.com\//i.test(cleaned)) {
            cleaned = `https://${cleaned}`;
          }

          // Disqualify generic root or landing links
          if (
            /https?:\/\/meet\.google\.com\/?(?:\?.*)?$/i.test(cleaned) ||
            /https?:\/\/meet\.google\.com\/(?:landing|about|new|terms|help)\b/i.test(cleaned)
          ) {
            return null;
          }

          if (meetRegex.test(cleaned)) {
            return cleaned;
          }

          return null;
        };

        // --- TIER 1: Dedicated Classroom Header Banner Meet Link ---
        // Look within header / top banner region (banner container or top 450px)
        const bannerContainers = Array.from(
          document.querySelectorAll(
            'header, [role="banner"], [class*="banner" i], [class*="theme" i], [class*="Header" i], [data-course-id]'
          )
        );

        for (const container of bannerContainers) {
          // Check anchor tags inside the banner
          const bannerAnchors = Array.from(container.querySelectorAll<HTMLAnchorElement>('a[href]'));
          for (const a of bannerAnchors) {
            const valid = cleanAndValidate(a.href);
            if (valid) return valid;
          }

          // Check custom attributes (data-meet-url, data-href, aria-label)
          const meetElements = Array.from(
            container.querySelectorAll<HTMLElement>(
              '[data-meet-url], [data-href*="meet.google.com"], [aria-label*="Meet" i], [aria-label*="Reunión" i], [aria-label*="Lien" i]'
            )
          );
          for (const el of meetElements) {
            const dataUrl = el.getAttribute('data-meet-url') || el.getAttribute('data-href');
            if (dataUrl) {
              const valid = cleanAndValidate(dataUrl);
              if (valid) return valid;
            }
          }
        }

        // Check any element in top 450px containing meet.google.com
        const allAnchors = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]'));
        for (const a of allAnchors) {
          const rect = a.getBoundingClientRect();
          if (rect.top >= 0 && rect.top <= 450 && rect.width > 0 && rect.height > 0) {
            const valid = cleanAndValidate(a.href);
            if (valid) return valid;
          }
        }

        // --- TIER 2: Stream Announcement & Feed Posts ---
        // Posts are sorted chronologically with newest at the top
        const postContainers = Array.from(
          document.querySelectorAll(
            '[data-stream-item-id], [role="article"], [role="region"], div[class*="streamItem" i], div[class*="announcement" i], div[class*="post" i]'
          )
        );

        for (const post of postContainers) {
          // 1. Direct and redirect anchors inside post
          const postAnchors = Array.from(post.querySelectorAll<HTMLAnchorElement>('a[href]'));
          for (const a of postAnchors) {
            const valid = cleanAndValidate(a.href);
            if (valid) return valid;
          }

          // 2. Scan text content of post for raw meet URLs
          const postText = (post as HTMLElement).innerText || post.textContent || '';
          const textUrlMatch = postText.match(
            /(?:https?:\/\/)?meet\.google\.com\/(?:[a-z]{3}-[a-z]{4}-[a-z]{3}|lookup\/[a-zA-Z0-9_-]+|[a-zA-Z0-9_-]{10,})(?:\?[^\s"'<>]*)?/i
          );
          if (textUrlMatch) {
            const valid = cleanAndValidate(textUrlMatch[0]);
            if (valid) return valid;
          }

          // 3. Scan for standalone meet code format e.g. "code: abc-defg-hij" or "meet: abc-defg-hij"
          const codeMatch = postText.match(/(?:meet|code|link|join)[^a-z0-9]*([a-z]{3}-[a-z]{4}-[a-z]{3})/i);
          if (codeMatch && codeMatch[1]) {
            return `https://meet.google.com/${codeMatch[1].toLowerCase()}`;
          }
        }

        // --- TIER 3: Document-wide Fallback ---
        for (const a of allAnchors) {
          const valid = cleanAndValidate(a.href);
          if (valid) return valid;
        }

        // Document body raw text match
        const mainEl = document.querySelector('main, [role="main"]') || document.body;
        const mainText = (mainEl as HTMLElement).innerText || '';
        const rawMatch = mainText.match(
          /(?:https?:\/\/)?meet\.google\.com\/(?:[a-z]{3}-[a-z]{4}-[a-z]{3}|lookup\/[a-zA-Z0-9_-]+|[a-zA-Z0-9_-]{10,})(?:\?[^\s"'<>]*)?/i
        );
        if (rawMatch) {
          const valid = cleanAndValidate(rawMatch[0]);
          if (valid) return valid;
        }

        return null;
      });

      return foundLink;
    } catch {
      return null;
    }
  }

  /**
   * Dismisses any permission prompts, "Ready to join?" interstitials, or info popups in Google Meet.
   */
  private async dismissMeetPromptsAndInterstitials(
    page: Page,
    signal: AbortSignal
  ): Promise<void> {
    const dismissSelectors = [
      // English permission & info dismissals
      'button:has-text("Continue without microphone and camera")',
      'button:has-text("Continue without microphone")',
      'button:has-text("Continue without camera")',
      'button:has-text("Got it")',
      'button:has-text("Dismiss")',
      'button:has-text("Dismiss notification")',
      'button:has-text("Close")',
      'button:has-text("No thanks")',
      'button:has-text("Not now")',
      // Ready to join interstitial
      'button:has-text("Ready to join")',
      'button:has-text("Check in")',
      // Multilingual variations (Spanish, French, German, Portuguese, Italian, Japanese, Chinese, Arabic)
      'button:has-text("Continuar sin micrófono y cámara")',
      'button:has-text("Entendido")',
      'button:has-text("Descartar")',
      'button:has-text("Cerrar")',
      'button:has-text("Continuer sans micro ni caméra")',
      'button:has-text("J\'ai compris")',
      'button:has-text("Ignorer")',
      'button:has-text("Ohne Mikrofon und Kamera fortfahren")',
      'button:has-text("Verstanden")',
      'button:has-text("Continuar sem microfone e câmera")',
      'button:has-text("Entendi")',
      '[aria-label*="Dismiss" i]',
      '[aria-label*="Got it" i]',
      '[aria-label*="Close" i]',
    ];

    for (let i = 0; i < 4; i++) {
      if (signal.aborted) return;
      try {
        for (const selector of dismissSelectors) {
          const loc = page.locator(selector).first();
          if ((await loc.count()) > 0 && (await loc.isVisible())) {
            await loc.click({ timeout: 1500 }).catch(() => {});
            await this.sleep(400, signal);
          }
        }
      } catch {
        // Ignore
      }
      await this.sleep(400, signal);
    }
  }

  /**
   * Inspects Google Meet's pre-join media toggle buttons and mutes the device
   * using resilient multi-tier detection:
   * 1. Check data-is-muted="false" / data-is-muted="true" attributes
   * 2. Multilingual aria-labels and button titles (English, Spanish, French, German, Portuguese, etc.)
   * 3. Native keyboard shortcuts (Ctrl+D / Cmd+D for mic, Ctrl+E / Cmd+E for camera)
   */
  private async ensureDeviceMuted(
    page: Page,
    device: 'microphone' | 'camera',
    courseCode: string,
    signal?: AbortSignal
  ): Promise<void> {
    if (signal?.aborted) return;

    try {
      const isMic = device === 'microphone';
      const hotkey =
        process.platform === 'darwin'
          ? isMic
            ? 'Meta+d'
            : 'Meta+e'
          : isMic
          ? 'Control+d'
          : 'Control+e';

      // Evaluate the button's DOM state directly
      const deviceState = await page.evaluate((isMicrophone: boolean) => {
        const micUnmutedRegex =
          /(turn off mic|mute mic|desactivar mic|couper le micro|stumm|desativar mic|disattiva mic|マイクをオフ|关闭麦克风|отключить микрофон|মাইক্রোফোন বন্ধ|माइक्रोफ़ोन बंद)/i;
        const micMutedRegex =
          /(turn on mic|unmute mic|activar mic|activer le micro|einschalten|ativar mic|attiva mic|マイクをオン|打开麦克风|включить микрофон|মাইক্রোফোন চালু|माइक्रोफ़ोन चालू)/i;

        const camUnmutedRegex =
          /(turn off cam|turn off video|desactivar cám|desactivar cam|couper la caméra|kamera deaktivieren|desativar câm|desativar cam|disattiva vid|disattiva cam|カメラをオフ|关闭摄像头|выключить камеру|ক্যামেরা বন্ধ|कैमरा बंद)/i;
        const camMutedRegex =
          /(turn on cam|turn on video|activar cám|activar cam|activer la caméra|kamera aktivieren|ativar câm|ativar cam|attiva vid|attiva cam|カメラをオン|打开摄像头|включить камеру|ক্যামেরা চালু|कैमरा चालू)/i;

        const buttons = Array.from(document.querySelectorAll<HTMLElement>('button, [role="button"]'));

        for (const btn of buttons) {
          const aria = (btn.getAttribute('aria-label') || '').trim();
          const tooltip = (btn.getAttribute('data-tooltip') || '').trim();
          const mutedAttr = btn.getAttribute('data-is-muted');
          const combined = `${aria} ${tooltip}`;

          if (isMicrophone) {
            // Check microphone button
            const isMicBtn =
              btn.matches('[aria-label*="mic" i], [data-tooltip*="mic" i], [aria-label*="micro" i]') ||
              micUnmutedRegex.test(combined) ||
              micMutedRegex.test(combined) ||
              combined.includes('ctrl + d') ||
              combined.includes('⌘ + d');

            if (isMicBtn) {
              if (mutedAttr === 'true' || micMutedRegex.test(combined)) {
                return 'ALREADY_MUTED';
              }
              if (mutedAttr === 'false' || micUnmutedRegex.test(combined)) {
                btn.click();
                return 'CLICKED_MUTE';
              }
            }
          } else {
            // Check camera button
            const isCamBtn =
              btn.matches('[aria-label*="cam" i], [data-tooltip*="cam" i], [aria-label*="camera" i], [aria-label*="vid" i]') ||
              camUnmutedRegex.test(combined) ||
              camMutedRegex.test(combined) ||
              combined.includes('ctrl + e') ||
              combined.includes('⌘ + e');

            if (isCamBtn) {
              if (mutedAttr === 'true' || camMutedRegex.test(combined)) {
                return 'ALREADY_MUTED';
              }
              if (mutedAttr === 'false' || camUnmutedRegex.test(combined)) {
                btn.click();
                return 'CLICKED_MUTE';
              }
            }
          }
        }

        return 'NOT_FOUND';
      }, isMic);

      if (deviceState === 'ALREADY_MUTED') {
        this.log('info', `${device.charAt(0).toUpperCase() + device.slice(1)} is already OFF.`, courseCode);
        return;
      }

      if (deviceState === 'CLICKED_MUTE') {
        this.log('info', `Clicked button to turn OFF ${device}.`, courseCode);
        await this.sleep(500, signal);
        return;
      }

      // If button selector was ambiguous or not found, trigger resilient keyboard hotkey
      await page.keyboard.press(hotkey);
      this.log('info', `Sent ${hotkey} shortcut to ensure ${device} is OFF.`, courseCode);
      await this.sleep(500, signal);
    } catch {
      this.log('warn', `Could not verify ${device} state automatically; check Meet lobby.`, courseCode);
    }
  }

  /**
   * Navigates to the Google Meet URL, handles permission prompts and interstitials,
   * ensures Microphone and Camera are OFF, and joins or asks to join the meeting.
   */
  private async joinGoogleMeetSession(
    page: Page,
    meetUrl: string,
    cls: ClassSchedule,
    settings: AppSettings,
    signal: AbortSignal
  ): Promise<void> {
    this.setStatus({
      state: 'JOINING_MEET',
      activeClassId: cls.id,
      activeClassName: `${cls.courseCode} - ${cls.courseName}`,
      message: `Meet link found! Configuring Mic/Cam and joining ${cls.courseCode}...`,
      attempt: undefined,
      maxAttempts: undefined,
      nextRetryInSeconds: undefined,
    });

    this.log('info', `Opening Google Meet lobby: ${meetUrl}`, cls.courseCode);
    await page.goto(meetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

    // Wait for Meet pre-join screen controls to initialize
    await this.sleep(4500, signal);
    if (signal.aborted) return;

    // Dismiss permission popups and "Ready to join?" interstitials
    await this.dismissMeetPromptsAndInterstitials(page, signal);

    // 1. Mute Microphone if enabled in settings
    if (settings.alwaysMuteMic) {
      await this.ensureDeviceMuted(page, 'microphone', cls.courseCode, signal);
    }

    // 2. Turn Off Camera if enabled in settings
    if (settings.alwaysTurnOffCam) {
      await this.ensureDeviceMuted(page, 'camera', cls.courseCode, signal);
    }

    await this.sleep(1000, signal);
    if (signal.aborted) return;

    // 3. Resilient Join Detection & Click
    this.log('info', 'Searching for "Join now" / "Ask to join" button...', cls.courseCode);

    let joined = false;
    let askedToJoin = false;

    // Polling loop up to 18 seconds for lobby controls to settle
    const startTime = Date.now();
    while (Date.now() - startTime < 18000) {
      if (signal.aborted) return;

      // Check if already connected inside the meeting room
      const inCall = await page.evaluate(() => {
        const leaveBtn = document.querySelector(
          '[aria-label*="Leave call" i], [aria-label*="leave" i], button[data-call-ended]'
        );
        return !!leaveBtn;
      });

      if (inCall) {
        joined = true;
        break;
      }

      // Check if user has already clicked "Ask to join" and is in the waiting room
      const isWaitingAdmission = await page.evaluate(() => {
        const bodyText = document.body.innerText || '';
        const waitingRegex =
          /(asking to join|waiting for host|someone will let you in|solicitando unirse|demande envoyée|anfrage gesendet|solicitação enviada)/i;
        return waitingRegex.test(bodyText);
      });

      if (isWaitingAdmission) {
        askedToJoin = true;
        break;
      }

      // Check for Join button across multiple languages and aria-labels
      const clicked = await page.evaluate(() => {
        const joinRegex =
          /^(join now|ask to join|join anyway|rejoin|switch here|unirse ahora|solicitar unirse|unirme ahora|participer à la réunion|demander à participer|rejoindre maintenant|jetzt teilnehmen|teilnahme anfragen|participar agora|pedir para participar|partecipa|chiedi di partecipare|присоединиться|попросить о присоединении|এখনই যোগ দিন|যোগদানের অনুরোধ জানান|अभी शामिल हों|立即加入|申请加入|今すぐ参加|参加をリクエスト|الانضمام الآن|طلب الانضمام)$/i;

        const partialJoinRegex =
          /(join now|ask to join|join anyway|unirse ahora|solicitar unirse|participer à la réunion|jetzt teilnehmen|participar agora|partecipa|присоединиться|এখনই যোগ দিন|अभी शामिल हों|立即加入|今すぐ参加)/i;

        const buttons = Array.from(document.querySelectorAll<HTMLElement>('button, [role="button"]'));

        for (const btn of buttons) {
          const text = (btn.innerText || btn.textContent || '').trim();
          const aria = (btn.getAttribute('aria-label') || '').trim();

          // Exclude "Present" / "Share screen" buttons
          if (/present|compartir pantalla|partager l'écran|bildschirm/i.test(text) || /present/i.test(aria)) {
            continue;
          }

          if (joinRegex.test(text) || joinRegex.test(aria) || partialJoinRegex.test(text)) {
            const rect = btn.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
              btn.click();
              return true;
            }
          }
        }
        return false;
      });

      if (clicked) {
        joined = true;
        await this.sleep(2000, signal);
        break;
      }

      await this.sleep(1200, signal);
    }

    if (joined || askedToJoin) {
      const msg = askedToJoin
        ? `Sent join request for ${cls.courseCode} (${cls.courseName}) — waiting for instructor admittance.`
        : `Successfully joined ${cls.courseCode} (${cls.courseName}) with Mic & Camera muted!`;

      this.log('success', msg, cls.courseCode);
      this.setStatus({
        state: 'IN_CLASS',
        activeClassId: cls.id,
        activeClassName: `${cls.courseCode} - ${cls.courseName}`,
        message: askedToJoin
          ? `Waiting for host to admit to ${cls.courseCode} (Mic & Cam OFF)`
          : `Connected to ${cls.courseCode} Google Meet (Mic & Cam OFF)`,
      });
    } else {
      this.log(
        'warn',
        `Meet lobby opened for ${cls.courseCode}, but "Join now" button was not immediately clickable. Please check the browser window.`,
        cls.courseCode
      );
      this.setStatus({
        state: 'IN_CLASS',
        activeClassId: cls.id,
        activeClassName: `${cls.courseCode} - ${cls.courseName}`,
        message: `Meet page open for ${cls.courseCode}. Verify join status in browser.`,
      });
    }
  }

  /**
   * Automatically leaves the active Google Meet session when class endTime is reached
   * if autoLeaveAtEnd is enabled for the class.
   */
  public async leaveCurrentMeetSession(cls: ClassSchedule): Promise<void> {
    if (!this.activePage) return;
    try {
      this.log('info', `Class end time reached for ${cls.courseCode}. Leaving Meet call...`, cls.courseCode);

      const leaveSelectors = [
        '[aria-label*="Leave call" i]',
        '[aria-label*="Leave" i]',
        'button:has-text("Leave call")',
        'button:has-text("Salir de la llamada")',
        'button:has-text("Quitter l\'appel")',
        'button:has-text("Anruf verlassen")',
        'button:has-text("Sair da chamada")',
        '[data-tooltip*="leave" i]',
      ];

      let clicked = false;
      for (const sel of leaveSelectors) {
        const btn = this.activePage.locator(sel).first();
        if ((await btn.count()) > 0 && (await btn.isVisible())) {
          await btn.click({ timeout: 2500 }).catch(() => {});
          clicked = true;
          break;
        }
      }

      if (!clicked) {
        await this.activePage.goto('about:blank').catch(() => {});
      }

      this.log('success', `Left ${cls.courseCode} at scheduled end time.`, cls.courseCode);
      this.setStatus({
        state: 'IDLE',
        activeClassId: null,
        activeClassName: null,
        message: `Left ${cls.courseCode} at scheduled end time. Waiting for next class...`,
        attempt: undefined,
        maxAttempts: undefined,
        nextRetryInSeconds: undefined,
      });
    } catch {
      this.setStatus({
        state: 'IDLE',
        activeClassId: null,
        activeClassName: null,
        message: 'Waiting for scheduled class time...',
        attempt: undefined,
        maxAttempts: undefined,
        nextRetryInSeconds: undefined,
      });
    }
  }

  /**
   * Resilient Multi-Tier Scraper for Enrolled Google Classroom Courses:
   * Google Classroom frequently rotates and obfuscates CSS class names.
   * This implementation deploys resilient multi-tier fallback scrapers:
   * 1. Card Container DOM Walking: Traverses card containers (`ol > li`, `[role="listitem"]`, `[data-course-id]`, `article`).
   * 2. Semantic Selectors: Extracts headings (`[role="heading"]`, `h2`, `h3`, `div[aria-level]`), course links (`a[href*="/c/"]`, `a[href*="/r/"]`).
   * 3. Aria-label Parsing: Strips boilerplate prefixes ("Open class:", "Options for", "Class:") and splits title/section.
   * 4. Robust Regex Extraction: Extracts course codes (e.g. "CSE 203T", "BDS 109", "PHY 101L") and sections (e.g. "Sec 10").
   */
  public async scrapeClassroomCourses(): Promise<ImportedCourse[]> {
    this.log('info', 'Connecting to Google Classroom to retrieve enrolled courses...');

    try {
      const context = await this.ensurePersistentContext();
      const page = await this.getOrCreateUsablePage(context, 'classroom.google.com');

      // Preserve existing user account profile (/u/1/, /u/2/, etc.) if already selected
      const currentUrl = page.url();
      const accountMatch = currentUrl.match(/\/u\/(\d+)\//);
      const accountPath = accountMatch ? `/u/${accountMatch[1]}/h` : '/u/0/h';

      const isDashboard =
        /\/h(\/classes)?(\?.*)?$/i.test(currentUrl) ||
        /classroom\.google\.com\/?(\?.*)?$/i.test(currentUrl);

      if (!isDashboard) {
        this.log('info', `Navigating to Google Classroom classes dashboard (https://classroom.google.com${accountPath})...`);
        await page.goto(`https://classroom.google.com${accountPath}`, {
          waitUntil: 'domcontentloaded',
          timeout: 60000,
        });
      }

      // Wait for Classroom SPA hydration
      await this.sleep(4500);

      try {
        await page.waitForSelector('a[href*="/c/"], [data-course-id], [role="listitem"]', {
          timeout: 10000,
        });
      } catch {
        this.log('warn', 'Waiting for course card elements to settle...');
      }

      const courses = await page.evaluate(() => {
        const results: Array<{
          id: string;
          name: string;
          section?: string;
          url: string;
          courseCode?: string;
        }> = [];

        const seen = new Set<string>();

        // Regex helpers
        const extractCode = (text: string): string | undefined => {
          if (!text) return undefined;
          // Strip semester/term prefixes like "Autumn-2026-", "Spring 2025 ", "Fall_2026"
          const cleaned = text.replace(
            /\b(autumn|spring|summer|fall|winter|semester|term)[-_ ]*(20\d\d)\b/gi,
            ''
          );

          // Matches: "CSE 203T", "CSE203T", "BDS-109", "PHY 101L", "MAT120", "CS 101", "COMP.SCI 101"
          const codeRegex = /\b([A-Z]{2,6})\s*[-_.]?\s*([0-9]{3,4}[A-Z]?)\b/gi;
          let match: RegExpExecArray | null;
          while ((match = codeRegex.exec(cleaned)) !== null) {
            const dept = match[1].toUpperCase();
            const num = match[2].toUpperCase();
            // Avoid matching semester names or non-course keywords
            if (!/^(AUTUMN|SPRING|SUMMER|FALL|WINTER|CLASS|TERM|ROOM)$/i.test(dept)) {
              return `${dept} ${num}`;
            }
          }
          return undefined;
        };

        const extractSection = (title: string, subtitle?: string): string | undefined => {
          const combined = `${subtitle || ''} ${title}`.trim();

          // 1. Explicit Section keyword: "Sec 10", "Section 2", "Sec. 03", "Period 4"
          const secRegex =
            /\b(?:sec(?:tion)?\.?\s*[-_#:]?\s*([0-9]{1,3}[A-Z]?)|period\s*[-_#:]?\s*([0-9]{1,3}[A-Z]?))\b/i;
          const m = combined.match(secRegex);
          if (m) {
            const num = m[1] || m[2];
            return `Sec ${num}`;
          }

          // 2. Trailing section number e.g. "Autumn-2026-CSE203T-10" or "CSE203-02"
          const trailingRegex = /[-_/\s]([0-9]{1,3}[A-Z]?)$/i;
          const tm = title.match(trailingRegex);
          if (tm && parseInt(tm[1], 10) > 0 && parseInt(tm[1], 10) < 500) {
            return `Sec ${tm[1]}`;
          }

          return undefined;
        };

        const cleanTitle = (raw: string): string => {
          return raw
            .replace(/^open (your work for|options for|folder for|class:?)\s*/i, '')
            .replace(/^options for\s*/i, '')
            .replace(/^class:?\s*/i, '')
            .replace(/\s+/g, ' ')
            .trim();
        };

        const isValidCourseId = (id: string): boolean => {
          return (
            !!id &&
            id.length >= 3 &&
            !/^(u|h|a|w|sp|gb|d|calendar|archive|archived|settings|to-do|to-review|classes)$/i.test(id)
          );
        };

        // --- TIER 1: Card Container DOM Walking ---
        // Find top-level card containers
        const cardContainers = Array.from(
          document.querySelectorAll(
            'ol > li, [role="listitem"], [data-course-id], article, div.gHz6xd, div[class*="CourseCard" i], div[class*="course-card" i]'
          )
        );

        for (const card of cardContainers) {
          // Find anchor tag for this course
          const courseLink = card.querySelector<HTMLAnchorElement>(
            'a[href*="/c/"], a[href*="/r/"]'
          );
          if (!courseLink) continue;

          const href = courseLink.href;
          // Filter out internal assignment or folder links
          if (
            href.includes('/a/') ||
            href.includes('/sp/') ||
            href.includes('/w/') ||
            href.includes('/gb/') ||
            href.includes('/d/') ||
            href.includes('/calendar')
          ) {
            continue;
          }

          const match = href.match(/\/(?:c|r)\/([a-zA-Z0-9_-]+)/);
          if (!match || !isValidCourseId(match[1])) continue;
          const courseId = match[1];

          if (seen.has(courseId)) continue;

          // Discover heading in card
          const headingEl =
            card.querySelector('[role="heading"], h2, h3, h1, [class*="GRvzhf"], [class*="ScpeUc"]') ||
            courseLink.querySelector('[role="heading"], h2, h3, h1');

          let title = headingEl ? cleanTitle(headingEl.textContent || '') : '';

          // Discover subtitle / section element in card
          const subtitleEl = card.querySelector(
            '[class*="DWJNgb"], [class*="FWGURc"], [class*="subtitle" i], [class*="section" i]'
          );
          let subtitle = subtitleEl ? (subtitleEl.textContent || '').trim() : '';

          // Aria-label fallback
          const ariaLabel = cleanTitle(courseLink.getAttribute('aria-label') || '');
          if (!title || title.toLowerCase() === 'home') {
            if (ariaLabel) {
              const parts = ariaLabel.split(',').map((s) => s.trim()).filter(Boolean);
              title = parts[0] || ariaLabel;
              if (parts.length > 1 && !subtitle) {
                subtitle = parts[1];
              }
            }
          }

          if (title && title.toLowerCase() !== 'home') {
            seen.add(courseId);
            const courseCode = extractCode(`${title} ${subtitle}`);
            const section = extractSection(title, subtitle);

            results.push({
              id: courseId,
              name: title,
              section,
              url: href.includes('classroom.google.com')
                ? href
                : `https://classroom.google.com/c/${courseId}`,
              courseCode,
            });
          }
        }

        // --- TIER 2: Semantic Anchor Discovery Fallback ---
        const allCourseLinks = Array.from(
          document.querySelectorAll<HTMLAnchorElement>('a[href*="/c/"], a[href*="/r/"]')
        ).filter((a) => {
          const h = a.href;
          return (
            !h.includes('/a/') &&
            !h.includes('/sp/') &&
            !h.includes('/w/') &&
            !h.includes('/gb/') &&
            !h.includes('/d/') &&
            !h.includes('/calendar') &&
            !h.includes('/settings')
          );
        });

        for (const a of allCourseLinks) {
          const match = a.href.match(/\/(?:c|r)\/([a-zA-Z0-9_-]+)/);
          if (!match || !isValidCourseId(match[1])) continue;
          const courseId = match[1];

          if (seen.has(courseId)) continue;

          // Check heading inside anchor or walk up to closest container
          const headingEl =
            a.querySelector('[role="heading"], h2, h3, [class*="GRvzhf"], [class*="ScpeUc"]') ||
            a.closest('li, [role="listitem"], [data-course-id], article, div')?.querySelector(
              '[role="heading"], h2, h3'
            );

          let title = headingEl ? cleanTitle(headingEl.textContent || '') : '';
          const ariaLabel = cleanTitle(a.getAttribute('aria-label') || '');

          let subtitle = '';
          if (!title || title.toLowerCase() === 'home') {
            if (ariaLabel) {
              const parts = ariaLabel.split(',').map((s) => s.trim()).filter(Boolean);
              title = parts[0] || ariaLabel;
              if (parts.length > 1) {
                subtitle = parts[1];
              }
            }
          }

          // Inspect text-bearing leaf nodes
          if (!title || title.toLowerCase() === 'home') {
            const textNodes = Array.from(a.querySelectorAll('*'))
              .map((el) =>
                el.childNodes.length === 1 && el.childNodes[0].nodeType === 3
                  ? (el.textContent || '').trim()
                  : ''
              )
              .filter(
                (t) =>
                  t.length > 2 &&
                  t !== 'assignment' &&
                  t !== 'more_vert' &&
                  t.toLowerCase() !== 'home'
              );

            if (textNodes.length > 0) {
              title = textNodes[0];
              if (textNodes.length > 1) subtitle = textNodes[1];
            }
          }

          if (!title || title.toLowerCase() === 'home') {
            title = ariaLabel || `Course ${courseId}`;
          }

          seen.add(courseId);
          const courseCode = extractCode(`${title} ${subtitle}`);
          const section = extractSection(title, subtitle);

          results.push({
            id: courseId,
            name: title,
            section,
            url: a.href.includes('classroom.google.com')
              ? a.href
              : `https://classroom.google.com/c/${courseId}`,
            courseCode,
          });
        }

        return results;
      });

      this.log('success', `Found ${courses.length} course(s) on Google Classroom:`);
      for (const c of courses) {
        this.log(
          'info',
          `• ${c.courseCode ? `[${c.courseCode}] ` : ''}"${c.name}"${c.section ? ` (${c.section})` : ''}`
        );
      }

      return courses;
    } catch (error: any) {
      const msg = error?.message || String(error);
      this.log('error', `Failed to scrape Classroom courses: ${msg}`);
      throw error;
    }
  }

  /**
   * Finds the next upcoming scheduled class based on current time and day.
   * Only considers enabled classes that have a configured schedule.
   */
  public getNextScheduledClass(): NextClassInfo | null {
    const now = new Date();
    const currentDay: DayOfWeek = DAY_MAP[now.getDay()];
    const currentTotalMin = now.getHours() * 60 + now.getMinutes();

    const classes = this.store.getClasses();

    let best: NextClassInfo | null = null;
    let bestMinutes = Infinity;

    for (const cls of classes) {
      // Only consider enabled, schedule-configured classes
      if (!cls.enabled) continue;
      if (cls.isScheduleConfigured === false) continue;
      if (cls.needsSchedule) continue;
      if (!cls.days || !Array.isArray(cls.days) || cls.days.length === 0) continue;
      if (!cls.startTime || typeof cls.startTime !== 'string') continue;

      const [startH, startM] = cls.startTime.split(':').map(Number);
      if (isNaN(startH) || isNaN(startM)) continue;
      const startTotalMin = startH * 60 + startM;

      // Check each day of the week for the next occurrence
      for (let dayOffset = 0; dayOffset < 7; dayOffset++) {
        const checkDayIndex = (now.getDay() + dayOffset) % 7;
        const checkDay = DAY_MAP[checkDayIndex];

        if (!cls.days.includes(checkDay)) continue;

        let minutesUntil: number;
        if (dayOffset === 0) {
          // Same day — only count if the start time is still ahead
          minutesUntil = startTotalMin - currentTotalMin;
          if (minutesUntil <= 0) continue; // Already passed today
        } else {
          // Future day
          minutesUntil = dayOffset * 24 * 60 + startTotalMin - currentTotalMin;
        }

        if (minutesUntil < bestMinutes) {
          bestMinutes = minutesUntil;
          best = {
            courseCode: cls.courseCode,
            courseName: cls.courseName,
            startTime: cls.startTime,
            minutesUntil,
          };
        }

        // Only consider the first matching day for this class (the nearest occurrence)
        break;
      }
    }

    return best;
  }

  private sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      if (signal) {
        signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true }
        );
      }
    });
  }
}
