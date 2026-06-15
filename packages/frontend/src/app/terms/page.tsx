import type { Metadata } from 'next';
import { LegalPage } from '../../components/LegalPage';

export const metadata: Metadata = {
  title: 'Terms of Service — Bharat Benefits AI',
  description: 'Terms governing the use of the Bharat Benefits AI platform.',
};

export default function TermsPage() {
  return (
    <LegalPage
      pill="Legal"
      title="Terms of Service"
      subtitle="The rules of using Bharat Benefits AI."
      lastUpdated="June 15, 2026"
    >
      <div className="callout">
        <strong>Template notice</strong>
        This is a template terms of service provided for development purposes. Have it reviewed by
        a qualified legal professional before launching publicly.
      </div>

      <h2>1. Acceptance of Terms</h2>
      <p>
        By accessing or using Bharat Benefits AI (&quot;the Platform&quot;), you agree to be bound by
        these Terms of Service. If you do not agree, please do not use the Platform.
      </p>

      <h2>2. Eligibility</h2>
      <p>You must be at least 18 years old to create an account and use the Platform.</p>

      <h2>3. Account Registration</h2>
      <ul>
        <li>You must provide accurate, complete, and current information</li>
        <li>You are responsible for maintaining the confidentiality of your password</li>
        <li>You are responsible for all activity under your account</li>
        <li>Notify us immediately of any unauthorized access</li>
      </ul>

      <h2>4. What the Platform Is</h2>
      <p>
        Bharat Benefits AI is an information and discovery platform. It helps you find Indian
        government welfare schemes, check eligibility, and understand application processes. It is
        <strong> not </strong>
        a government agency, and it does not process scheme applications on your behalf.
      </p>

      <h2>5. What the Platform Is Not</h2>
      <ul>
        <li>
          <strong>Not legal advice.</strong> Information provided is for general guidance only.
        </li>
        <li>
          <strong>Not a guarantee.</strong> Eligibility calculations are estimates based on the
          data you provide and the latest available scheme criteria. Final eligibility is
          determined by the relevant government authority.
        </li>
        <li>
          <strong>Not a government service.</strong> We are an independent platform that
          aggregates publicly available information.
        </li>
      </ul>

      <h2>6. Use of AI Assistant</h2>
      <p>
        The AI Assistant uses retrieval-augmented generation to answer your questions based on
        verified scheme data. While we strive for accuracy:
      </p>
      <ul>
        <li>AI responses may occasionally contain inaccuracies</li>
        <li>Always verify critical information against the official source URL provided</li>
        <li>The AI declines to answer questions outside the scope of government schemes</li>
        <li>The AI does not provide legal, financial, or medical advice</li>
      </ul>

      <h2>7. Acceptable Use</h2>
      <p>You agree not to:</p>
      <ul>
        <li>Submit false or misleading profile information</li>
        <li>Use the Platform for any unlawful purpose</li>
        <li>Attempt to gain unauthorized access to any part of the Platform</li>
        <li>Scrape, copy, or redistribute scheme data without permission</li>
        <li>Submit malicious or abusive queries to the AI assistant</li>
        <li>Impersonate another person or government agency</li>
        <li>Interfere with or disrupt the Platform or its servers</li>
      </ul>

      <h2>8. Data Source Disclaimer</h2>
      <p>
        Scheme data is sourced from official government portals (gov.in, nic.in, ministry
        websites, and state government portals). While we verify and update this data regularly,
        we cannot guarantee that information is always current. Always check the official source
        URL before applying.
      </p>

      <h2>9. Intellectual Property</h2>
      <p>
        The Platform&apos;s design, code, and original content are the intellectual property of
        Bharat Benefits AI. Government scheme data remains the property of the respective
        government bodies and is presented under fair use for citizen benefit.
      </p>

      <h2>10. Limitation of Liability</h2>
      <p>
        To the maximum extent permitted by law, Bharat Benefits AI shall not be liable for any
        indirect, incidental, consequential, or punitive damages arising from:
      </p>
      <ul>
        <li>Your use or inability to use the Platform</li>
        <li>Errors or inaccuracies in scheme data or AI responses</li>
        <li>Decisions you make based on information from the Platform</li>
        <li>Outcomes of scheme applications</li>
        <li>Unauthorized access to your account due to your password compromise</li>
      </ul>

      <h2>11. Termination</h2>
      <p>
        We may suspend or terminate your account if you violate these Terms. You may delete your
        account at any time from your <a href="/profile">profile page</a>.
      </p>

      <h2>12. Changes to These Terms</h2>
      <p>
        We may modify these Terms occasionally. Material changes will be communicated via in-app
        notification or email at least 30 days before they take effect. Continued use after
        changes take effect constitutes acceptance.
      </p>

      <h2>13. Governing Law</h2>
      <p>
        These Terms are governed by the laws of India. Disputes shall be resolved in the courts of
        competent jurisdiction in India.
      </p>

      <h2>14. Contact</h2>
      <p>
        For questions about these Terms, contact us at{' '}
        <a href="mailto:legal@bharatbenefits.ai">legal@bharatbenefits.ai</a>.
      </p>
    </LegalPage>
  );
}
