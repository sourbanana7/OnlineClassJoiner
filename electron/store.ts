import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { AppSettings, ClassSchedule, WindowBounds } from './types';

interface PersistedData {
  classes: ClassSchedule[];
  settings: AppSettings;
  windowBounds?: WindowBounds;
}

const DEFAULT_DATA: PersistedData = {
  classes: [],
  settings: {
    scanIntervalSeconds: 30,
    maxScanDurationMinutes: 5,
    alwaysMuteMic: true,
    alwaysTurnOffCam: true,
    isGoogleAuthenticated: false,
  },
};

export class ConfigStore {
  private filePath: string;
  private data: PersistedData;

  constructor() {
    const userDataDir = app.getPath('userData');
    if (!fs.existsSync(userDataDir)) {
      fs.mkdirSync(userDataDir, { recursive: true });
    }
    this.filePath = path.join(userDataDir, 'iub-class-joiner-config.json');
    this.data = this.load();
  }

  private load(): PersistedData {
    const tryParse = (targetPath: string): PersistedData | null => {
      try {
        if (fs.existsSync(targetPath)) {
          const raw = fs.readFileSync(targetPath, 'utf-8').trim();
          if (raw) {
            const parsed = JSON.parse(raw) as Partial<PersistedData>;
            return {
              classes: Array.isArray(parsed.classes) ? parsed.classes : DEFAULT_DATA.classes,
              settings: { ...DEFAULT_DATA.settings, ...(parsed.settings || {}) },
              windowBounds: parsed.windowBounds,
            };
          }
        }
      } catch (err) {
        console.warn(`[ConfigStore] Error reading file ${targetPath}:`, err);
      }
      return null;
    };

    // 1. Try reading primary config file
    const primary = tryParse(this.filePath);
    if (primary) {
      return primary;
    }

    // 2. Fallback to backup file if primary was damaged or empty
    const backupPath = `${this.filePath}.bak`;
    const backup = tryParse(backupPath);
    if (backup) {
      console.warn('[ConfigStore] Restored configuration from backup file.');
      return backup;
    }

    return JSON.parse(JSON.stringify(DEFAULT_DATA));
  }

  /**
   * Atomically writes persisted configuration with safe temporary file swapping,
   * backup snapshotting, and Windows file-handle collision recovery.
   */
  private persist(): void {
    try {
      const dataStr = JSON.stringify(this.data, null, 2);
      const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
      const backupPath = `${this.filePath}.bak`;

      // 1. Synchronously write complete JSON to temp file
      fs.writeFileSync(tempPath, dataStr, 'utf-8');

      // 2. Maintain a backup copy of current valid file
      if (fs.existsSync(this.filePath)) {
        try {
          fs.copyFileSync(this.filePath, backupPath);
        } catch {
          // Non-critical if backup write is momentarily skipped
        }
      }

      // 3. Atomically replace target file (with retry for Windows locking)
      let replaced = false;
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          fs.renameSync(tempPath, this.filePath);
          replaced = true;
          break;
        } catch {
          try {
            fs.copyFileSync(tempPath, this.filePath);
            try {
              fs.unlinkSync(tempPath);
            } catch {}
            replaced = true;
            break;
          } catch {
            const waitMs = 20 * (attempt + 1);
            const start = Date.now();
            while (Date.now() - start < waitMs) {
              /* synchronous micro-wait */
            }
          }
        }
      }

      if (!replaced) {
        console.error('[ConfigStore] Failed to atomically persist config file after retries.');
      }
    } catch (error) {
      console.error('[ConfigStore] Failed to write config file:', error);
    }
  }

  public getClasses(): ClassSchedule[] {
    return this.data.classes;
  }

  public saveClass(item: ClassSchedule): ClassSchedule[] {
    const index = this.data.classes.findIndex((c) => c.id === item.id);
    if (index >= 0) {
      this.data.classes[index] = { ...item };
    } else {
      this.data.classes.push({ ...item });
    }
    this.persist();
    return this.data.classes;
  }

  public deleteClass(id: string): ClassSchedule[] {
    this.data.classes = this.data.classes.filter((c) => c.id !== id);
    this.persist();
    return this.data.classes;
  }

  public toggleClass(id: string, enabled: boolean): ClassSchedule[] {
    const target = this.data.classes.find((c) => c.id === id);
    if (target) {
      target.enabled = enabled;
      this.persist();
    }
    return this.data.classes;
  }

  public markClassJoinedToday(id: string, dateStr: string): ClassSchedule[] {
    const target = this.data.classes.find((c) => c.id === id);
    if (target) {
      target.lastJoinedDate = dateStr;
      this.persist();
    }
    return this.data.classes;
  }

  /**
   * Saves multiple classes at once, inserting new ones and updating existing ones by ID.
   */
  public bulkSaveClasses(classes: ClassSchedule[]): ClassSchedule[] {
    for (const item of classes) {
      const index = this.data.classes.findIndex((c) => c.id === item.id);
      if (index >= 0) {
        this.data.classes[index] = { ...item };
      } else {
        this.data.classes.push({ ...item });
      }
    }
    this.persist();
    return this.data.classes;
  }

  public getSettings(): AppSettings {
    return this.data.settings;
  }

  public updateSettings(partial: Partial<AppSettings>): AppSettings {
    this.data.settings = { ...this.data.settings, ...partial };
    this.persist();
    return this.data.settings;
  }

  public getWindowBounds(): WindowBounds | undefined {
    return this.data.windowBounds;
  }

  public saveWindowBounds(bounds: WindowBounds): void {
    this.data.windowBounds = bounds;
    this.persist();
  }

  public getProfileDirectory(): string {
    const profileDir = path.join(app.getPath('userData'), 'iub-chrome-profile');
    if (!fs.existsSync(profileDir)) {
      fs.mkdirSync(profileDir, { recursive: true });
    }
    return profileDir;
  }
}
