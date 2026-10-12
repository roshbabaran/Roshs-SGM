import { useEffect, useRef } from 'react';

import type { ShortcutMap } from './useKeyboardShortcuts';

export type { ShortcutMap } from './useKeyboardShortcuts';

function comboOf(event: KeyboardEvent): string {
  const parts: string[] = [];
  if (event.ctrlKey || event.metaKey) parts.push('Ctrl');
  if (event.altKey) parts.push('Alt');
  if (event.shiftKey && event.key.length > 1) parts.push('Shift');
  parts.push(event.key.length === 1 ? event.key.toUpperCase() : event.key);
  return parts.join('+');
}

/**
 * Desktop keyboard shortcuts for the current screen. Plain letter keys are
 * ignored while typing in a field; function keys, Escape and Ctrl/Alt
 * combinations always work. Pass enabled=false while a dialog covers the screen.
 */
export function useKeyboardShortcuts(shortcuts: ShortcutMap, enabled = true): void {
  const latest = useRef(shortcuts);
  useEffect(() => {
    latest.current = shortcuts;
  });

  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const combo = comboOf(event);
      const action = latest.current[combo];
      if (!action) return;
      const target = event.target as HTMLElement | null;
      const typing = !!target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
      const alwaysOn = /^F\d{1,2}$/.test(event.key) || event.key === 'Escape' || combo.includes('+');
      if (typing && !alwaysOn) return;
      event.preventDefault();
      action();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [enabled]);
}
