// Main React application component for Class Joiner dashboard, schedule management, and live monitor

import React, { useEffect, useState, useCallback } from 'react';
import {
  Plus,
  ShieldCheck,
  Settings,
  Clock,
  BookOpen,
  X,
  Check,
  MicOff,
  VideoOff,
  RefreshCw,
  CloudDownload,
  AlertTriangle,
  Bell,
  Terminal,
  Sun,
  Moon,
  Info,
  CheckCircle2,
} from 'lucide-react';
import {
  AppSettings,
  BotStatusPayload,
  ClassSchedule,
  DayOfWeek,
  LogEntry,
  NextClassInfo,
} from '../electron/types';
import { ClassCard } from './components/ClassCard';
import { TimePicker } from './components/TimePicker';
import { LiveConsole } from './components/LiveConsole';
import { NonPcModal } from './components/NonPcModal';

export const App: React.FC = () => {
  const [classes, setClasses] = useState<ClassSchedule[]>([]);
  const [settings, setSettings] = useState<AppSettings>({
    scanIntervalSeconds: 30,
    maxScanDurationMinutes: 5,
    alwaysMuteMic: true,
    alwaysTurnOffCam: true,
    isGoogleAuthenticated: false,
  });
  const [botStatus, setBotStatus] = useState<BotStatusPayload>({
    state: 'IDLE',
    activeClassId: null,
    activeClassName: null,
    message: 'Waiting for scheduled class time...',
  });
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [systemTime, setSystemTime] = useState<Date>(new Date());
  const [nextClass, setNextClass] = useState<NextClassInfo | null>(null);
  const [isSyncing, setIsSyncing] = useState(false);

  // Live Terminal Visibility (persisted in localStorage)
  const [isTerminalVisible, setIsTerminalVisible] = useState<boolean>(() => {
    return localStorage.getItem('class_joiner_terminal_visible') !== 'false';
  });

  const toggleTerminal = useCallback(() => {
    setIsTerminalVisible((prev) => {
      const next = !prev;
      localStorage.setItem('class_joiner_terminal_visible', String(next));
      return next;
    });
  }, []);

  // Theme Mode: Light Mode and Dark Mode (persisted in localStorage)
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    return (localStorage.getItem('class_joiner_theme') as 'dark' | 'light') || 'dark';
  });

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('class_joiner_theme', theme);
  }, [theme]);

  const toggleTheme = useCallback(() => {
    setTheme((prev) => (prev === 'dark' ? 'light' : 'dark'));
  }, []);

  // Format countdown into human readable hours and minutes (e.g., "1h 45m" or "45m")
  const formatCountdown = useCallback((totalMinutes: number): string => {
    if (totalMinutes <= 0) return 'Starting now!';
    const days = Math.floor(totalMinutes / (24 * 60));
    const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
    const mins = totalMinutes % 60;

    if (days > 0) {
      if (hours > 0 && mins > 0) return `${days}d ${hours}h ${mins}m`;
      if (hours > 0) return `${days}d ${hours}h`;
      return `${days}d ${mins}m`;
    }
    if (hours > 0) {
      return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
    }
    return `${mins}m`;
  }, []);

  // Modal States
  const [isClassModalOpen, setIsClassModalOpen] = useState(false);
  const [isSettingsModalOpen, setIsSettingsModalOpen] = useState(false);
  const [isSyncModalOpen, setIsSyncModalOpen] = useState(false);

  // Form State for Adding/Editing a Class
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingNeedsSchedule, setEditingNeedsSchedule] = useState(false);
  const [courseCode, setCourseCode] = useState('');
  const [courseName, setCourseName] = useState('');
  const [section, setSection] = useState('');
  const [classroomUrl, setClassroomUrl] = useState('');
  const [days, setDays] = useState<DayOfWeek[]>(['Sun', 'Tue']);
  const [startTime, setStartTime] = useState('09:40');
  const [endTime, setEndTime] = useState('11:10');
  const [autoLeaveAtEnd, setAutoLeaveAtEnd] = useState(false);
  const [formError, setFormError] = useState('');

  // Load initial state & subscribe to Electron IPC events
  useEffect(() => {
    const init = async () => {
      const [loadedClasses, loadedSettings, initialStatus, initialLogs] =
        await Promise.all([
          window.electronAPI.getClasses(),
          window.electronAPI.getSettings(),
          window.electronAPI.getBotStatus(),
          window.electronAPI.getLogs(),
        ]);
      setClasses(loadedClasses);
      setSettings(loadedSettings);
      setBotStatus(initialStatus);
      setLogs(initialLogs);

      // Fetch initial next class info
      const next = await window.electronAPI.getNextClass();
      setNextClass(next);
    };
    void init();

    const unsubStatus = window.electronAPI.onStatusUpdate((s) => setBotStatus(s));
    const unsubLogs = window.electronAPI.onNewLog((log) =>
      setLogs((prev) => [log, ...prev].slice(0, 250))
    );
    const unsubClasses = window.electronAPI.onClassesUpdated((updated) =>
      setClasses(updated)
    );

    const clockInterval = setInterval(() => setSystemTime(new Date()), 1000);

    // Poll for next class info every 10 seconds
    const nextClassInterval = setInterval(async () => {
      try {
        const next = await window.electronAPI.getNextClass();
        setNextClass(next);
      } catch {
        // Silently ignore polling errors
      }
    }, 10000);

    return () => {
      unsubStatus();
      unsubLogs();
      unsubClasses();
      clearInterval(clockInterval);
      clearInterval(nextClassInterval);
    };
  }, []);

  const openAddModal = () => {
    setEditingId(null);
    setEditingNeedsSchedule(false);
    setCourseCode('');
    setCourseName('');
    setSection('Sec 1');
    setClassroomUrl('');
    setDays(['Sun', 'Tue']);
    setStartTime('09:40');
    setEndTime('11:10');
    setAutoLeaveAtEnd(false);
    setFormError('');
    setIsClassModalOpen(true);
  };

  const openEditModal = (cls: ClassSchedule) => {
    setEditingId(cls.id);
    setEditingNeedsSchedule(cls.needsSchedule === true);
    setCourseCode(cls.courseCode);
    setCourseName(cls.courseName);
    setSection(cls.section || '');
    setClassroomUrl(cls.classroomUrl);
    setDays(cls.days && cls.days.length > 0 ? cls.days : ['Sun', 'Tue']);
    setStartTime(cls.startTime || '09:40');
    setEndTime(cls.endTime || '11:10');
    setAutoLeaveAtEnd(cls.autoLeaveAtEnd);
    setFormError('');
    setIsClassModalOpen(true);
  };

  const handleSaveClass = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!courseCode.trim() || !courseName.trim() || !classroomUrl.trim()) {
      setFormError('Please fill in Course Code, Course Name, and Google Classroom URL.');
      return;
    }
    if (days.length === 0) {
      setFormError('Please select at least one day of the week.');
      return;
    }
    if (!/^https?:\/\//i.test(classroomUrl.trim())) {
      setFormError('Classroom URL must start with https://');
      return;
    }

    const existingCls = classes.find((c) => c.id === editingId);

    const payload: ClassSchedule = {
      id: editingId || `class-${Date.now()}`,
      courseCode: courseCode.trim().toUpperCase(),
      courseName: courseName.trim(),
      section: section.trim() || undefined,
      classroomUrl: classroomUrl.trim(),
      googleClassroomId: existingCls?.googleClassroomId,
      days,
      startTime,
      endTime,
      enabled: true,
      autoLeaveAtEnd,
      needsSchedule: false,
      isScheduleConfigured: true,
    };

    const updated = await window.electronAPI.saveClass(payload);
    setClasses(updated);
    setIsClassModalOpen(false);
  };

  const handleDeleteClass = async (id: string) => {
    const updated = await window.electronAPI.deleteClass(id);
    setClasses(updated);
  };

  const handleToggleClass = async (id: string, enabled: boolean) => {
    const updated = await window.electronAPI.toggleClass(id, enabled);
    setClasses(updated);
  };

  const handleTriggerNow = async (id: string) => {
    await window.electronAPI.triggerClassNow(id);
  };

  const handleGoogleLogin = async () => {
    await window.electronAPI.openGoogleLogin();
    const updatedSettings = await window.electronAPI.getSettings();
    setSettings(updatedSettings);
  };

  const handleUpdateSettings = async (partial: Partial<AppSettings>) => {
    const updated = await window.electronAPI.updateSettings(partial);
    setSettings(updated);
  };

  const handleSyncClassroom = useCallback(async () => {
    if (isSyncing) return;
    setIsSyncing(true);
    try {
      const updated = await window.electronAPI.syncClassroom();
      setClasses(updated);
    } catch {
      // Error is surfaced via logs/status
    } finally {
      setIsSyncing(false);
    }
  }, [isSyncing]);

  // Split classes into unconfigured (needs schedule) and configured
  const unconfiguredClasses = classes.filter((cls) => cls.needsSchedule === true);
  const configuredClasses = classes.filter((cls) => cls.needsSchedule !== true);

  return (
    <div className="app-shell">
      {/* Header */}
      <header className="iub-header" role="banner">
        <div className="brand-identity">
          <div className="iub-crest-emblem" title="Classroom Class Joiner" aria-hidden="true">
            <BookOpen size={20} />
          </div>
          <div className="brand-titles">
            <h1>Classroom Class Joiner (Alpha)</h1>
            <p>Classroom & Meet Automation</p>
          </div>
        </div>

        <div className="header-right-controls">
          {/* Live System Clock Pill */}
          <div className="live-clock-pill" aria-label={`Current time: ${systemTime.toLocaleTimeString()}`}>
            <Clock size={15} className="gold-icon" aria-hidden="true" />
            <span className="clock-day">
              {systemTime.toLocaleDateString('en-US', {
                weekday: 'short',
                month: 'short',
                day: 'numeric',
              })}
            </span>
            <span className="clock-divider" aria-hidden="true">|</span>
            <span className="clock-time">
              {systemTime.toLocaleTimeString([], {
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
              })}
            </span>
          </div>

          {/* Persistent Google Login Button */}
          <button
            type="button"
            className={`btn-google-auth ${settings.isGoogleAuthenticated ? 'authenticated' : ''}`}
            onClick={handleGoogleLogin}
            title={settings.isGoogleAuthenticated ? 'Google Session Saved' : 'Login with Google'}
            aria-label={settings.isGoogleAuthenticated ? 'Google Session Active' : 'Login with Google'}
          >
            <ShieldCheck size={16} aria-hidden="true" />
            <span className="btn-text">
              {settings.isGoogleAuthenticated ? 'Google Active' : 'Login Google'}
            </span>
          </button>

          {/* Terminal Hide/Unhide Toggle Button */}
          <button
            type="button"
            className={`btn-header-terminal ${isTerminalVisible ? 'active' : ''}`}
            onClick={toggleTerminal}
            title={isTerminalVisible ? 'Hide Live Terminal' : 'Show Live Terminal'}
            aria-label={isTerminalVisible ? 'Hide Live Terminal' : 'Show Live Terminal'}
            aria-expanded={isTerminalVisible}
          >
            <Terminal size={16} aria-hidden="true" />
            <span className="btn-text">{isTerminalVisible ? 'Hide Terminal' : 'Terminal'}</span>
          </button>

          {/* Light / Dark Mode Toggle Button */}
          <button
            type="button"
            className="btn-header-theme"
            onClick={toggleTheme}
            title={theme === 'dark' ? 'Switch to Light Mode' : 'Switch to Dark Mode'}
            aria-label={theme === 'dark' ? 'Switch to Light Mode' : 'Switch to Dark Mode'}
          >
            {theme === 'dark' ? <Sun size={16} aria-hidden="true" /> : <Moon size={16} aria-hidden="true" />}
            <span className="btn-text">{theme === 'dark' ? 'Light' : 'Dark'}</span>
          </button>

          {/* Engine Settings Button */}
          <button
            type="button"
            className="btn-header-settings"
            onClick={() => setIsSettingsModalOpen(true)}
            title="Automation Engine Settings"
            aria-label="Automation Engine Settings"
          >
            <Settings size={18} aria-hidden="true" />
          </button>
        </div>
      </header>

      {/* Main Content Workspace */}
      <main className={`main-workspace ${!isTerminalVisible ? 'terminal-hidden' : ''}`} role="main">
        {/* Left/Center Column: Scheduled Classes Dashboard */}
        <section className="dashboard-column" aria-label="Course Schedules Dashboard">
          {/* Next Class Countdown Banner */}
          {nextClass && (
            <div className="next-class-banner" role="region" aria-label="Upcoming Scheduled Class">
              <div className="next-class-info">
                <Bell size={20} className="next-class-icon" aria-hidden="true" />
                <div className="next-class-details">
                  <h4>Next: {nextClass.courseCode} — {nextClass.courseName}</h4>
                  <p>Starts at {nextClass.startTime}</p>
                </div>
              </div>
              <div className="next-class-countdown">
                {formatCountdown(nextClass.minutesUntil)}
                <small>until class</small>
              </div>
            </div>
          )}

          <div className="dashboard-toolbar">
            <div className="dashboard-toolbar-info">
              <h2 className="section-heading">Scheduled Courses</h2>
              <p className="section-subheading">
                At class start time, the engine opens your Classroom page, scans for the Meet link every {settings.scanIntervalSeconds}s (up to {settings.maxScanDurationMinutes} mins), mutes Mic/Cam, and joins.
              </p>
            </div>

            <div className="dashboard-buttons">
              <button
                type="button"
                className="btn-sync-classroom"
                onClick={() => setIsSyncModalOpen(true)}
                title="Sync courses from Google Classroom"
                aria-label="Open Google Classroom sync dialog"
              >
                <CloudDownload size={18} className={isSyncing ? 'spinning' : ''} aria-hidden="true" />
                <span>{isSyncing ? 'Syncing...' : 'Sync Classroom'}</span>
              </button>

              <button
                type="button"
                className="btn-add-class"
                onClick={openAddModal}
                aria-label="Add new course schedule"
              >
                <Plus size={18} aria-hidden="true" />
                <span>Add Course</span>
              </button>
            </div>
          </div>

          {/* Active Safety Status Pills */}
          <div className="feature-Guarantee-bar" role="status" aria-label="Automation Status Guardrails">
            <div className="guarantee-pill">
              <MicOff size={14} aria-hidden="true" />
              <span>Auto-Mute Mic: {settings.alwaysMuteMic ? 'ON' : 'OFF'}</span>
            </div>
            <div className="guarantee-pill">
              <VideoOff size={14} aria-hidden="true" />
              <span>Auto-Camera Off: {settings.alwaysTurnOffCam ? 'ON' : 'OFF'}</span>
            </div>
            <div className="guarantee-pill">
              <RefreshCw size={14} aria-hidden="true" />
              <span>
                Scan: Every {settings.scanIntervalSeconds}s for {settings.maxScanDurationMinutes}m
              </span>
            </div>
          </div>

          {/* Unconfigured / Imported Classes Section */}
          {unconfiguredClasses.length > 0 && (
            <div className="unconfigured-section" role="region" aria-label="Imported courses needing schedule">
              <div className="unconfigured-section-header">
                <AlertTriangle size={16} aria-hidden="true" />
                <span>Imported Courses — Set Schedule ({unconfiguredClasses.length})</span>
              </div>
              <div className="unconfigured-grid">
                {unconfiguredClasses.map((cls) => (
                  <ClassCard
                    key={cls.id}
                    cls={cls}
                    isCurrentlyScanning={false}
                    onToggle={handleToggleClass}
                    onTriggerNow={handleTriggerNow}
                    onEdit={openEditModal}
                    onDelete={handleDeleteClass}
                  />
                ))}
              </div>
            </div>
          )}

          {/* Configured Classes */}
          {configuredClasses.length === 0 && unconfiguredClasses.length === 0 ? (
            <div className="empty-dashboard-card">
              <CloudDownload size={42} className="empty-icon" aria-hidden="true" />
              <h3>No Classes Configured Yet</h3>
              <p>
                Sync your classes from Google Classroom to get started, or add a course manually.
              </p>
              <button
                type="button"
                className="btn-sync-classroom"
                onClick={() => setIsSyncModalOpen(true)}
              >
                <CloudDownload size={18} className={isSyncing ? 'spinning' : ''} aria-hidden="true" />
                <span>Sync from Google Classroom</span>
              </button>
            </div>
          ) : configuredClasses.length > 0 ? (
            <div className="classes-grid">
              {configuredClasses.map((cls) => (
                <ClassCard
                  key={cls.id}
                  cls={cls}
                  isCurrentlyScanning={
                    botStatus.activeClassId === cls.id &&
                    botStatus.state !== 'IDLE' &&
                    botStatus.state !== 'ERROR'
                  }
                  onToggle={handleToggleClass}
                  onTriggerNow={handleTriggerNow}
                  onEdit={openEditModal}
                  onDelete={handleDeleteClass}
                />
              ))}
            </div>
          ) : null}
        </section>

        {/* Right Column: Sticky Live Status Monitor & Real-Time Log Console */}
        <div
          className={`console-sidebar-wrapper ${!isTerminalVisible ? 'is-collapsed' : ''}`}
          aria-hidden={!isTerminalVisible}
        >
          <LiveConsole
            status={botStatus}
            logs={logs}
            onClearLogs={() => window.electronAPI.clearLogs().then(() => setLogs([]))}
            onCancelTask={() => window.electronAPI.cancelActiveTask()}
            onHide={() => {
              setIsTerminalVisible(false);
              localStorage.setItem('class_joiner_terminal_visible', 'false');
            }}
          />
        </div>
      </main>

      {/* Mobile Backdrop for Console Sheet */}
      {isTerminalVisible && (
        <div
          className="console-mobile-backdrop"
          onClick={() => {
            setIsTerminalVisible(false);
            localStorage.setItem('class_joiner_terminal_visible', 'false');
          }}
          aria-hidden="true"
        />
      )}

      {/* Floating Console Toggle Button when Terminal is Hidden */}
      {!isTerminalVisible && (
        <button
          type="button"
          className="btn-floating-terminal"
          onClick={() => {
            setIsTerminalVisible(true);
            localStorage.setItem('class_joiner_terminal_visible', 'true');
          }}
          title="Open Live Terminal & Automation Monitor"
          aria-label="Open Live Terminal & Automation Monitor"
        >
          <span className={`pulse-dot-mini ${botStatus.state.toLowerCase()}`} aria-hidden="true" />
          <Terminal size={15} aria-hidden="true" />
          <span>Live Terminal</span>
        </button>
      )}

      {/* ==================== MODAL 1: ADD / EDIT CLASS MODAL ==================== */}
      {isClassModalOpen && (
        <div
          className="modal-backdrop"
          onClick={(e) => {
            if (e.target === e.currentTarget) setIsClassModalOpen(false);
          }}
        >
          <div
            className="modal-window"
            role="dialog"
            aria-modal="true"
            aria-labelledby="class-modal-heading"
          >
            <div className="modal-header">
              <h2 id="class-modal-heading">
                {editingId
                  ? editingNeedsSchedule
                    ? 'Set Course Schedule'
                    : 'Edit Course Schedule'
                  : 'Add New Course Schedule'}
              </h2>
              <button
                type="button"
                className="btn-close-modal"
                onClick={() => setIsClassModalOpen(false)}
                title="Close modal"
                aria-label="Close modal"
              >
                <X size={20} aria-hidden="true" />
              </button>
            </div>

            <form onSubmit={handleSaveClass} className="modal-form-wrapper">
              <div className="modal-body-scroll">
                {formError && <div className="form-error-banner" role="alert">{formError}</div>}

                <div className="form-row-three">
                  <div className="form-group">
                    <label htmlFor="course-code-input">Course Code *</label>
                    <input
                      id="course-code-input"
                      type="text"
                      placeholder="e.g., CSE 203"
                      value={courseCode}
                      onChange={(e) => setCourseCode(e.target.value)}
                      required
                    />
                  </div>
                  <div className="form-group">
                    <label htmlFor="course-title-input">Course Title *</label>
                    <input
                      id="course-title-input"
                      type="text"
                      placeholder="e.g., Data Structures"
                      value={courseName}
                      onChange={(e) => setCourseName(e.target.value)}
                      required
                    />
                  </div>
                  <div className="form-group">
                    <label htmlFor="course-section-input">Section</label>
                    <input
                      id="course-section-input"
                      type="text"
                      placeholder="e.g., Sec 2"
                      value={section}
                      onChange={(e) => setSection(e.target.value)}
                    />
                  </div>
                </div>

                <div className="form-group">
                  <label htmlFor="classroom-url-input">Google Classroom Course URL *</label>
                  <input
                    id="classroom-url-input"
                    type="url"
                    placeholder="https://classroom.google.com/u/0/c/..."
                    value={classroomUrl}
                    onChange={(e) => setClassroomUrl(e.target.value)}
                    required
                  />
                  <small>Paste the full URL to the course homepage in Google Classroom</small>
                </div>

                {/* Dedicated Visual Clock & Day Picker Component */}
                <TimePicker
                  selectedDays={days}
                  onChangeDays={setDays}
                  startTime={startTime}
                  onChangeStartTime={setStartTime}
                  endTime={endTime}
                  onChangeEndTime={setEndTime}
                />

                <div className="form-checkbox-row">
                  <label className="checkbox-label">
                    <input
                      type="checkbox"
                      checked={autoLeaveAtEnd}
                      onChange={(e) => setAutoLeaveAtEnd(e.target.checked)}
                    />
                    <span>
                      Automatically leave Google Meet call when End Time ({endTime}) is reached
                    </span>
                  </label>
                </div>
              </div>

              <div className="modal-footer">
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => setIsClassModalOpen(false)}
                >
                  Cancel
                </button>
                <button type="submit" className="btn-primary-gold">
                  <Check size={17} aria-hidden="true" />
                  <span>
                    {editingId
                      ? editingNeedsSchedule
                        ? 'Save Schedule'
                        : 'Update Schedule'
                      : 'Save Class Schedule'}
                  </span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ==================== MODAL 2: SETTINGS MODAL ==================== */}
      {isSettingsModalOpen && (
        <div
          className="modal-backdrop"
          onClick={(e) => {
            if (e.target === e.currentTarget) setIsSettingsModalOpen(false);
          }}
        >
          <div
            className="modal-window settings-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="settings-modal-heading"
          >
            <div className="modal-header">
              <h2 id="settings-modal-heading">Refresh & Scan Engine Settings</h2>
              <button
                type="button"
                className="btn-close-modal"
                onClick={() => setIsSettingsModalOpen(false)}
                title="Close settings"
                aria-label="Close settings"
              >
                <X size={20} aria-hidden="true" />
              </button>
            </div>

            <div className="modal-body-scroll">
              <div className="form-row-two">
                <div className="form-group">
                  <label htmlFor="scan-interval-input">Auto-Refresh Interval (Seconds)</label>
                  <input
                    id="scan-interval-input"
                    type="number"
                    min={10}
                    max={120}
                    value={settings.scanIntervalSeconds}
                    onChange={(e) =>
                      handleUpdateSettings({
                        scanIntervalSeconds: Number(e.target.value) || 30,
                      })
                    }
                  />
                  <small>Default: 30 seconds between Classroom page reloads</small>
                </div>

                <div className="form-group">
                  <label htmlFor="max-scan-duration-input">Maximum Scan Window (Minutes)</label>
                  <input
                    id="max-scan-duration-input"
                    type="number"
                    min={1}
                    max={30}
                    value={settings.maxScanDurationMinutes}
                    onChange={(e) =>
                      handleUpdateSettings({
                        maxScanDurationMinutes: Number(e.target.value) || 5,
                      })
                    }
                  />
                  <small>Default: 5 minutes total retry window after class starts</small>
                </div>
              </div>

              <div className="form-checkbox-row">
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={settings.alwaysMuteMic}
                    onChange={(e) =>
                      handleUpdateSettings({ alwaysMuteMic: e.target.checked })
                    }
                  />
                  <span>Always mute Microphone before clicking "Join now"</span>
                </label>
              </div>

              <div className="form-checkbox-row">
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={settings.alwaysTurnOffCam}
                    onChange={(e) =>
                      handleUpdateSettings({ alwaysTurnOffCam: e.target.checked })
                    }
                  />
                  <span>Always turn off Camera before clicking "Join now"</span>
                </label>
              </div>
            </div>

            <div className="modal-footer">
              <button
                type="button"
                className="btn-primary-gold"
                onClick={() => setIsSettingsModalOpen(false)}
              >
                <Check size={16} aria-hidden="true" />
                <span>Done</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ==================== MODAL 3: SYNC COURSES MODAL ==================== */}
      {isSyncModalOpen && (
        <div
          className="modal-backdrop"
          onClick={(e) => {
            if (e.target === e.currentTarget) setIsSyncModalOpen(false);
          }}
        >
          <div
            className="modal-window sync-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="sync-modal-heading"
          >
            <div className="modal-header">
              <h2 id="sync-modal-heading">Sync with Google Classroom</h2>
              <button
                type="button"
                className="btn-close-modal"
                onClick={() => setIsSyncModalOpen(false)}
                title="Close sync dialog"
                aria-label="Close sync dialog"
              >
                <X size={20} aria-hidden="true" />
              </button>
            </div>

            <div className="modal-body-scroll">
              <div className="sync-explanation-box">
                <div className="sync-icon-badge">
                  <CloudDownload size={28} />
                </div>
                <div className="sync-text-group">
                  <h4>Automated Classroom Course Discovery</h4>
                  <p>
                    The automation engine launches a background browser session to read your enrolled courses directly from Google Classroom, extracting course names, codes, and homepage URLs.
                  </p>
                </div>
              </div>

              {/* Google Session Check */}
              <div className={`sync-status-card ${settings.isGoogleAuthenticated ? 'connected' : 'needs-auth'}`}>
                <div className="sync-status-info">
                  {settings.isGoogleAuthenticated ? (
                    <CheckCircle2 size={18} className="sync-check-icon" />
                  ) : (
                    <AlertTriangle size={18} className="sync-warn-icon" />
                  )}
                  <div>
                    <strong>
                      {settings.isGoogleAuthenticated
                        ? 'Google Account Connected'
                        : 'Google Login Required'}
                    </strong>
                    <p>
                      {settings.isGoogleAuthenticated
                        ? 'Your Google browser profile is saved and ready for course extraction.'
                        : 'Sign in to Google first so the browser can view your Classroom courses.'}
                    </p>
                  </div>
                </div>

                {!settings.isGoogleAuthenticated && (
                  <button
                    type="button"
                    className="btn-google-auth"
                    onClick={handleGoogleLogin}
                  >
                    <ShieldCheck size={15} />
                    <span>Login with Google</span>
                  </button>
                )}
              </div>

              {/* Live Sync Status indicator */}
              {isSyncing && (
                <div className="sync-in-progress-card">
                  <RefreshCw size={22} className="spinning sync-spin-icon" />
                  <div>
                    <strong>Syncing Courses in Background...</strong>
                    <p>{botStatus.message || 'Connecting to Google Classroom...'}</p>
                  </div>
                </div>
              )}

              {/* Sync Tips & Advice */}
              <div className="sync-tips-list">
                <div className="sync-tip-item">
                  <Info size={15} className="tip-icon" />
                  <span>
                    Imported courses appear under <em>"Imported Courses — Set Schedule"</em> where you can assign their class days and start times.
                  </span>
                </div>
                <div className="sync-tip-item">
                  <Info size={15} className="tip-icon" />
                  <span>
                    Existing courses with schedules already configured will not be overwritten or deleted.
                  </span>
                </div>
              </div>
            </div>

            <div className="modal-footer">
              <button
                type="button"
                className="btn-secondary"
                onClick={() => setIsSyncModalOpen(false)}
              >
                Close
              </button>
              <button
                type="button"
                className="btn-primary-gold"
                onClick={handleSyncClassroom}
                disabled={isSyncing}
              >
                <CloudDownload size={17} className={isSyncing ? 'spinning' : ''} aria-hidden="true" />
                <span>{isSyncing ? 'Syncing Courses...' : 'Start Classroom Sync'}</span>
              </button>
            </div>
          </div>
        </div>
      )}
      {/* Mobile / Non-PC Device Guidance Alert Popup */}
      <NonPcModal />
    </div>
  );
};
