import { useCallback, useRef, useState } from 'react';

import type { NotificationMessage } from '@/components/inventory/notifications';

export type NewNotification = Omit<NotificationMessage, 'id'>;

/** Older notifications are dropped beyond this many. */
const MAX_NOTIFICATIONS = 4;

export function useNotifications() {
  const [items, setItems] = useState<NotificationMessage[]>([]);
  const nextId = useRef(0);

  const notify = useCallback((notification: NewNotification) => {
    nextId.current += 1;
    const id = nextId.current;
    setItems((previous) => [...previous, { ...notification, id }].slice(-MAX_NOTIFICATIONS));
  }, []);

  const dismiss = useCallback((id: number) => {
    setItems((previous) => previous.filter((item) => item.id !== id));
  }, []);

  return { items, notify, dismiss };
}
