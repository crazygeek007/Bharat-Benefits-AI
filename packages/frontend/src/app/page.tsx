'use client';

import { MAIN_CONTENT_ID } from '../components/SkipLink';

/**
 * Modern AI SaaS landing page.
 */
export default function Home() {
  return (
    <main id={MAIN_CONTENT_ID} tabIndex={-1} style={{ overflow: 'hidden' }}>
      {/* HERO ───────────────────────────────────────────────────────── */}
      <section
        style={{
          position: 'relative',
          maxWidth: 1200,
          margin: '0 auto',
          padding: '80px 24px 100px',
          textAlign: 'center',
        }}
      >
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
          Powered by Gemini AI · Verified gov sources
        </div>

        <h1
          style={{
            fontSize: 'clamp(40px, 7vw, 76px)',
            fontWeight: 700,
            lineHeight: 1,
            letterSpacing: '-0.045em',
            margin: '0 0 24px',
            maxWidth: 900,
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

        {/* Hero stats */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
            gap: 24,
            maxWidth: 600,
            margin: '64px auto 0',
            textAlign: 'center',
          }}
        >
          <Stat value="12+" label="Verified schemes" />
          <Stat value="6" label="Languages" />
          <Stat value="100%" label="Official sources" />
        </div>
      </section>

      {/* FEATURES ───────────────────────────────────────────────────── */}
      <section
        aria-labelledby="features-heading"
        style={{
          maxWidth: 1200,
          margin: '0 auto',
          padding: '40px 24px 80px',
        }}
      >
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
      <section
        aria-labelledby="categories-heading"
        style={{
          maxWidth: 1200,
          margin: '0 auto',
          padding: '40px 24px 80px',
        }}
      >
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
      <section
        aria-labelledby="how-heading"
        style={{
          maxWidth: 1200,
          margin: '0 auto',
          padding: '40px 24px 80px',
        }}
      >
        <div
          style={{
            background:
              'linear-gradient(135deg, #fafafa 0%, #f4f4f5 100%)',
            border: '1px solid #e4e4e7',
            borderRadius: 24,
            padding: 48,
            position: 'relative',
            overflow: 'hidden',
          }}
        >
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
      <section
        style={{
          maxWidth: 1200,
          margin: '0 auto',
          padding: '0 24px 80px',
        }}
      >
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
  return (
    <div
      style={{
        padding: 28,
        background: '#fff',
        border: '1px solid #e4e4e7',
        borderRadius: 16,
        transition: 'all 0.2s cubic-bezier(0.16, 1, 0.3, 1)',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.transform = 'translateY(-2px)';
        e.currentTarget.style.borderColor = '#d4d4d8';
        e.currentTarget.style.boxShadow = '0 10px 25px -5px rgba(0,0,0,0.08)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.transform = 'translateY(0)';
        e.currentTarget.style.borderColor = '#e4e4e7';
        e.currentTarget.style.boxShadow = 'none';
      }}
    >
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
  return (
    <a
      href={`/schemes?category=${encodeURIComponent(name)}`}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '14px 18px',
        background: '#fff',
        border: '1px solid #e4e4e7',
        borderRadius: 12,
        textDecoration: 'none',
        color: '#09090b',
        fontSize: 14.5,
        fontWeight: 500,
        transition: 'all 0.2s cubic-bezier(0.16, 1, 0.3, 1)',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = accent;
        e.currentTarget.style.background = `${accent}08`;
        e.currentTarget.style.transform = 'translateY(-1px)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = '#e4e4e7';
        e.currentTarget.style.background = '#fff';
        e.currentTarget.style.transform = 'translateY(0)';
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
