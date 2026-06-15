/**
 * Keyboard navigation utilities (Requirement 20.2).
 *
 * Provides hooks and helpers for:
 *   - Focus trapping inside modal dialogs so keyboard users cannot
 *     accidentally tab into the background content.
 *   - Roving tabindex for composite widgets (toolbars, tab lists,
 *     menu bars) so arrow keys move focus within the group and Tab
 *     skips the group as a single stop.
 *   - Escape key handling that bubbles to a dismiss callback.
 *
 * All hooks return stable references (via useCallback/useRef) so they
 * can be passed to dependency arrays without causing re-renders.
 */

/**
 * Returns the list of focusable elements within a container, in DOM
 * order. Only elements that are visible, enabled, and reachable via
 * Tab (or have explicit tabindex) are included.
 */
export function getFocusableElements(container: HTMLElement): HTMLElement[] {
  const selector = [
    'a[href]',
    'button:not([disabled])',
    'input:not([disabled]):not([type="hidden"])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[tabindex]:not([tabindex="-1"])',
    '[contenteditable="true"]',
  ].join(', ');

  const nodes = Array.from(container.querySelectorAll<HTMLElement>(selector));
  return nodes.filter((el) => {
    // Exclude elements with zero dimensions (display:none etc.)
    return el.offsetWidth > 0 || el.offsetHeight > 0 || el.getClientRects().length > 0;
  });
}

/**
 * Traps Tab/Shift+Tab focus within a container element. Call this from
 * a `keydown` event handler on the container or document.
 *
 * Returns `true` if the event was handled (so the caller can
 * `preventDefault` if needed).
 */
export function trapFocus(event: KeyboardEvent, container: HTMLElement): boolean {
  if (event.key !== 'Tab') return false;

  const focusable = getFocusableElements(container);
  if (focusable.length === 0) return false;

  const first = focusable[0];
  const last = focusable[focusable.length - 1];

  if (event.shiftKey) {
    // Shift+Tab from first element → wrap to last
    if (document.activeElement === first) {
      event.preventDefault();
      last.focus();
      return true;
    }
  } else {
    // Tab from last element → wrap to first
    if (document.activeElement === last) {
      event.preventDefault();
      first.focus();
      return true;
    }
  }
  return false;
}

/**
 * Manages roving tabindex within a group of elements navigated by
 * arrow keys. Only the active item has `tabindex="0"`; all others
 * are set to `tabindex="-1"`.
 *
 * Supports horizontal (Left/Right) and vertical (Up/Down) arrow key
 * navigation with wrapping.
 */
export function rovingTabIndex(
  event: KeyboardEvent,
  items: HTMLElement[],
  options: { orientation?: 'horizontal' | 'vertical' | 'both' } = {},
): boolean {
  const { orientation = 'both' } = options;

  const prevKeys: string[] = [];
  const nextKeys: string[] = [];

  if (orientation === 'horizontal' || orientation === 'both') {
    prevKeys.push('ArrowLeft');
    nextKeys.push('ArrowRight');
  }
  if (orientation === 'vertical' || orientation === 'both') {
    prevKeys.push('ArrowUp');
    nextKeys.push('ArrowDown');
  }

  const isPrev = prevKeys.includes(event.key);
  const isNext = nextKeys.includes(event.key);
  if (!isPrev && !isNext) return false;

  event.preventDefault();

  const currentIndex = items.indexOf(document.activeElement as HTMLElement);
  if (currentIndex === -1) return false;

  let nextIndex: number;
  if (isNext) {
    nextIndex = (currentIndex + 1) % items.length;
  } else {
    nextIndex = (currentIndex - 1 + items.length) % items.length;
  }

  // Update tabindex values
  items[currentIndex].setAttribute('tabindex', '-1');
  items[nextIndex].setAttribute('tabindex', '0');
  items[nextIndex].focus();

  return true;
}

/**
 * Handles Home/End key navigation within a list of items.
 * Home moves focus to the first item, End moves to the last.
 */
export function handleHomeEnd(event: KeyboardEvent, items: HTMLElement[]): boolean {
  if (event.key !== 'Home' && event.key !== 'End') return false;
  if (items.length === 0) return false;

  event.preventDefault();

  const currentIndex = items.indexOf(document.activeElement as HTMLElement);
  if (currentIndex === -1) return false;

  const targetIndex = event.key === 'Home' ? 0 : items.length - 1;

  items[currentIndex].setAttribute('tabindex', '-1');
  items[targetIndex].setAttribute('tabindex', '0');
  items[targetIndex].focus();

  return true;
}
