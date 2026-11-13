import React from 'react';
import {
  Terminal,
  Trash2,
  Radio,
  StopCircle,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Info,
  PanelRightClose,
} from 'lucide-react';
import { BotStatusPayload, LogEntry } from '../../electron/types';

interface LiveConsoleProps {
  status: BotStatusPayload;
  logs: LogEntry[];
  onClearLogs: () => void;
  onCancelTask: () => void;
  onHide?: () => void;
}

export const LiveConsole: React.FC<LiveConsoleProps> = ({
  status,
  logs,
  onClearLogs,
  onCancelTask,
  onHide,
}) => {
  const isBusy =
    status.state === 'SCANNING_CLASSROOM' ||
    status.state === 'WAITING_RETRY' ||
    status.state === 'JOINING_MEET' ||
    status.state === 'SYNCING_CLASSROOM';

  const getLogIcon = (level: LogEntry['level']) => {
    switch (level) {
      case 'success':
        return <CheckCircle2 size={14} className="log-icon success" aria-hidden="true" />;
      case 'warn':
        return <AlertTriangle size={14} className="log-icon warn" aria-hidden="true" />;
      case 'error':
        return <XCircle size={14} className="log-icon error" aria-hidden="true" />;
      default:
        return <Info size={14} className="log-icon info" aria-hidden="true" />;
    }
  };

  return (
    <aside className="live-console-panel" aria-label="Live Automation Terminal">
      {/* Real-time Status Monitor Banner */}
      <div className={`status-monitor-card state-${status.state.toLowerCase()}`}>
        <div className="status-monitor-header">
          <div className="status-indicator-group">
            <span className={`pulse-dot ${status.state.toLowerCase()}`} aria-hidden="true" />
            <span className="status-state-badge">{status.state.replace(/_/g, ' ')}</span>
          </div>

          <div className="status-monitor-actions">
            {isBusy && (
              <button
                type="button"
                className="btn-stop-scan"
                onClick={onCancelTask}
                aria-label="Stop current automated task"
              >
                <StopCircle size={14} aria-hidden="true" />
                <span>Stop</span>
              </button>
            )}
            {onHide && (
              <button
                type="button"
                className="btn-hide-console-top"
                onClick={onHide}
                title="Hide Live Terminal"
                aria-label="Hide Live Terminal"
              >
                <PanelRightClose size={15} aria-hidden="true" />
              </button>
            )}
          </div>
        </div>

        {status.activeClassName && (
          <div className="status-active-course" title={status.activeClassName}>
            {status.activeClassName}
          </div>
        )}

        <p className="status-live-message">{status.message}</p>

        {status.attempt && status.maxAttempts && (
          <div className="status-progress-wrapper" aria-label={`Scan progress: attempt ${status.attempt} of ${status.maxAttempts}`}>
            <div className="status-progress-labels">
              <span>
                Attempt {status.attempt} / {status.maxAttempts}
              </span>
              {status.nextRetryInSeconds !== undefined && (
                <span>Next in {status.nextRetryInSeconds}s</span>
              )}
            </div>
            <div className="status-progress-bar">
              <div
                className="status-progress-fill"
                style={{
                  width: `${Math.min(100, (status.attempt / status.maxAttempts) * 100)}%`,
                }}
              />
            </div>
          </div>
        )}
      </div>

      {/* Live Event Stream Console */}
      <div className="console-stream-box">
        <div className="console-header">
          <div className="console-title">
            <Terminal size={15} aria-hidden="true" />
            <span>Live Automation Log</span>
          </div>
          <div className="console-header-actions">
            <button
              type="button"
              className="btn-clear-console"
              onClick={onClearLogs}
              title="Clear Console Logs"
              aria-label="Clear Console Logs"
            >
              <Trash2 size={13} aria-hidden="true" />
              <span>Clear</span>
            </button>
            {onHide && (
              <button
                type="button"
                className="btn-hide-console"
                onClick={onHide}
                title="Hide Live Terminal"
                aria-label="Hide Live Terminal"
              >
                <PanelRightClose size={14} aria-hidden="true" />
              </button>
            )}
          </div>
        </div>

        <div className="console-entries-list" role="log" aria-live="polite">
          {logs.length === 0 ? (
            <div className="console-empty-state">
              <Radio size={24} aria-hidden="true" />
              <span>Monitoring schedule in background...</span>
            </div>
          ) : (
            logs.map((entry) => (
              <div key={entry.id} className={`console-log-item ${entry.level}`}>
                <div className="log-meta">
                  {getLogIcon(entry.level)}
                  <span className="log-time">{entry.timestamp}</span>
                  {entry.courseCode && (
                    <span className="log-course-tag">{entry.courseCode}</span>
                  )}
                </div>
                <div className="log-text">{entry.message}</div>
              </div>
            ))
          )}
        </div>
      </div>
    </aside>
  );
};
