import { useEffect, useId, useRef, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { TriangleAlert } from 'lucide-react';
import type { ConnectionRow } from '@rayfin-app/shared';

import { credentialTypeLabel } from './inventory-model';

/**
 * Asks for confirmation before a take over, warning that it breaks the connection until the user completes the
 * listed steps that make it work under their ownership.
 */
export function TakeOverConfirmation({ row, onConfirm, onCancel }: {
  row: ConnectionRow;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const id = useId();
  const cancel = useRef<HTMLButtonElement>(null);
  const confirm = useRef<HTMLButtonElement>(null);

  // The least consequential choice gets the initial focus.
  useEffect(() => {
    cancel.current?.focus();
  }, []);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.stopPropagation();
      onCancel();
      return;
    }
    if (event.key !== 'Tab') return;
    // The dialog is modal, so Tab and Shift+Tab cycle between its buttons.
    const active = document.activeElement;
    const next = event.shiftKey ?
      (active === cancel.current || active === event.currentTarget ? confirm.current : null) :
      (active === confirm.current ? cancel.current : null);
    if (next) {
      event.preventDefault();
      next.focus();
    }
  }

  return createPortal(
    <div
      className="inventory-dialog-backdrop"
      // Keeps focus in the dialog when the backdrop is clicked.
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) event.preventDefault();
      }}
    >
      <div
        className="inventory-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-description`}
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <h2 id={`${id}-title`} className="text-400 font-semibold">{`Take over ${row.displayName || row.id}?`}</h2>
        <div id={`${id}-description`} className="space-y-300">
          <div className="inventory-notice inventory-warning">
            <TriangleAlert className="icon-size-300 shrink-0" aria-hidden="true" />
            <p>
              <strong>Taking over breaks this connection.</strong> It stops working as soon as you take it over, and
              won’t work again until you complete the steps below. Until then, the items that use it, such as those
              listed under <strong>Dependent workloads</strong>, can’t connect.
            </p>
          </div>
          <p>
            You’ll be added as a pending owner, and existing owners are kept. To get the connection working again with
            your credentials and make your ownership effective:
          </p>
          <ol className="list-decimal space-y-200 pl-500">
            <li>
              In Fabric, open <strong>Settings</strong> &gt; <strong>Manage connections and gateways</strong>, and open
              this connection’s settings on the <strong>Connections</strong> tab.
            </li>
            <li>
              Enter credentials that can access the endpoint below, and save. This makes you an owner, and the
              connection works again.
            </li>
            <li>
              Make sure those credentials work for every item under <strong>Dependent workloads</strong>, because
              they’ll all run with them.
            </li>
          </ol>
          <dl className="inventory-dialog-facts">
            <div>
              <dt className="text-200 text-muted-foreground">Endpoint</dt>
              <dd className="mt-100 break-all font-monospace text-200">{row.endpoint || 'Not returned'}</dd>
            </div>
            <div>
              <dt className="text-200 text-muted-foreground">Connector type</dt>
              <dd className="mt-100 break-words">{row.connectorType || 'Not returned'}</dd>
            </div>
            <div>
              <dt className="text-200 text-muted-foreground">Authentication type</dt>
              <dd className="mt-100 break-words">{credentialTypeLabel(row.credentialType)}</dd>
            </div>
          </dl>
          <p className="font-semibold">
            Continue only if these steps are clear to you and you’ve confirmed that you have the access or credentials
            this endpoint needs.
          </p>
        </div>
        <div className="inventory-dialog-actions">
          <button ref={cancel} type="button" className="inventory-button" onClick={onCancel}>Cancel</button>
          <button ref={confirm} type="button" className="inventory-button inventory-button-primary" onClick={onConfirm}>
            Take over
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
