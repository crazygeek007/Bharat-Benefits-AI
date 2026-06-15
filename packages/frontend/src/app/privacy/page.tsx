import type { Metadata } from 'next';
import { LegalPage } from '../../components/LegalPage';

export const metadata: Metadata = {
  title: 'Privacy Policy — Bharat Benefits AI',
  description: 'How Bharat Benefits AI collects, uses, and protects your personal information.',
};

export default function PrivacyPage() {
  return (
    <LegalPage
      pill="Privacy"
      title="Privacy Policy"
      subtitle="How we collect, use, and protect your information."
      lastUpdated="June 15, 2026"
    >
      <div className="callout">
        <strong>Template notice</strong>
        This is a template privacy policy provided for development purposes. Before launching
        publicly, have it reviewed by a qualified legal professional to ensure compliance with the
        Digital Personal Data Protection Act (DPDP Act, 2023) and any other applicable laws.
      </div>

      <h2>1. Introduction</h2>
      <p>
        Bharat Benefits AI (&quot;we,&quot; &quot;us,&quot; or &quot;the Platform&quot;) is committed to protecting your
        privacy. This Privacy Policy explains how we collect, use, store, and protect your
        personal information when you use our platform.
      </p>

      <h2>2. Information We Collect</h2>
      <h3>2.1 Information you provide</h3>
      <p>When you create an account and complete your profile, we collect:</p>
      <ul>
        <li>Email address and password (passwords are hashed with bcrypt)</li>
        <li>Demographic information: age, gender, state of residence, district</li>
        <li>Financial information: annual household income</li>
        <li>Occupational information: occupation, education level</li>
        <li>Optional fields: caste category, marital status, disability status, dependents</li>
        <li>Schemes you save, mark as applied, or interact with</li>
        <li>Questions you submit to the AI assistant</li>
      </ul>

      <h3>2.2 Information collected automatically</h3>
      <ul>
        <li>Session data and authentication tokens</li>
        <li>Application logs (request timestamps, IP addresses, user agent)</li>
        <li>Audit logs of profile data access and modifications</li>
      </ul>

      <h2>3. How We Use Your Information</h2>
      <p>We use your information solely to:</p>
      <ul>
        <li>Calculate your eligibility for government welfare schemes</li>
        <li>Generate personalized scheme recommendations</li>
        <li>Answer your questions through the AI assistant</li>
        <li>Send you notifications about deadlines and scheme changes (when enabled)</li>
        <li>Maintain platform security and audit logs</li>
        <li>Improve the platform&apos;s accuracy and helpfulness</li>
      </ul>
      <p>
        <strong>We never sell, rent, or share your personal information with third parties for
        advertising or marketing purposes.</strong>
      </p>

      <h2>4. Data Security</h2>
      <ul>
        <li>All profile data is encrypted at rest using AES-256</li>
        <li>All data in transit is protected with TLS 1.2 or higher</li>
        <li>Passwords are hashed using bcrypt</li>
        <li>Sessions automatically expire after 30 minutes of inactivity</li>
        <li>Account is locked for 15 minutes after 5 consecutive failed login attempts</li>
        <li>Profile access and modifications are logged and retained for 365 days</li>
      </ul>

      <h2>5. AI Processing</h2>
      <p>
        When you use the AI Scheme Assistant, your queries are processed by Google Gemini AI to
        generate responses. We log queries, retrieved context, and generated responses for 90 days
        for quality assurance and audit purposes.
      </p>
      <p>
        Queries are <strong>not</strong> used to train AI models. They are stored locally and used
        only to evaluate platform accuracy.
      </p>

      <h2>6. Data Sharing</h2>
      <p>
        We share data only with the following service providers, strictly to operate the platform:
      </p>
      <ul>
        <li>
          <strong>Cloud hosting</strong> — for application servers and database
        </li>
        <li>
          <strong>Google Gemini AI</strong> — for processing assistant queries
        </li>
        <li>
          <strong>Pinecone</strong> — for storing scheme embeddings (no personal data)
        </li>
        <li>
          <strong>Email delivery providers</strong> — for sending notifications (when enabled)
        </li>
      </ul>
      <p>
        We do not share data with government agencies except when required by law or when you
        explicitly link your account to apply for a scheme.
      </p>

      <h2>7. Your Rights</h2>
      <p>Under the DPDP Act and other applicable laws, you have the right to:</p>
      <ul>
        <li>
          <strong>Access</strong> your personal data
        </li>
        <li>
          <strong>Correct</strong> inaccurate or outdated information
        </li>
        <li>
          <strong>Delete</strong> your account and all associated data
        </li>
        <li>
          <strong>Export</strong> your data in a portable format
        </li>
        <li>
          <strong>Withdraw consent</strong> at any time
        </li>
      </ul>
      <p>
        To exercise these rights, visit your <a href="/profile">profile page</a> or contact us at
        the support email below.
      </p>

      <h2>8. Data Retention</h2>
      <ul>
        <li>Profile data: retained until you request deletion</li>
        <li>Audit logs: 365 days</li>
        <li>AI assistant query logs: 90 days</li>
        <li>Account deletion requests are completed within 30 days</li>
      </ul>

      <h2>9. Cookies</h2>
      <p>
        We use only essential cookies for authentication and session management. We do not use
        third-party tracking, advertising, or analytics cookies.
      </p>

      <h2>10. Children&apos;s Privacy</h2>
      <p>
        The Platform is not intended for children under 18. We do not knowingly collect data from
        minors. If you believe we have inadvertently collected a minor&apos;s data, please contact
        us so we can remove it.
      </p>

      <h2>11. Changes to This Policy</h2>
      <p>
        We may update this Privacy Policy occasionally. Material changes will be communicated via
        in-app notification or email at least 30 days before they take effect.
      </p>

      <h2>12. Contact</h2>
      <p>
        For privacy questions, data requests, or concerns, contact us at{' '}
        <a href="mailto:privacy@bharatbenefits.ai">privacy@bharatbenefits.ai</a>.
      </p>
    </LegalPage>
  );
}
