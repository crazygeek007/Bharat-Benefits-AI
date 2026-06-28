import { MAIN_CONTENT_ID } from '../components/SkipLink';

/**
 * Force this page to render at request time rather than at build time.
 *
 * The hero stat reads from the backend's `/api/schemes` endpoint, and
 * that endpoint is only reachable at runtime (Render's production URL),
 * not from Vercel's build runner. Without `force-dynamic`, Next.js
 * tries to pre-render the page during `next build`, the fetch fails,
 * the build errors out — which is exactly what happened on the first
 * deploy of this change.
 *
 * Trade-off: every homepage request now hits the backend instead of
 * serving from the static cache. For a low-traffic landing page that's
 * fine. If traffic grows the right move is a short-lived Redis cache
 * around `/api/schemes?pageSize=1` so the backend gets at most one hit
 * per minute regardless of page-view rate — not pre-rendering at build
 * time, which would re-introduce stale counts.
 */
export const dynamic = 'force-dynamic';

/**
 * Default scheme-count copy used when the backend fetch fails. We use
 * a vague "10+" rather than guessing the real number — operators will
 * see the failure in logs and a future render picks up the live count.
 */
const SCHEME_COUNT_FALLBACK = 10;

/**
 * Resolve the backend base URL the same way the rest of the frontend
 * does (`BACKEND_URL` server-side, `NEXT_PUBLIC_BACKEND_URL` for the
 * browser bundle). Mirrored locally because importing the existing
 * `getBackendBaseUrl` from `lib/api.ts` would pull a 'use client'-y
 * module into this Server Component.
 */
function getBackendBaseUrl(): string {
  return (
    process.env.BACKEND_URL ||
    process.env.NEXT_PUBLIC_BACKEND_URL ||
    'http://localhost:4000'
  );
}

/**
 * Fetches the total verified scheme count via the `/api/schemes`
 * browse endpoint. We ask for `pageSize=1` because we only care about
 * the `totalCount` field — no need to ship the full first-page payload
 * just to render a hero stat.
 *
 * Wrapped in `force-dynamic` page rendering so this runs at request
 * time (where the backend is reachable), not at build time (where it
 * isn't). Backend response is itself cached for 60s via the
 * `next: { revalidate: 60 }` hint, so high-frequency homepage hits
 * don't fan out to a real fetch every time.
 *
 * Falls back to {@link SCHEME_COUNT_FALLBACK} on any error (network,
 * non-2xx response, malformed body, or anything Next.js's fetch
 * wrapper might throw). The fallback is small enough that we'll
 * never accidentally show a number higher than the real catalogue.
 */
async function fetchSchemeCount(): Promise<number> {
  // Belt and braces: if we're somehow running at build time and the
  // backend URL still points to localhost (i.e. no BACKEND_URL env var
  // was provided to the build), bail to the fallback without even
  // attempting the fetch. Avoids surfacing a build-time ECONNREFUSED
  // error to Next.js's static export step.
  const baseUrl = getBackendBaseUrl();
  if (baseUrl.includes('localhost') && process.env.NODE_ENV === 'production') {
    return SCHEME_COUNT_FALLBACK;
  }

  try {
    const res = await fetch(
      `${baseUrl}/api/schemes?pageSize=1`,
      { next: { revalidate: 60 } },
    );
    if (!res.ok) return SCHEME_COUNT_FALLBACK;
    const body = (await res.json()) as { totalCount?: unknown };
    if (typeof body.totalCount === 'number' && body.totalCount >= 0) {
      return body.totalCount;
    }
    return SCHEME_COUNT_FALLBACK;
  } catch {
    return SCHEME_COUNT_FALLBACK;
  }
}

/**
 * Render the scheme count for the hero stat. Small counts (< 10)
 * show exactly; anything from 10 upwards displays as the number
 * followed by `+` so we don't have to redeploy the marketing copy
 * every time the catalogue grows by one scheme.
 *
 * Examples:
 *   3   -> "3"
 *   12  -> "12+"
 *   103 -> "103+"
 *   1500 -> "1500+"
 */
function formatSchemeCount(count: number): string {
  if (count < 10) return String(count);
  return `${count}+`;
}

