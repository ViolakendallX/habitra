import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';

import { useNotifications } from '../context/NotificationContext';
import { primeNotificationSound } from '../lib/sound';

/**
 * The notification bell in the navbar.
 *
 * It renders nothing but what NotificationContext already computed: a count,
 * a dropdown list, a per-item dismiss and a "clear all". Opening the panel
 * refreshes the list, so it is never showing stale data.
 *
 * Accessibility: the trigger is a real button with `aria-expanded`, the panel
 * is a labelled dialog, and it closes on Escape or on a click outside.
 */

export default function NotificationBell() {
  const { notifications, unreadCount, enabled, dismiss, dismissAll, refresh } =
    useNotifications();

  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false);
    }

    function handlePointerDown(event: MouseEvent) {
      if (!containerRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    }

    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('mousedown', handlePointerDown);

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('mousedown', handlePointerDown);
    };
  }, [open]);

  function toggle() {
    const next = !open;

    // Opening is a user gesture, so it is the safe moment to let the browser
    // allow audio and to re-read the data.
    if (next) {
      primeNotificationSound();
      void refresh();
    }

    setOpen(next);
  }

  return (
    <div className="notifications" ref={containerRef}>
      <button
        type="button"
        className="notifications__bell"
        aria-label={
          unreadCount > 0 ? `Notifications, ${unreadCount} unread` : 'Notifications'
        }
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={toggle}
      >
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
          <path
            d="M12 3a6 6 0 0 0-6 6v3.4L4.4 15a1 1 0 0 0 .9 1.5h13.4A1 1 0 0 0 19.6 15L18 12.4V9a6 6 0 0 0-6-6Z"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinejoin="round"
          />
          <path
            d="M9.6 19a2.5 2.5 0 0 0 4.8 0"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
          />
        </svg>

        {enabled && unreadCount > 0 && (
          <span className="notifications__badge">{unreadCount > 9 ? '9+' : unreadCount}</span>
        )}
      </button>

      {open && (
        <div className="notifications__panel" role="dialog" aria-label="Notifications">
          <div className="notifications__head">
            <h2 className="notifications__title">Notifications</h2>
            {enabled && notifications.length > 0 && (
              <button type="button" className="btn btn--ghost" onClick={dismissAll}>
                Clear all
              </button>
            )}
          </div>

          {!enabled && (
            <p className="notifications__empty">
              Notifications are turned off. Turn them back on in Settings.
            </p>
          )}

          {enabled && notifications.length === 0 && (
            <p className="notifications__empty">You are all caught up.</p>
          )}

          {enabled && notifications.length > 0 && (
            <ul className="notifications__list">
              {notifications.map((item) => (
                <li
                  key={item.id}
                  className={`notifications__item notifications__item--${item.severity}`}
                >
                  <div className="notifications__item-head">
                    <h3 className="notifications__item-title">{item.title}</h3>
                    <button
                      type="button"
                      className="notifications__dismiss"
                      aria-label={`Dismiss: ${item.title}`}
                      onClick={() => dismiss(item.id)}
                    >
                      ×
                    </button>
                  </div>

                  <p className="notifications__item-message">{item.message}</p>

                  <Link
                    className="notifications__link"
                    to={item.to}
                    onClick={() => setOpen(false)}
                  >
                    Open
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
