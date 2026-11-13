import React, { useState, useEffect } from 'react';
import { Monitor, Smartphone, Copy, Check, AlertTriangle, ArrowRight } from 'lucide-react';

export const NonPcModal: React.FC = () => {
  const [isOpen, setIsOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    // Detect non-PC devices (phones, tablets, mobile browsers)
    const checkDevice = () => {
      if (typeof window === 'undefined') return;

      // If running inside Electron desktop app, do not display alert
      const isElectron =
        navigator.userAgent.toLowerCase().includes('electron') ||
        !!(window as unknown as { electronAPI?: { isElectron?: boolean } }).electronAPI?.isElectron;

      if (isElectron) return;

      const ua = navigator.userAgent || '';
      const mobileRegex = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobile|Silk|Kindle/i;
      const isMobileUA = mobileRegex.test(ua);
      const isIPad = navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
      const isTouchSmallScreen =
        ('ontouchstart' in window || navigator.maxTouchPoints > 0) &&
        (window.innerWidth <= 840 || window.innerHeight <= 520);

      // Check if user already dismissed in this session
      const dismissed = sessionStorage.getItem('ccj_non_pc_alert_dismissed');

      if ((isMobileUA || isIPad || isTouchSmallScreen) && !dismissed) {
        setIsOpen(true);
      }
    };

    checkDevice();
  }, []);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      // Fallback for older mobile browsers
      const textArea = document.createElement('textarea');
      textArea.value = window.location.href;
      textArea.style.position = 'fixed';
      textArea.style.opacity = '0';
      document.body.appendChild(textArea);
      textArea.focus();
      textArea.select();
      try {
        document.execCommand('copy');
        setCopied(true);
        setTimeout(() => setCopied(false), 2500);
      } catch {
        // Ignored
      }
      document.body.removeChild(textArea);
    }
  };

  const handleDismiss = () => {
    sessionStorage.setItem('ccj_non_pc_alert_dismissed', 'true');
    setIsOpen(false);
  };

  if (!isOpen) return null;

  return (
    <div
      className="modal-backdrop non-pc-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="non-pc-title"
    >
      <div className="modal-card non-pc-card">
        <div className="non-pc-header-visual">
          <div className="device-icon-compare">
            <div className="device-chip mobile-chip" title="Mobile Phones & Tablets Not Supported">
              <Smartphone size={26} className="mobile-icon" />
              <span className="unsupported-cross" aria-hidden="true">✕</span>
            </div>
            <ArrowRight size={22} className="arrow-transfer" aria-hidden="true" />
            <div className="device-chip pc-chip" title="PC & Desktop Supported">
              <Monitor size={32} className="pc-icon" />
              <span className="supported-check" aria-hidden="true">✓</span>
            </div>
          </div>
        </div>

        <div className="non-pc-body">
          <div className="non-pc-badge-wrapper">
            <span className="non-pc-pill-badge">
              <AlertTriangle size={13} /> PC / Desktop Required
            </span>
          </div>

          <h2 id="non-pc-title">Please Join from a PC</h2>

          <p className="non-pc-description">
            <strong>Automated Class Joiner</strong> is designed exclusively for <strong>desktop computers</strong>. Automated Google Classroom syncing, Google Meet joining, mic/camera controls, and instructor voice alarms require a desktop environment (Windows, macOS, or Linux).
          </p>

          <p className="non-pc-subtext">
            Mobile phone and tablet browsers cannot run background automation. Please copy this link and open it on your PC.
          </p>

          <div className="non-pc-url-box">
            <span className="url-preview">{typeof window !== 'undefined' ? window.location.href : ''}</span>
            <button
              type="button"
              className={`btn-copy-url ${copied ? 'copied' : ''}`}
              onClick={handleCopy}
              aria-label="Copy link to open on PC"
            >
              {copied ? (
                <>
                  <Check size={16} aria-hidden="true" />
                  <span>Copied!</span>
                </>
              ) : (
                <>
                  <Copy size={16} aria-hidden="true" />
                  <span>Copy Link</span>
                </>
              )}
            </button>
          </div>
        </div>

        <div className="non-pc-footer">
          <button
            type="button"
            className="btn-continue-preview"
            onClick={handleDismiss}
          >
            I understand, continue in preview
          </button>
        </div>
      </div>
    </div>
  );
};
