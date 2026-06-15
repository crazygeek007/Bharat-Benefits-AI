/**
 * Unit tests for keyboard navigation utilities (Requirement 20.2).
 *
 * Validates:
 *   - getFocusableElements correctly identifies interactive elements
 *   - trapFocus wraps Tab/Shift+Tab within a container
 *   - rovingTabIndex moves focus with arrow keys and wraps
 *   - handleHomeEnd jumps to first/last elements
 *
 * @vitest-environment jsdom
 */

import { describe, expect, test, vi, beforeEach } from 'vitest';
import {
  getFocusableElements,
  trapFocus,
  rovingTabIndex,
  handleHomeEnd,
} from './useKeyboardNavigation';

// Helper to create a minimal DOM-like container for testing
function createMockContainer(elements: Array<{ tag: string; attrs?: Record<string, string> }>) {
  const container = document.createElement('div');
  elements.forEach((el) => {
    const node = document.createElement(el.tag);
    if (el.attrs) {
      Object.entries(el.attrs).forEach(([key, value]) => {
        node.setAttribute(key, value);
      });
    }
    // Mock offsetWidth/offsetHeight so elements appear "visible"
    Object.defineProperty(node, 'offsetWidth', { value: 100, configurable: true });
    Object.defineProperty(node, 'offsetHeight', { value: 40, configurable: true });
    container.appendChild(node);
  });
  return container;
}

describe('getFocusableElements', () => {
  test('finds buttons, links, and inputs', () => {
    const container = createMockContainer([
      { tag: 'button' },
      { tag: 'a', attrs: { href: '/test' } },
      { tag: 'input', attrs: { type: 'text' } },
      { tag: 'select' },
      { tag: 'textarea' },
    ]);

    const result = getFocusableElements(container);
    expect(result).toHaveLength(5);
  });

  test('excludes disabled elements', () => {
    const container = createMockContainer([
      { tag: 'button', attrs: { disabled: '' } },
      { tag: 'input', attrs: { disabled: '' } },
      { tag: 'button' },
    ]);

    const result = getFocusableElements(container);
    expect(result).toHaveLength(1);
  });

  test('excludes hidden inputs', () => {
    const container = createMockContainer([
      { tag: 'input', attrs: { type: 'hidden' } },
      { tag: 'input', attrs: { type: 'text' } },
    ]);

    const result = getFocusableElements(container);
    expect(result).toHaveLength(1);
  });

  test('excludes elements with tabindex="-1"', () => {
    const container = createMockContainer([
      { tag: 'div', attrs: { tabindex: '-1' } },
      { tag: 'div', attrs: { tabindex: '0' } },
    ]);

    const result = getFocusableElements(container);
    expect(result).toHaveLength(1);
  });

  test('includes links only if they have href', () => {
    const container = createMockContainer([
      { tag: 'a', attrs: { href: '/page' } },
      { tag: 'a' },
    ]);

    const result = getFocusableElements(container);
    expect(result).toHaveLength(1);
  });

  test('returns empty array for container with no focusable elements', () => {
    const container = createMockContainer([
      { tag: 'div' },
      { tag: 'span' },
      { tag: 'p' },
    ]);

    const result = getFocusableElements(container);
    expect(result).toHaveLength(0);
  });
});

describe('trapFocus', () => {
  test('returns false for non-Tab keys', () => {
    const container = createMockContainer([{ tag: 'button' }]);
    const event = new KeyboardEvent('keydown', { key: 'Enter' });
    expect(trapFocus(event, container)).toBe(false);
  });

  test('returns false for empty container', () => {
    const container = createMockContainer([{ tag: 'div' }]);
    const event = new KeyboardEvent('keydown', { key: 'Tab' });
    expect(trapFocus(event, container)).toBe(false);
  });

  test('wraps focus from last to first on Tab', () => {
    const container = createMockContainer([
      { tag: 'button' },
      { tag: 'button' },
      { tag: 'button' },
    ]);
    document.body.appendChild(container);

    const buttons = Array.from(container.querySelectorAll('button'));
    const lastButton = buttons[2];

    // Simulate focus on last element
    lastButton.focus();
    Object.defineProperty(document, 'activeElement', {
      value: lastButton,
      configurable: true,
    });

    const event = new KeyboardEvent('keydown', { key: 'Tab', cancelable: true });
    const preventDefaultSpy = vi.spyOn(event, 'preventDefault');

    const handled = trapFocus(event, container);

    expect(handled).toBe(true);
    expect(preventDefaultSpy).toHaveBeenCalled();

    document.body.removeChild(container);
  });

  test('wraps focus from first to last on Shift+Tab', () => {
    const container = createMockContainer([
      { tag: 'button' },
      { tag: 'button' },
      { tag: 'button' },
    ]);
    document.body.appendChild(container);

    const buttons = Array.from(container.querySelectorAll('button'));
    const firstButton = buttons[0];

    Object.defineProperty(document, 'activeElement', {
      value: firstButton,
      configurable: true,
    });

    const event = new KeyboardEvent('keydown', {
      key: 'Tab',
      shiftKey: true,
      cancelable: true,
    });
    const preventDefaultSpy = vi.spyOn(event, 'preventDefault');

    const handled = trapFocus(event, container);

    expect(handled).toBe(true);
    expect(preventDefaultSpy).toHaveBeenCalled();

    document.body.removeChild(container);
  });
});

