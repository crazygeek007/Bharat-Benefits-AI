import type { Metadata } from 'next';
import { LegalPage } from '../../components/LegalPage';

export const metadata: Metadata = {
  title: 'Accessibility — Bharat Benefits AI',
  description: 'Bharat Benefits AI is committed to accessibility for all citizens, including those with disabilities.',
};

export default function AccessibilityPage() {
  return (
    <LegalPage
      pill="Accessibility"
      title="Accessibility statement"
      subtitle="Built for everyone — including citizens using assistive technology."
      lastUpdated="June 15, 2026"
    >
      <h2>Our commitment</h2>
      <p>
        Government welfare schemes exist to support every citizen — and accessing them shouldn&apos;t
        require perfect vision, hearing, motor control, or technical fluency. Bharat Benefits AI is
        designed to work for everyone.
      </p>

      <h2>What we do to support accessibility</h2>

      <h3>WCAG 2.1 Level AA conformance</h3>
      <p>
        The Platform is built to conform to the Web Content Accessibility Guidelines (WCAG) 2.1
        Level AA. This includes:
      </p>
      <ul>
        <li>Minimum contrast ratio of 4.5:1 for normal text and 3:1 for large text and UI components</li>
        <li>All interactive elements reachable and operable via keyboard alone</li>
        <li>Visible focus indicators on every interactive element</li>
        <li>Semantic HTML with proper heading hierarchy and landmark regions</li>
        <li>ARIA labels and live regions for dynamic content</li>
        <li>Form errors programmatically associated with their input fields</li>
      </ul>

      <h3>Keyboard navigation</h3>
      <ul>
        <li>Tab and Shift+Tab move focus through all interactive elements in logical reading order</li>
        <li>Enter and Space activate buttons and links</li>
        <li>Escape dismisses modals and dropdowns</li>
        <li>Arrow keys navigate within composite widgets (menus, tab lists)</li>
      </ul>

      <h3>Screen reader support</h3>
      <p>
        The Platform is tested with major screen readers including NVDA, JAWS, and VoiceOver.
        Dynamic content changes (notifications, search results, loading states) are announced via
        ARIA live regions.
      </p>

      <h3>Mobile and touch</h3>
      <ul>
        <li>All touch targets are at least 44 × 44 CSS pixels on mobile</li>
        <li>No horizontal scrolling required on screen widths from 320px to 2560px</li>
        <li>Text resizes properly up to 200% zoom without loss of content</li>
      </ul>

      <h3>Motion and animation</h3>
      <p>
        We respect the <code>prefers-reduced-motion</code> setting. If you have reduced motion
        enabled in your operating system, animations on the Platform are disabled or shortened.
      </p>

      <h3>Multilingual support</h3>
      <p>
        The Platform is available in English, Hindi, Bengali, Tamil, Telugu, and Marathi. The
        <code>lang</code> attribute is set correctly so screen readers pronounce content in the
        right language.
      </p>

      <h3>Voice assistant</h3>
      <p>
        For citizens who prefer or need voice interaction, we offer a voice-based AI assistant
        that supports speech-to-text and text-to-speech in all six platform languages.
      </p>

      <h2>Known limitations</h2>
      <p>
        We continuously improve accessibility, but some areas may have limitations:
      </p>
      <ul>
        <li>Some scheme content imported from PDF sources may not be fully reformatted</li>
        <li>AI-generated responses may occasionally use complex language; we&apos;re actively
          improving plain-language output</li>
      </ul>

      <h2>Feedback</h2>
      <p>
        We welcome feedback from citizens who experience accessibility barriers. If something
        doesn&apos;t work for you, please email us at{' '}
        <a href="mailto:accessibility@bharatbenefits.ai">accessibility@bharatbenefits.ai</a>. We
        commit to responding within 5 business days and fixing critical issues as quickly as
        possible.
      </p>

      <h2>Standards we follow</h2>
      <ul>
        <li>WCAG 2.1 Level AA</li>
        <li>Section 508 of the U.S. Rehabilitation Act</li>
        <li>EN 301 549 (European accessibility standard for ICT)</li>
        <li>Rights of Persons with Disabilities Act, 2016 (India)</li>
      </ul>
    </LegalPage>
  );
}
