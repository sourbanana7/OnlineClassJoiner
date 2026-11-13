// Main Electron process coordinating window lifecycle, IPC handlers, scheduler, and Google Classroom automation

import { app, BrowserWindow, ipcMain, Notification, screen } from 'electron';
import * as path from 'path';
import { ConfigStore } from './store';
import { AutomationEngine } from './automation';
import { ClassScheduler, parseTimeTo24H } from './scheduler';
import { AppSettings, ClassSchedule, ImportedCourse, LogLevel, WindowBounds } from './types';

let mainWindow: BrowserWindow | null = null;
let store: ConfigStore;
let engine: AutomationEngine;
let scheduler: ClassScheduler;
let saveBoundsTimeout: NodeJS.Timeout | null = null;

const DEFAULT_WIDTH = 1200;
const DEFAULT_HEIGHT = 750;
const MIN_WIDTH = 800;
const MIN_HEIGHT = 560;

/**
 * Safely sends an IPC event to the renderer process, guarding against destroyed instances.
 */
function safeSendToRenderer(channel: string, ...args: any[]): void {
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
    try {
      mainWindow.webContents.send(channel, ...args);
    } catch (err) {
      console.warn(`[IPC] Failed to send on channel "${channel}":`, err);
    }
  }
}

/**
 * Validates saved bounds against active display work areas to avoid off-screen placement.
 */
function getSafeWindowBounds(saved?: WindowBounds): {
  x?: number;
  y?: number;
  width: number;
  height: number;
  isMaximized?: boolean;
} {
  if (!saved) {
    return { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT };
  }

  const width = Math.max(MIN_WIDTH, saved.width || DEFAULT_WIDTH);
  const height = Math.max(MIN_HEIGHT, saved.height || DEFAULT_HEIGHT);

  // If coordinates were saved, verify they are visible on an active monitor
  if (typeof saved.x === 'number' && typeof saved.y === 'number') {
    const displays = screen.getAllDisplays();
    const isVisibleOnAnyDisplay = displays.some((d) => {
      const { x, y, width: dW, height: dH } = d.workArea;
      return (
        saved.x! + width >= x + 100 &&
        saved.x! <= x + dW - 100 &&
        saved.y! + height >= y + 100 &&
        saved.y! <= y + dH - 100
      );
    });

    if (isVisibleOnAnyDisplay) {
      return { x: saved.x, y: saved.y, width, height, isMaximized: saved.isMaximized };
    }
  }

  return { width, height, isMaximized: saved.isMaximized };
}

function saveCurrentWindowBounds(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  const isMaximized = mainWindow.isMaximized();
  if (isMaximized) {
    const prev = store.getWindowBounds();
    store.saveWindowBounds({
      x: prev?.x,
      y: prev?.y,
      width: prev?.width || DEFAULT_WIDTH,
      height: prev?.height || DEFAULT_HEIGHT,
      isMaximized: true,
    });
  } else {
    const b = mainWindow.getBounds();
    store.saveWindowBounds({
      x: b.x,
      y: b.y,
      width: b.width,
      height: b.height,
      isMaximized: false,
    });
  }
}

function debouncedSaveBounds(): void {
  if (saveBoundsTimeout) {
    clearTimeout(saveBoundsTimeout);
  }
  saveBoundsTimeout = setTimeout(saveCurrentWindowBounds, 400);
}