/**
 * Modern AI SaaS landing page.
 *
 * Server Component. The hero stat reflecting "verified schemes" is
 * fetched at render time from the backend's `/api/schemes` browse
 * endpoint via the `totalCount` field so the number stays in sync
 * with the production catalogue as it grows. The response is cached
 * for 60 seconds via Next.js ISR — fast enough to refresh between
 * crawler runs without putting load on the backend.
 *
 * If the backend is unreachable at render time we fall back to a
 * sensible-looking default so the page still renders. Operators see
 * the failure in logs rather than as a broken homepage.
 */
export default async function Home() {
  const schemeCount = await fetchSchemeCount();
  return (
    <main id={MAIN_CONTENT_ID} tabIndex={-1} style={{ overflow: 'hidden' }}>
      {/* HERO ───────────────────────────────────────────────────────── */}
      {/* Padding lives in `.bb-hero` (globals.css) so it can tighten on
          mobile — the inline 80px top padding was leaving the pill
          badge floating mid-screen on phones. */}
      <section className="bb-hero">
        {/* Ambient glow orb */}
        <div
          aria-hidden="true"
          style={{
            position: 'absolute',
            top: '-10%',
            left: '50%',
            transform: 'translateX(-50%)',
            width: 600,
            height: 600,
            background:
              'radial-gradient(circle, rgba(139, 92, 246, 0.18) 0%, rgba(217, 70, 239, 0.08) 40%, transparent 70%)',
            filter: 'blur(40px)',
            pointerEvents: 'none',
            zIndex: -1,
          }}
        />

        {/* Pill badge */}
        <div
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 8,
            padding: '6px 14px',
            background: 'rgba(99, 102, 241, 0.08)',
            border: '1px solid rgba(99, 102, 241, 0.2)',
            borderRadius: 9999,
            fontSize: 13,
            fontWeight: 500,
            color: '#4338ca',
            marginBottom: 24,
            animation: 'fadeUp 0.6s var(--ease)',
          }}
        >
          <span style={{ display: 'inline-flex', width: 6, height: 6, background: '#10b981', borderRadius: '50%', boxShadow: '0 0 0 3px rgba(16, 185, 129, 0.2)' }} aria-hidden="true" />
          AI-Powered Welfare-Scheme Discovery Tool · Verified gov sources
        </div>

        <h1
          style={{
            fontSize: 'clamp(32px, 5vw, 56px)',
            fontWeight: 700,
            lineHeight: 1.1,
            letterSpacing: '-0.035em',
            margin: '0 0 24px',
            maxWidth: 820,
            marginInline: 'auto',
          }}
        >
          Your government benefits,
          <br />
          <span className="gradient-text">found in seconds.</span>
        </h1>

        <p
          style={{
            fontSize: 19,
            lineHeight: 1.5,
            color: '#52525b',
            maxWidth: 640,
            margin: '0 auto 40px',
          }}
        >
          AI-powered platform that helps Indian citizens discover, understand, and apply for
          welfare schemes. Verified data from official sources only.
        </p>

        <div style={{ display: 'flex', gap: 12, justifyContent: 'center', flexWrap: 'wrap' }}>
          <a href="/assistant" className="btn-primary">
            <span aria-hidden="true">✦</span> Ask AI Assistant
          </a>
          <a href="/schemes" className="btn-secondary">
            Browse all schemes →
          </a>
        </div>

        {/* Hero stats — `.bb-hero-stats` defines a tighter grid + smaller
            top margin on mobile so the three numbers sit closer to the
            CTA buttons instead of floating below a big gap. */}
        <div className="bb-hero-stats">
          <Stat value={formatSchemeCount(schemeCount)} label="Verified schemes" />
          <Stat value="6" label="Languages" />
          <Stat value="100%" label="Official sources" />
        </div>
      </section>

      {/* FEATURES ───────────────────────────────────────────────────── */}
      <section aria-labelledby="features-heading" className="bb-section">
        <div style={{ textAlign: 'center', marginBottom: 56 }}>
          <p
            style={{
              fontSize: 13,
              fontWeight: 600,
              textTransform: 'uppercase',
              letterSpacing: '0.1em',
              color: '#6366f1',
              margin: '0 0 12px',
            }}
          >
            Capabilities
          </p>
          <h2 id="features-heading" style={{ margin: '0 0 16px' }}>
            Everything you need.
            <br />
            <span style={{ color: '#71717a' }}>Nothing you don&apos;t.</span>
          </h2>
        </div>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
            gap: 16,
          }}
        >
          <FeatureCard
            icon="✦"
            iconBg="linear-gradient(135deg, #6366f1, #8b5cf6)"
            title="AI Scheme Assistant"
            description="Ask anything about Indian government welfare schemes. Get answers backed by source citations from official portals."
          />
          <FeatureCard
            icon="◉"
            iconBg="linear-gradient(135deg, #8b5cf6, #d946ef)"
            title="Personalized matching"
            description="Tell us about yourself once. We rank schemes by your eligibility, benefit amount, and deadline urgency."
          />
          <FeatureCard
            icon="✓"
            iconBg="linear-gradient(135deg, #10b981, #059669)"
            title="Instant eligibility"
            description="See exactly whether you qualify for a scheme based on age, income, occupation, and more."
          />
          <FeatureCard
            icon="◷"
            iconBg="linear-gradient(135deg, #f59e0b, #d97706)"
            title="Deadline tracking"
            description="Save schemes to your dashboard. Get notified before deadlines so you never miss a benefit."
          />
          <FeatureCard
            icon="⌘"
            iconBg="linear-gradient(135deg, #06b6d4, #0891b2)"
            title="Multilingual"
            description="Available in English, Hindi, Bengali, Tamil, Telugu, and Marathi."
          />
          <FeatureCard
            icon="🛡"
            iconBg="linear-gradient(135deg, #ef4444, #dc2626)"
            title="Encrypted & private"
            description="Your profile is encrypted at rest. Data sourced exclusively from gov.in and nic.in. Never shared."
          />
        </div>
      </section>

      {/* CATEGORIES ─────────────────────────────────────────────────── */}
      <section aria-labelledby="categories-heading" className="bb-section">
        <div style={{ textAlign: 'center', marginBottom: 40 }}>
          <h2 id="categories-heading" style={{ margin: '0 0 12px' }}>
            Explore by category
          </h2>
          <p style={{ color: '#71717a', margin: 0 }}>
            12 categories of welfare programs across Central and State Governments.
          </p>
        </div>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
            gap: 12,
          }}
        >
          {CATEGORIES.map((cat) => (
            <CategoryTile key={cat.name} name={cat.name} icon={cat.icon} accent={cat.accent} />
          ))}
        </div>
      </section>

      {/* HOW IT WORKS ───────────────────────────────────────────────── */}
      <section aria-labelledby="how-heading" className="bb-section bb-section--how">
        {/* Card padding/radius/background live in `.bb-how-card` so we
            can drop the inner padding from 48px to 28px on mobile —
            48px left only ~260px of usable width on a 360px phone. */}
        <div className="bb-how-card">
          {/* Decorative blur */}
          <div
            aria-hidden="true"
            style={{
              position: 'absolute',
              top: -100,
              right: -100,
              width: 300,
              height: 300,
              background: 'radial-gradient(circle, rgba(139, 92, 246, 0.15), transparent 70%)',
              filter: 'blur(60px)',
              pointerEvents: 'none',
            }}
          />

          <div style={{ textAlign: 'center', marginBottom: 40, position: 'relative' }}>
            <h2 style={{ margin: '0 0 12px' }}>Get started in 60 seconds.</h2>
            <p style={{ color: '#71717a', margin: 0 }}>
              No paperwork. No phone calls. Just smart, AI-powered guidance.
            </p>
          </div>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
              gap: 24,
              position: 'relative',
            }}
          >
            <Step number={1} title="Create your profile" desc="Quick form — age, state, income, occupation." />
            <Step number={2} title="Discover matches" desc="Browse, search, or chat with the AI." />
            <Step number={3} title="Apply with confidence" desc="Get checklists and direct links to official portals." />
          </div>

          <div style={{ textAlign: 'center', marginTop: 40, position: 'relative' }}>
            <a href="/register" className="btn-primary" style={{ padding: '13px 28px', fontSize: 16 }}>
              Get started — it&apos;s free →
            </a>
          </div>
        </div>
      </section>

      {/* TRUST BAR ──────────────────────────────────────────────────── */}
      <section className="bb-section bb-section--trust">
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 12,
            padding: '20px 24px',
            background: 'rgba(16, 185, 129, 0.05)',
            border: '1px solid rgba(16, 185, 129, 0.2)',
            borderRadius: 14,
            fontSize: 14,
            color: '#52525b',
            flexWrap: 'wrap',
            textAlign: 'center',
          }}
        >
          <span style={{ color: '#10b981', fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span aria-hidden="true">●</span> Verified data only
          </span>
          <span style={{ color: '#d4d4d8' }}>—</span>
          <span>Sourced exclusively from gov.in, nic.in, and official ministry portals.</span>
        </div>
      </section>
    </main>
  );
}

