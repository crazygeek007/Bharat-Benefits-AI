/**
 * Shared shell for /login and /register pages.
 *
 * Renders a two-column split-screen on desktop (form left, gradient marketing
 * panel right) and collapses to a single form column on mobile. The panel
 * content is identical across both pages so users get a consistent brand
 * impression in both flows.
 *
 * Styles live in styles/auth.css; this component only wires structure and
 * accepts a children slot for the form itself.
 */

import { MAIN_CONTENT_ID } from './SkipLink';

interface AuthLayoutProps {
  /** Form heading rendered above the children. */
  title: string;
  /** Short paragraph under the heading explaining what the page is for. */
  subtitle: string;
  /** The form itself + any error/alert blocks above it. */
  children: React.ReactNode;
}

const PANEL_FEATURES = [
  {
    title: 'Personalised scheme matches',
    body: 'Eligibility scored on age, income, occupation, and state — no scrolling through irrelevant programs.',
    icon: '✦',
  },
  {
    title: 'Only verified gov sources',
    body: 'Every scheme comes from gov.in, nic.in, or an official ministry portal. Nothing else makes the catalogue.',
    icon: '✓',
  },
  {
    title: 'Deadlines that find you',
    body: 'Save what matters and get notified when a window is closing — before you miss it.',
    icon: '◷',
  },
] as const;

export function AuthLayout({ title, subtitle, children }: AuthLayoutProps) {
  return (
    <main id={MAIN_CONTENT_ID} tabIndex={-1} className="bb-auth-shell">
      <section className="bb-auth-form-col">
        <div className="bb-auth-form-wrap">
          <a href="/" className="bb-auth-brand-row" aria-label="Bharat Benefits AI home">
            <span aria-hidden="true" className="bb-auth-brand-mark">✦</span>
            <span>Bharat Benefits AI</span>
          </a>
          <h1 className="bb-auth-title">{title}</h1>
          <p className="bb-auth-subtitle">{subtitle}</p>
          {children}
        </div>
      </section>

      <aside className="bb-auth-panel" aria-hidden="true">
        <div className="bb-auth-panel-top">
          <span className="bb-auth-panel-eyebrow">
            <span className="bb-auth-panel-eyebrow-dot" />
            Powered by Gemini AI · Verified gov sources
          </span>
          <h2 className="bb-auth-panel-heading">
            Government benefits, matched to your life.
          </h2>
          <p className="bb-auth-panel-lede">
            One profile. Hundreds of central and state schemes. Bharat Benefits
            AI tells you what you qualify for, why, and how to apply — in your
            language.
          </p>
        </div>

        <ul className="bb-auth-panel-feats">
          {PANEL_FEATURES.map((feat) => (
            <li key={feat.title} className="bb-auth-panel-feat">
              <span className="bb-auth-panel-feat-icon" aria-hidden="true">
                {feat.icon}
              </span>
              <span>
                <strong>{feat.title}</strong>
                {feat.body}
              </span>
            </li>
          ))}
        </ul>
      </aside>
    </main>
  );
}
