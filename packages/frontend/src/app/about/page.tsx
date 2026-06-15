import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'About — Bharat Benefits AI',
  description: 'Learn about Bharat Benefits AI, an AI-powered platform helping Indian citizens discover government welfare schemes.',
};

export default function AboutPage() {
  return (
    <main id="main-content" tabIndex={-1} style={pageStyle}>
      <div style={heroStyle}>
        <span style={pillStyle}>About us</span>
        <h1 style={h1Style}>
          Building a smarter way to access
          <br />
          <span className="gradient-text">government benefits.</span>
        </h1>
        <p style={leadStyle}>
          Bharat Benefits AI is an AI-powered platform that helps Indian citizens discover,
          understand, and apply for verified Central and State Government welfare schemes.
        </p>
      </div>

      <Section title="The problem">
        <p>
          India offers thousands of welfare schemes across Central and State Governments — covering
          agriculture, healthcare, education, housing, women&apos;s welfare, employment, and more.
          Yet most citizens never benefit from them.
        </p>
        <p>The reasons are familiar:</p>
        <ul style={listStyle}>
          <li>Information is scattered across hundreds of government portals</li>
          <li>Eligibility criteria are written in dense, technical language</li>
          <li>Citizens don&apos;t know which schemes they qualify for</li>
          <li>Application processes are confusing and intimidating</li>
          <li>Language barriers exclude millions of non-English speakers</li>
        </ul>
      </Section>

      <Section title="Our approach">
        <p>
          We use AI to read official government scheme data, structure it into a unified format,
          and present it in plain language. Citizens can ask questions in their own words and get
          answers backed by verified sources — no jargon, no guesswork.
        </p>
        <p>
          Every scheme on this platform is sourced exclusively from official government portals
          (gov.in, nic.in, ministry websites, and state government portals). We never use
          unofficial third-party sources.
        </p>
      </Section>

      <Section title="What you can do here">
        <ul style={listStyle}>
          <li>
            <strong>Discover schemes</strong> across 12 categories — agriculture, healthcare,
            education, women&apos;s welfare, and more
          </li>
          <li>
            <strong>Check your eligibility</strong> instantly based on age, income, occupation,
            state, and other profile details
          </li>
          <li>
            <strong>Ask the AI assistant</strong> any question about schemes and get cited answers
          </li>
          <li>
            <strong>Save schemes to your dashboard</strong> and track application deadlines
          </li>
          <li>
            <strong>Compare up to 3 schemes</strong> side-by-side to make informed choices
          </li>
          <li>
            <strong>Use the platform in 6 languages</strong> — English, Hindi, Bengali, Tamil,
            Telugu, and Marathi
          </li>
        </ul>
      </Section>

      <Section title="Our principles">
        <PrincipleGrid>
          <Principle
            title="Verified data only"
            desc="Every scheme is verified against its official source. No rumors, no unofficial summaries."
          />
          <Principle
            title="Privacy by design"
            desc="Your profile is encrypted at rest. We never sell or share your data."
          />
          <Principle
            title="Accessible to all"
            desc="WCAG 2.1 AA compliant. Mobile-first. Multilingual. Voice-friendly."
          />
          <Principle
            title="Transparent AI"
            desc="Every AI answer cites its sources. You can always verify directly."
          />
        </PrincipleGrid>
      </Section>

      <CtaSection />
    </main>
  );
}

/* ─── Layout helpers ─────────────────────────────────────────────────── */

const pageStyle: React.CSSProperties = {
  maxWidth: 900,
  margin: '0 auto',
  padding: '60px 24px 80px',
};

const heroStyle: React.CSSProperties = {
  textAlign: 'center',
  marginBottom: 60,
};

const pillStyle: React.CSSProperties = {
  display: 'inline-block',
  padding: '5px 12px',
  background: 'rgba(99, 102, 241, 0.08)',
  border: '1px solid rgba(99, 102, 241, 0.2)',
  borderRadius: 9999,
  fontSize: 12,
  fontWeight: 600,
  color: '#4338ca',
  marginBottom: 20,
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
};

const h1Style: React.CSSProperties = {
  fontSize: 'clamp(34px, 6vw, 56px)',
  margin: '0 0 20px',
  lineHeight: 1.05,
  letterSpacing: '-0.04em',
};

const leadStyle: React.CSSProperties = {
  fontSize: 18,
  color: '#52525b',
  maxWidth: 640,
  margin: '0 auto',
  lineHeight: 1.55,
};

const listStyle: React.CSSProperties = {
  paddingLeft: 24,
  lineHeight: 1.8,
  color: '#52525b',
};

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ marginBottom: 56 }}>
      <h2 style={{ fontSize: 26, marginBottom: 16, letterSpacing: '-0.02em' }}>{title}</h2>
      <div style={{ fontSize: 16, lineHeight: 1.7, color: '#52525b' }}>{children}</div>
    </section>
  );
}

function PrincipleGrid({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
        gap: 16,
        marginTop: 8,
      }}
    >
      {children}
    </div>
  );
}

function Principle({ title, desc }: { title: string; desc: string }) {
  return (
    <div
      style={{
        padding: 20,
        background: '#fff',
        border: '1px solid #e4e4e7',
        borderRadius: 12,
      }}
    >
      <h3 style={{ margin: '0 0 6px', fontSize: 16, fontWeight: 600 }}>{title}</h3>
      <p style={{ margin: 0, color: '#71717a', fontSize: 14, lineHeight: 1.5 }}>{desc}</p>
    </div>
  );
}

function CtaSection() {
  return (
    <section
      style={{
        marginTop: 80,
        padding: 48,
        textAlign: 'center',
        background: 'linear-gradient(135deg, #fafafa 0%, #f4f4f5 100%)',
        border: '1px solid #e4e4e7',
        borderRadius: 20,
      }}
    >
      <h2 style={{ marginTop: 0, marginBottom: 12 }}>Ready to find your benefits?</h2>
      <p style={{ color: '#71717a', maxWidth: 480, margin: '0 auto 24px' }}>
        Create your free account and discover schemes tailored to your profile.
      </p>
      <a
        href="/register"
        className="btn-primary"
        style={{ padding: '13px 28px', fontSize: 16, textDecoration: 'none' }}
      >
        Get started — it&apos;s free →
      </a>
    </section>
  );
}
