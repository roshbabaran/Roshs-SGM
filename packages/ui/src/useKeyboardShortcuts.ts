/** Map of shortcut to action, e.g. { F9: charge, 'Ctrl+1': goToDashboard, Escape: close }. */
export type ShortcutMap = Record<string, (() => void) | undefined>;

/** Phones have no keyboard shortcuts; the desktop version is useKeyboardShortcuts.web.ts. */
export function useKeyboardShortcuts(_shortcuts: ShortcutMap, _enabled = true): void {}