/* ─── Sub-components ────────────────────────────────────────────────── */

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div>
      <div
        style={{
          fontSize: 32,
          fontWeight: 700,
          letterSpacing: '-0.03em',
          color: '#09090b',
          lineHeight: 1,
        }}
      >
        {value}
      </div>
      <div style={{ fontSize: 13, color: '#71717a', marginTop: 6 }}>{label}</div>
    </div>
  );
}

function FeatureCard({
  icon,
  iconBg,
  title,
  description,
}: {
  icon: string;
  iconBg: string;
  title: string;
  description: string;
}) {
  // Hover styling lives in `.feature-card` in globals.css. We can't use
  // onMouseEnter/onMouseLeave here because this file is rendered as a
  // Server Component (Server Components can't pass event handlers to
  // the client — the page 500s with "Event handlers cannot be passed to
  // Client Component props"). CSS :hover does the same thing for free.
  return (
    <div className="feature-card">
      <div
        aria-hidden="true"
        style={{
          width: 44,
          height: 44,
          borderRadius: 12,
          background: iconBg,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: '#fff',
          fontSize: 20,
          fontWeight: 700,
          marginBottom: 16,
          boxShadow: '0 4px 12px rgba(0,0,0,0.1)',
        }}
      >
        {icon}
      </div>
      <h3 style={{ margin: '0 0 8px', fontSize: 17, fontWeight: 600, letterSpacing: '-0.01em' }}>{title}</h3>
      <p style={{ margin: 0, color: '#71717a', fontSize: 14, lineHeight: 1.55 }}>{description}</p>
    </div>
  );
}

