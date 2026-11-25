import { useEffect, useState } from 'react';
import { AlertCircle, CheckCircle2, X } from 'lucide-react';

export interface NotificationMessage {
  id: number;
  tone: 'success' | 'error';
  title: string;
  message: string;
  /** Diagnostic lines, such as an error code or request ID. */
  details?: string[];
}

/** Successes close on their own after this long unless pointed at or focused; errors stay until dismissed. */
const SUCCESS_DISMISS_MS = 8_000;

function Notification({ notification, onDismiss }: {
  notification: NotificationMessage;
  onDismiss: (id: number) => void;
}) {
  const { id, tone, title, message, details } = notification;
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const held = hovered || focused;

  useEffect(() => {
    if (tone !== 'success' || held) return undefined;
    const timer = setTimeout(() => onDismiss(id), SUCCESS_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [id, tone, held, onDismiss]);

  const Icon = tone === 'error' ? AlertCircle : CheckCircle2;
  return (
    <div
      className="inventory-toast"
      data-tone={tone}
      role={tone === 'error' ? 'alert' : undefined}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
    >
      <Icon className="icon-size-300 shrink-0" aria-hidden="true" />
      <div className="min-w-0 flex-1 space-y-100">
        <p className="font-semibold">{title}</p>
        <p className="break-words">{message}</p>
        {details?.map((line) => <p key={line} className="break-all text-200 text-muted-foreground">{line}</p>)}
      </div>
      <button className="inventory-toast-close" onClick={() => onDismiss(id)} aria-label={`Dismiss: ${title}`}>
        <X className="icon-size-200" aria-hidden="true" />
      </button>
    </div>
  );
}

/** Notifications at the bottom right of the visible screen, newest last. */
export function Notifications({ items, onDismiss }: {
  items: readonly NotificationMessage[];
  onDismiss: (id: number) => void;
}) {
  return (
    <section className="inventory-toasts" aria-label="Notifications" aria-live="polite">
      {items.map((item) => <Notification key={item.id} notification={item} onDismiss={onDismiss} />)}
    </section>
  );
}
