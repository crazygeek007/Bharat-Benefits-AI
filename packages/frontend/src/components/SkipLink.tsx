/**
 * "Skip to main content" link (Requirement 20.2).
 *
 * Keyboard-only users tab through navigation chrome on every page; the
 * skip link gives them a one-keystroke way to bypass it and jump
 * directly to the page's `<main>` element.
 *
 * The visual styling is provided by the `.skip-link` class in
 * `app/globals.css` so the link stays visually hidden until it
 * receives keyboard focus, at which point it slides into the
 * top-left of the viewport.
 *
 * The target `<main>` is expected to use `id="main-content"` and
 * `tabIndex={-1}` so the focus actually moves when the link is
 * activated. {@link MAIN_CONTENT_ID} centralises that id.
 */

export const MAIN_CONTENT_ID = 'main-content';

export interface SkipLinkProps {
  /** Visible label. Defaults to English; pages can localise as needed. */
  label?: string;
}

export function SkipLink({ label = 'Skip to main content' }: SkipLinkProps) {
  return (
    <a className="skip-link" href={`#${MAIN_CONTENT_ID}`}>
      {label}
    </a>
  );
}