describe('rovingTabIndex', () => {
  let items: HTMLElement[];

  beforeEach(() => {
    const container = document.createElement('div');
    for (let i = 0; i < 4; i++) {
      const btn = document.createElement('button');
      btn.textContent = `Item ${i}`;
      btn.setAttribute('tabindex', i === 0 ? '0' : '-1');
      container.appendChild(btn);
    }
    document.body.appendChild(container);
    items = Array.from(container.querySelectorAll('button'));
  });

  test('returns false for non-arrow keys', () => {
    const event = new KeyboardEvent('keydown', { key: 'Enter' });
    expect(rovingTabIndex(event, items)).toBe(false);
  });

  test('moves focus forward on ArrowRight (horizontal)', () => {
    Object.defineProperty(document, 'activeElement', {
      value: items[0],
      configurable: true,
    });

    const event = new KeyboardEvent('keydown', {
      key: 'ArrowRight',
      cancelable: true,
    });

    const handled = rovingTabIndex(event, items, { orientation: 'horizontal' });

    expect(handled).toBe(true);
    expect(items[0].getAttribute('tabindex')).toBe('-1');
    expect(items[1].getAttribute('tabindex')).toBe('0');
  });

  test('moves focus backward on ArrowLeft (horizontal)', () => {
    Object.defineProperty(document, 'activeElement', {
      value: items[1],
      configurable: true,
    });

    const event = new KeyboardEvent('keydown', {
      key: 'ArrowLeft',
      cancelable: true,
    });

    const handled = rovingTabIndex(event, items, { orientation: 'horizontal' });

    expect(handled).toBe(true);
    expect(items[1].getAttribute('tabindex')).toBe('-1');
    expect(items[0].getAttribute('tabindex')).toBe('0');
  });

  test('wraps from last to first on ArrowRight', () => {
    Object.defineProperty(document, 'activeElement', {
      value: items[3],
      configurable: true,
    });

    const event = new KeyboardEvent('keydown', {
      key: 'ArrowRight',
      cancelable: true,
    });

    rovingTabIndex(event, items, { orientation: 'horizontal' });

    expect(items[3].getAttribute('tabindex')).toBe('-1');
    expect(items[0].getAttribute('tabindex')).toBe('0');
  });

  test('wraps from first to last on ArrowLeft', () => {
    Object.defineProperty(document, 'activeElement', {
      value: items[0],
      configurable: true,
    });

    const event = new KeyboardEvent('keydown', {
      key: 'ArrowLeft',
      cancelable: true,
    });

    rovingTabIndex(event, items, { orientation: 'horizontal' });

    expect(items[0].getAttribute('tabindex')).toBe('-1');
    expect(items[3].getAttribute('tabindex')).toBe('0');
  });

  test('handles vertical orientation with ArrowDown/ArrowUp', () => {
    Object.defineProperty(document, 'activeElement', {
      value: items[0],
      configurable: true,
    });

    const downEvent = new KeyboardEvent('keydown', {
      key: 'ArrowDown',
      cancelable: true,
    });

    const handled = rovingTabIndex(downEvent, items, { orientation: 'vertical' });

    expect(handled).toBe(true);
    expect(items[1].getAttribute('tabindex')).toBe('0');
  });

  test('ignores horizontal keys in vertical-only mode', () => {
    Object.defineProperty(document, 'activeElement', {
      value: items[0],
      configurable: true,
    });

    const event = new KeyboardEvent('keydown', {
      key: 'ArrowRight',
      cancelable: true,
    });

    const handled = rovingTabIndex(event, items, { orientation: 'vertical' });
    expect(handled).toBe(false);
  });
});

describe('handleHomeEnd', () => {
  let items: HTMLElement[];

  beforeEach(() => {
    const container = document.createElement('div');
    for (let i = 0; i < 5; i++) {
      const btn = document.createElement('button');
      btn.textContent = `Item ${i}`;
      btn.setAttribute('tabindex', i === 2 ? '0' : '-1');
      container.appendChild(btn);
    }
    document.body.appendChild(container);
    items = Array.from(container.querySelectorAll('button'));
  });

  test('returns false for non-Home/End keys', () => {
    const event = new KeyboardEvent('keydown', { key: 'a' });
    expect(handleHomeEnd(event, items)).toBe(false);
  });

  test('moves to first item on Home', () => {
    Object.defineProperty(document, 'activeElement', {
      value: items[2],
      configurable: true,
    });

    const event = new KeyboardEvent('keydown', {
      key: 'Home',
      cancelable: true,
    });

    const handled = handleHomeEnd(event, items);

    expect(handled).toBe(true);
    expect(items[0].getAttribute('tabindex')).toBe('0');
    expect(items[2].getAttribute('tabindex')).toBe('-1');
  });

  test('moves to last item on End', () => {
    Object.defineProperty(document, 'activeElement', {
      value: items[2],
      configurable: true,
    });

    const event = new KeyboardEvent('keydown', {
      key: 'End',
      cancelable: true,
    });

    const handled = handleHomeEnd(event, items);

    expect(handled).toBe(true);
    expect(items[4].getAttribute('tabindex')).toBe('0');
    expect(items[2].getAttribute('tabindex')).toBe('-1');
  });

  test('returns false for empty items array', () => {
    const event = new KeyboardEvent('keydown', { key: 'Home' });
    expect(handleHomeEnd(event, [])).toBe(false);
  });
});
