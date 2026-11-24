import { useEffect, useId, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';

import type { FilterOption } from './inventory-model';

/** Longer lists get a box that narrows the options shown. */
const FILTERABLE_OPTIONS = 8;

/** A filter whose options are checkboxes in a drop-down panel. No selection means no filtering. */
export function MultiSelect({
  label, allLabel, options, selected, onChange, emptyMessage,
}: {
  label: string;
  /** Summary shown when nothing is selected. */
  allLabel: string;
  options: readonly FilterOption[];
  selected: readonly string[];
  onChange: (selected: string[]) => void;
  /** Shown in the panel when there are no options. */
  emptyMessage: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const id = useId();
  const chosen = new Set(selected);
  const term = query.trim().toLocaleLowerCase();
  const visible = term ? options.filter((option) => option.label.toLocaleLowerCase().includes(term)) : options;
  const summary = selected.length === 0 ? allLabel : selected.length === 1 ?
    options.find((option) => option.value === selected[0])?.label ?? selected[0] :
    `${selected.length.toLocaleString()} selected`;

  useEffect(() => {
    if (!open) return undefined;
    const closeOutside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', closeOutside);
    return () => document.removeEventListener('pointerdown', closeOutside);
  }, [open]);

  function toggle(value: string) {
    onChange(chosen.has(value) ? selected.filter((item) => item !== value) : [...selected, value]);
  }

  return (
    <div
      ref={root}
      className="inventory-field inventory-multiselect"
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || !open) return;
        event.stopPropagation();
        setOpen(false);
        button.current?.focus();
      }}
      onBlur={(event) => {
        // Moving keyboard focus elsewhere closes the panel; pointer clicks outside are handled above.
        if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget as Node)) setOpen(false);
      }}
    >
      <span id={`${id}-label`}>{label}</span>
      <button
        ref={button}
        type="button"
        className="inventory-multiselect-button"
        aria-expanded={open}
        aria-controls={open ? `${id}-panel` : undefined}
        aria-labelledby={`${id}-label ${id}-summary`}
        onClick={() => setOpen((value) => !value)}
      >
        <span id={`${id}-summary`} className="min-w-0 truncate">{summary}</span>
        <ChevronDown aria-hidden="true" className="icon-size-200 shrink-0" />
      </button>
      {open && (
        <div id={`${id}-panel`} className="inventory-multiselect-panel" role="group" aria-labelledby={`${id}-label`}>
          {options.length > FILTERABLE_OPTIONS && (
            <input
              type="search"
              className="inventory-multiselect-filter"
              placeholder="Filter options"
              aria-label={`Filter ${label.toLocaleLowerCase()} options`}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
          )}
          {visible.length > 0 ? (
            <ul className="inventory-multiselect-options">
              {visible.map((option, index) => (
                <li key={option.value}>
                  <label className="inventory-multiselect-option">
                    <input
                      type="checkbox"
                      checked={chosen.has(option.value)}
                      onChange={() => toggle(option.value)}
                      aria-labelledby={`${id}-option-${index}`}
                      aria-describedby={`${id}-count-${index}`}
                    />
                    <span id={`${id}-option-${index}`} className="min-w-0 flex-1 break-words">{option.label}</span>
                    <span className="text-200 text-muted-foreground" aria-hidden="true">{option.count.toLocaleString()}</span>
                    <span id={`${id}-count-${index}`} className="sr-only">
                      {`${option.count.toLocaleString()} ${option.count === 1 ? 'connection' : 'connections'}`}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          ) : (
            <p className="inventory-multiselect-empty">{options.length > 0 ? 'No matching options' : emptyMessage}</p>
          )}
          {selected.length > 0 && (
            <button type="button" className="inventory-multiselect-clear" onClick={() => onChange([])}>
              Clear selection
            </button>
          )}
        </div>
      )}
    </div>
  );
}