function createWindow(): void {
  const initialBounds = getSafeWindowBounds(store.getWindowBounds());

  mainWindow = new BrowserWindow({
    x: initialBounds.x,
    y: initialBounds.y,
    width: initialBounds.width,
    height: initialBounds.height,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    title: 'Classroom Class Joiner (Alpha) — Classroom & Meet Automation',
    backgroundColor: '#09090D',
    autoHideMenuBar: true,
    show: false, // Prevents layout pop while sizing/restoring
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  if (devServerUrl) {
    void mainWindow.loadURL(devServerUrl);
  } else {
    void mainWindow.loadFile(path.join(__dirname, '../../dist/index.html'));
  }

  mainWindow.once('ready-to-show', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (initialBounds.isMaximized) {
        mainWindow.maximize();
      }
      mainWindow.show();
    }
  });

  // Track window resizing and movement to persist bounds
  mainWindow.on('resize', debouncedSaveBounds);
  mainWindow.on('move', debouncedSaveBounds);

  mainWindow.on('close', () => {
    if (saveBoundsTimeout) {
      clearTimeout(saveBoundsTimeout);
      saveBoundsTimeout = null;
    }
    saveCurrentWindowBounds();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

export function showSystemNotification(title: string, body: string): void {
  if (Notification.isSupported()) {
    new Notification({
      title,
      body,
    }).show();
  }
}

app.whenReady().then(() => {
  store = new ConfigStore();

  engine = new AutomationEngine(
    store,
    (status) => {
      safeSendToRenderer('bot:statusUpdate', status);
    },
    (log) => {
      safeSendToRenderer('logs:new', log);
    }
  );

  scheduler = new ClassScheduler(
    store,
    engine,
    (updatedClasses) => {
      safeSendToRenderer('classes:updated', updatedClasses);
    },
    (title, body) => {
      showSystemNotification(title, body);
    }
  );

  // Window Controls IPC Handlers
  ipcMain.handle('window:minimize', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.minimize();
    }
  });

  ipcMain.handle('window:maximize', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMaximized()) {
        mainWindow.unmaximize();
      } else {
        mainWindow.maximize();
      }
    }
  });

  ipcMain.handle('window:close', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.close();
    }
  });

  ipcMain.handle('window:isMaximized', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      return mainWindow.isMaximized();
    }
    return false;
  });

  // Core Classes IPC Handlers
  ipcMain.handle('classes:get', () => store.getClasses());

  ipcMain.handle('classes:save', (_event, cls: ClassSchedule) => {
    // Normalize times if possible before saving
    const parsedStart = parseTimeTo24H(cls.startTime);
    const parsedEnd = parseTimeTo24H(cls.endTime);
    const normalizedClass: ClassSchedule = {
      ...cls,
      startTime: parsedStart ? parsedStart.hhmm : cls.startTime,
      endTime: parsedEnd ? parsedEnd.hhmm : cls.endTime,
    };

    const updated = store.saveClass(normalizedClass);
    engine.log(
      'info',
      `Saved schedule for ${normalizedClass.courseCode} (${normalizedClass.days.join(', ')} @ ${normalizedClass.startTime})`,
      normalizedClass.courseCode
    );
    safeSendToRenderer('classes:updated', updated);
    return updated;
  });

  ipcMain.handle('classes:delete', (_event, id: string) => {
    const target = store.getClasses().find((c) => c.id === id);
    const updated = store.deleteClass(id);
    if (target) {
      engine.log('warn', `Deleted course schedule: ${target.courseCode}`, target.courseCode);
    }
    safeSendToRenderer('classes:updated', updated);
    return updated;
  });

  ipcMain.handle('classes:toggle', (_event, id: string, enabled: boolean) => {
    const updated = store.toggleClass(id, enabled);
    const target = updated.find((c) => c.id === id);
    if (target) {
      engine.log(
        'info',
        `${enabled ? 'Enabled' : 'Paused'} auto-join for ${target.courseCode}`,
        target.courseCode
      );
    }
    safeSendToRenderer('classes:updated', updated);
    return updated;
  });

  // Settings IPC Handlers
  ipcMain.handle('settings:get', () => store.getSettings());

  ipcMain.handle('settings:update', (_event, partial: Partial<AppSettings>) => {
    const updated = store.updateSettings(partial);
    engine.log('info', 'Updated automation preferences.');
    return updated;
  });

  // Auth & Bot Control IPC Handlers
  ipcMain.handle('auth:login', async () => {
    await engine.openGoogleAuthentication();
  });

  ipcMain.handle('bot:triggerNow', async (_event, id: string) => {
    const cls = store.getClasses().find((c) => c.id === id);
    if (cls) {
      void engine.runClassJoinWorkflow(cls).catch((err) => {
        engine.log('error', `Error launching ${cls.courseCode}: ${err?.message || err}`, cls.courseCode);
      });
    }
  });

  ipcMain.handle('bot:cancel', async () => {
    await engine.cancelActiveTask();
  });

  ipcMain.handle('bot:getStatus', () => engine.getStatus());

  // Console Logs IPC Handlers
  ipcMain.handle('logs:get', () => engine.getLogs());
  ipcMain.handle('logs:clear', () => engine.clearLogs());
  ipcMain.handle('logs:add', (_event, level: LogLevel, message: string, courseCode?: string) => {
    engine.log(level, message, courseCode);
    return engine.getLogs();
  });

  // Google Classroom Integration Handlers
  ipcMain.handle('classroom:fetchCourses', async () => {
    return engine.scrapeClassroomCourses();
  });

  ipcMain.handle('classroom:sync', async () => {
    engine.log('info', 'Starting Google Classroom course sync...');
    try {
      const courses: ImportedCourse[] = await engine.scrapeClassroomCourses();
      const existingClasses = store.getClasses();
      const existingMap = new Map<string, ClassSchedule>();

      for (const cls of existingClasses) {
        if (cls.googleClassroomId) {
          existingMap.set(cls.googleClassroomId, cls);
        } else {
          const match = cls.classroomUrl.match(/\/c\/([a-zA-Z0-9_-]+)/);
          if (match) {
            existingMap.set(match[1], cls);
          }
        }
      }

      const mergedClasses: ClassSchedule[] = [...existingClasses];
      let importedCount = 0;
      let updatedCount = 0;

      for (const course of courses) {
        const existing = existingMap.get(course.id);
        if (existing) {
          if (
            course.name &&
            (existing.courseName === 'Home' ||
              !existing.courseName ||
              existing.courseName.startsWith('Course ') ||
              course.name !== existing.courseName)
          ) {
            existing.courseName = course.name;
          }
          if (
            course.courseCode &&
            (!existing.courseCode ||
              existing.courseCode === 'HOME' ||
              existing.courseCode.startsWith('AUTUMN') ||
              existing.courseCode.startsWith('COURSE'))
          ) {
            existing.courseCode = course.courseCode;
          }
          if (course.section) {
            existing.section = course.section;
          }
          existing.classroomUrl = course.url;
          existing.googleClassroomId = course.id;
          updatedCount++;
        } else {
          let inferredCode = course.courseCode;
          if (!inferredCode) {
            const codeMatch = course.name.match(/\b([A-Z]{2,5})\s*[-_]?\s*([0-9]{3}[A-Z]?)\b/i);
            inferredCode = codeMatch
              ? `${codeMatch[1].toUpperCase()} ${codeMatch[2].toUpperCase()}`
              : course.name.length <= 10
              ? course.name.trim().toUpperCase()
              : course.name.slice(0, 8).trim().toUpperCase();
          }

          const newClass: ClassSchedule = {
            id: `classroom-${course.id}`,
            courseCode: inferredCode,
            courseName: course.name,
            section: course.section,
            classroomUrl: course.url,
            googleClassroomId: course.id,
            days: ['Sun', 'Tue'],
            startTime: '09:40',
            endTime: '11:10',
            enabled: true,
            autoLeaveAtEnd: false,
            needsSchedule: true,
            isScheduleConfigured: false,
          };
          mergedClasses.push(newClass);
          importedCount++;
        }
      }

      store.bulkSaveClasses(mergedClasses);
      const allUpdated = store.getClasses();

      engine.log(
        'success',
        `Classroom sync finished: ${importedCount} new course(s) imported, ${updatedCount} existing course(s) updated.`
      );

      safeSendToRenderer('classes:updated', allUpdated);
      return allUpdated;
    } catch (error: any) {
      const msg = error?.message || String(error);
      engine.log('error', `Classroom sync encountered an error: ${msg}`);
      throw error;
    }
  });

  ipcMain.handle('bot:getNextClass', () => {
    return ClassScheduler.calculateNextClass(store.getClasses()) || engine.getNextScheduledClass();
  });

  createWindow();
  scheduler.start();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (scheduler) scheduler.stop();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