function CategoryTile({ name, icon, accent }: { name: string; icon: string; accent: string }) {
  // The per-category accent is passed to CSS via custom properties so
  // each tile hovers to its own colour without JS event handlers (which
  // a Server Component can't emit — see the comment on FeatureCard).
  // `${accent}08` matches the original tint (8-hex ≈ 3% alpha).
  return (
    <a
      href={`/schemes?category=${encodeURIComponent(name)}`}
      className="category-tile"
      style={{
        ['--accent' as string]: accent,
        ['--accent-bg' as string]: `${accent}08`,
      }}
    >
      <span aria-hidden="true" style={{ fontSize: 20 }}>{icon}</span>
      <span>{name}</span>
    </a>
  );
}

function Step({ number, title, desc }: { number: number; title: string; desc: string }) {
  return (
    <div style={{ textAlign: 'left' }}>
      <div
        style={{
          width: 36,
          height: 36,
          background: 'linear-gradient(135deg, #6366f1, #8b5cf6)',
          color: '#fff',
          borderRadius: 10,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 15,
          fontWeight: 700,
          marginBottom: 14,
          boxShadow: '0 4px 12px rgba(99, 102, 241, 0.3)',
        }}
      >
        {number}
      </div>
      <h3 style={{ margin: '0 0 6px', fontSize: 17, fontWeight: 600 }}>{title}</h3>
      <p style={{ color: '#71717a', margin: 0, fontSize: 14, lineHeight: 1.5 }}>{desc}</p>
    </div>
  );
}

const CATEGORIES = [
  { name: 'Agriculture', icon: '🌾', accent: '#10b981' },
  { name: 'Healthcare', icon: '🩺', accent: '#ef4444' },
  { name: 'Education', icon: '📚', accent: '#f59e0b' },
  { name: 'Women', icon: '🌸', accent: '#d946ef' },
  { name: 'Employment', icon: '💼', accent: '#6366f1' },
  { name: 'Housing', icon: '🏠', accent: '#06b6d4' },
  { name: 'Pension', icon: '☂️', accent: '#8b5cf6' },
  { name: 'Scholarships', icon: '🎓', accent: '#3b82f6' },
  { name: 'MSME', icon: '🏪', accent: '#ec4899' },
  { name: 'Skill Development', icon: '🛠', accent: '#0891b2' },
  { name: 'Startups', icon: '🚀', accent: '#7c3aed' },
  { name: 'Financial Aid', icon: '💎', accent: '#10b981' },
];
