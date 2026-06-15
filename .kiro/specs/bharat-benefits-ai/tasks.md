# Implementation Plan: Bharat Benefits AI

## Overview

This implementation plan covers the full-stack AI-powered platform for helping Indian citizens discover, understand, and apply for government welfare schemes. The plan is organized into progressive phases: project setup, data layer, core services, AI pipeline, frontend, background workers, and integration wiring. Each task builds incrementally on previous work, using TypeScript throughout with Next.js 14 for the frontend and Node.js for the backend.

## Tasks

- [x] 1. Set up project structure and core interfaces
  - [x] 1.1 Initialize monorepo with Next.js frontend and Node.js backend
    - Create project root with `packages/frontend` (Next.js 14) and `packages/backend` (Node.js with Fastify)
    - Configure TypeScript, ESLint, Prettier across both packages
    - Set up Vitest and fast-check as test dependencies
    - Configure path aliases and shared types package
    - _Requirements: 18.1, 19.2_

  - [x] 1.2 Define core TypeScript interfaces and types
    - Create `packages/shared/types` with all interfaces from design: `Scheme`, `UserProfile`, `EligibilityResult`, `Recommendation`, `SchemeRelationship`, `AssistantResponse`, `Dashboard`, etc.
    - Define `SupportedLanguage`, `SchemeCategory`, `SchemeStatus`, `ProfileConstraints`, `PasswordPolicy` types
    - Define `EligibilityCriterion`, `Benefit`, `SchemeObject` with mandatory/optional field structure
    - _Requirements: 3.1, 4.1, 5.2, 22.1_

  - [x] 1.3 Set up database schema and migrations
    - Configure PostgreSQL with migration tool (e.g., Prisma or Knex)
    - Create tables: `users`, `user_profiles`, `schemes`, `scheme_versions`, `scheme_compatibility`, `saved_schemes`, `scheme_documents`, `notifications`, `audit_logs`, `scheme_embeddings`
    - Define indexes for common query patterns (scheme by category, state, trust score)
    - _Requirements: 1.3, 3.5, 16.6_

  - [x] 1.4 Set up Redis, Elasticsearch, and Vector DB connections
    - Configure Redis client for session management and caching
    - Configure Elasticsearch client for full-text search indexing
    - Configure Pinecone/pgvector client for vector embeddings
    - _Requirements: 18.5, 2.6_

- [x] 2. Implement authentication and security
  - [x] 2.1 Implement authentication service with NextAuth.js
    - Configure email/password and social login providers
    - Implement JWT session management with 30-minute inactivity timeout
    - Implement account lockout after 5 consecutive failed attempts for 15 minutes
    - Set up AES-256 encryption at rest for user profile data
    - Configure TLS 1.2+ enforcement for all API routes
    - _Requirements: 16.1, 16.2, 16.3, 16.4, 16.5, 16.8_

  - [x] 2.2 Write property test for password validation
    - **Property 23: Password Policy Validation**
    - **Validates: Requirements 16.2**

  - [x] 2.3 Write property test for authentication guard
    - **Property 24: Authentication Guard**
    - **Validates: Requirements 16.1**

  - [x] 2.4 Implement audit logging middleware
    - Create audit log service that records all profile data access and modifications
    - Store action, timestamp, actor identity; retain logs for minimum 365 days
    - _Requirements: 16.6_

- [x] 3. Implement User Profile Management
  - [x] 3.1 Implement user profile service with validation
    - Create `UserProfileService` with `createProfile`, `updateProfile`, `deleteProfile`, `validateProfileData` methods
    - Implement validation: age [0,150], income [0, 9999999999], gender in {Male, Female, Other}, required fields check, enum validations for occupation, education, caste, marital status
    - Implement 30-day deletion scheduling with confirmation flow
    - _Requirements: 3.1, 3.2, 3.4, 3.5, 3.6, 3.7_

  - [x] 3.2 Write property test for user profile validation
    - **Property 6: User Profile Validation**
    - **Validates: Requirements 3.1, 3.2, 3.4**

- [x] 4. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 5. Implement Crawler System and Scheme Ingestion
  - [x] 5.1 Implement source URL validation and trust score calculation
    - Create `validateSource(url)` function accepting only gov.in, nic.in, and configured official portal domains
    - Implement `calculateTrustScore` returning integer in [0, 100] based on source reliability checks
    - Implement visibility logic: schemes with Trust_Score < 60 are hidden from citizens
    - _Requirements: 1.1, 1.2, 1.6, 1.7_

  - [x] 5.2 Write property test for source URL validation
    - **Property 1: Source URL Validation**
    - **Validates: Requirements 1.1, 1.2**

  - [x] 5.3 Write property test for trust score bounds and visibility
    - **Property 2: Trust Score Bounds and Visibility**
    - **Validates: Requirements 1.6, 1.7**

  - [x] 5.4 Implement scheme data parsing (HTML, PDF, JSON, XML)
    - Create parsers using Cheerio for HTML, pdf-parse for PDF (up to 50MB), and native JSON/XML parsing
    - Implement standardized `SchemeObject` extraction with mandatory field enforcement (name, description, eligibility criteria, benefits, source URL, ministry)
    - Set optional fields to null when unparseable; reject scheme when mandatory fields missing
    - _Requirements: 22.1, 22.2, 22.5, 22.6, 22.7_

  - [x] 5.5 Write property test for scheme parsing mandatory field enforcement
    - **Property 20: Scheme Parsing Mandatory Field Enforcement**
    - **Validates: Requirements 22.6, 22.7**

  - [x] 5.6 Implement scheme serialization and round-trip consistency
    - Implement JSON serialization/deserialization for Scheme objects
    - Ensure semantic equivalence on round-trip (serialize → parse → serialize)
    - _Requirements: 22.3, 22.4_

  - [x] 5.7 Write property test for scheme serialization round-trip
    - **Property 19: Scheme Serialization Round-Trip**
    - **Validates: Requirements 22.4**

  - [x] 5.8 Write property test for scheme metadata completeness on ingestion
    - **Property 3: Scheme Metadata Completeness on Ingestion**
    - **Validates: Requirements 1.3**

  - [x] 5.9 Implement daily crawl workflow orchestration
    - Create worker process that executes daily crawl: discovery → extraction → verification → categorization → DB update → vector index → change detection
    - Process new schemes within 10 minutes of discovery
    - Complete full crawl within 6 hours; log failures and notify admins within 15 minutes
    - Extract compatibility relationships during ingestion
    - _Requirements: 1.4, 1.5, 1.8, 1.9, 7.5, 7.6_

  - [x] 5.10 Implement embedding generation and vector indexing
    - Generate embeddings using OpenAI text-embedding-3-small for each scheme
    - Store embeddings in vector database with scheme ID and chunk index
    - Index schemes in Elasticsearch for full-text search
    - _Requirements: 6.1, 2.6_

- [x] 6. Implement Eligibility Engine
  - [x] 6.1 Implement eligibility calculation logic
    - Create `EligibilityEngine` with `calculateEligibility`, `recalculateAllSavedSchemes`, `evaluateCriterion` methods
    - Return status: Eligible (all met), Partially Eligible (some met, some unevaluable), Not Eligible (at least one unmet)
    - List unmet criteria with requirement and profile value; list missing profile fields for partial eligibility
    - Base calculations exclusively on officially published criteria
    - Recalculate all saved schemes within 30 seconds of profile update
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 3.3_

  - [x] 6.2 Write property test for eligibility calculation correctness
    - **Property 7: Eligibility Calculation Correctness**
    - **Validates: Requirements 4.1, 4.2, 4.3, 4.5**

- [x] 7. Implement Recommendation Engine
  - [x] 7.1 Implement recommendation generation with state-aware prioritization
    - Create `RecommendationEngine` with `generateRecommendations`, `calculateMatchScore`, `applyStateAwarePrioritization`
    - Match_Score in [0, 100]; rank by Match_Score → Benefit Amount → Deadline proximity
    - Boost schemes with deadlines within 30 days; exclude Not Eligible schemes
    - State-aware grouping: citizen's state schemes first, then Central, then other states
    - Generate explanation (max 200 chars) for each recommendation; return max 50 schemes
    - Regenerate within 60 seconds of profile change
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8, 23.1, 23.2, 23.3, 23.4, 23.5_

  - [x] 7.2 Write property test for recommendation ranking order
    - **Property 8: Recommendation Ranking Order**
    - **Validates: Requirements 5.1, 5.3**

  - [x] 7.3 Write property test for recommendation output invariants
    - **Property 9: Recommendation Output Invariants**
    - **Validates: Requirements 5.2, 5.6, 5.7**

  - [x] 7.4 Write property test for ineligible scheme exclusion
    - **Property 10: Ineligible Scheme Exclusion from Recommendations**
    - **Validates: Requirements 5.4**

  - [x] 7.5 Write property test for state-aware recommendation prioritization
    - **Property 21: State-Aware Recommendation Prioritization**
    - **Validates: Requirements 23.1, 23.2, 23.4**

- [x] 8. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 9. Implement Scheme Assistant (RAG-based Q&A)
  - [x] 9.1 Implement RAG retrieval and response generation
    - Create `SchemeAssistant` with `answerQuery`, `retrieveContext`, `detectLanguage` methods
    - Retrieve top 5 most relevant chunks from vector DB; generate response using GPT-4
    - Include source URL and last updated date for each referenced scheme
    - Respond within 5 seconds; limit response to 500 words
    - Refuse unverified answers; decline non-scheme questions
    - Maintain 5-exchange conversational context per session
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 6.8_

  - [x] 9.2 Write property test for scheme assistant response structure
    - **Property 11: Scheme Assistant Response Structure**
    - **Validates: Requirements 6.2, 6.8**

  - [x] 9.3 Implement multi-agent pipeline orchestration
    - Create `MultiAgentPipeline` with Planner, Eligibility, Retrieval, Compatibility, Recommendation, and Response agents
    - Planner analyzes intent and routes to relevant agents (skip irrelevant ones)
    - Retrieval agent fetches top 10 chunks; Compatibility agent filters incompatible schemes
    - Complete pipeline within 10 seconds; bypass agents that timeout after 5 seconds
    - Assign unique trace ID spanning all agents
    - _Requirements: 25.1, 25.2, 25.3, 25.4, 25.5, 25.6, 25.7, 25.8, 25.9, 25.10_

  - [x] 9.4 Write property test for multi-agent planner routing validity
    - **Property 28: Multi-Agent Planner Routing Validity**
    - **Validates: Requirements 25.2**

  - [x] 9.5 Write property test for compatibility filtering in pipeline
    - **Property 29: Compatibility Filtering in Pipeline**
    - **Validates: Requirements 25.5**

- [x] 10. Implement Compatibility Engine
  - [x] 10.1 Implement scheme compatibility relationships and checks
    - Create `CompatibilityEngine` with `getRelationships`, `checkCompatibility`, `getPrerequisites`
    - Maintain `can_combine_with`, `cannot_combine_with`, `prerequisite_schemes` relationships
    - Display compatible/incompatible schemes with official rules
    - Warn on saving incompatible schemes; display prerequisite chains in topological order
    - Handle unknown compatibility status gracefully
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.7_

  - [x] 10.2 Write property test for incompatibility warning on save
    - **Property 12: Incompatibility Warning on Save**
    - **Validates: Requirements 7.3**

  - [x] 10.3 Write property test for prerequisite ordering
    - **Property 13: Prerequisite Ordering**
    - **Validates: Requirements 7.4**

- [x] 11. Implement Document Checklist and Application Guidance
  - [x] 11.1 Implement document checklist generator
    - Create `DocumentChecklistGenerator` that displays required and optional documents with name, description, format
    - Implement shared-document detection across saved schemes
    - Handle schemes with no document requirements
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.6_

  - [x] 11.2 Write property test for shared document detection
    - **Property 14: Shared Document Detection**
    - **Validates: Requirements 8.4**

  - [x] 11.3 Implement application guidance service
    - Create step-by-step application instructions with numbered steps (action + expected outcome)
    - Provide official application link; list at least 3 common mistakes
    - Indicate online/offline/hybrid mode with office addresses for offline
    - Handle inaccessible application portals gracefully
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5_

- [x] 12. Implement Benefits Dashboard and Deadline Tracking
  - [x] 12.1 Implement benefits dashboard service
    - Create `BenefitsDashboardService` with `getDashboard`, `markAsApplied`, `saveScheme`, `calculateEstimatedBenefitValue`
    - Group schemes by status: Eligible, Applied, Saved, Expired
    - Calculate Estimated Total Benefit Value from monetary Eligible schemes only
    - Enforce 100 saved schemes limit; handle empty states
    - Transition expired schemes; retain Applied status regardless of deadline
    - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.5, 11.6, 11.7, 10.1_

  - [x] 12.2 Write property test for dashboard status grouping and transitions
    - **Property 16: Dashboard Status Grouping and Transitions**
    - **Validates: Requirements 11.1, 11.3, 11.4, 11.5**

  - [x] 12.3 Write property test for estimated benefit value calculation
    - **Property 17: Estimated Benefit Value Calculation**
    - **Validates: Requirements 11.2, 11.6**

  - [x] 12.4 Implement deadline tracker and notification service
    - Create `DeadlineTracker` and `NotificationService` with email (AWS SES) and in-app (WebSocket) channels
    - Send notification at 7 days; high-priority at 24h and 6h before deadline
    - Display deadlines within 90 days in calendar/timeline view
    - Notify on deadline changes; retry failed emails 3 times; fallback to in-app
    - Handle rolling/no-deadline schemes with "Open/No Deadline" indicator
    - _Requirements: 10.2, 10.3, 10.4, 10.5, 10.6, 10.7, 10.8_

  - [x] 12.5 Write property test for deadline notification logic
    - **Property 15: Deadline Notification Logic**
    - **Validates: Requirements 10.1, 10.2, 10.7**

  - [x] 12.6 Write property test for deadline display filtering
    - **Property 30: Deadline Display Filtering**
    - **Validates: Requirements 10.4**

- [x] 13. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 14. Implement Change Detection and Missed Benefits
  - [x] 14.1 Implement change detector service
    - Create `ChangeDetector` that records previous/new values, change date, source URL
    - Maintain at least 50 most recent versions per scheme
    - Notify affected citizens within 60 minutes of change detection
    - Recalculate Estimated Total Benefit Value within 30 seconds of benefit amount change
    - Handle source unavailability gracefully (retain last known, retry next cycle)
    - _Requirements: 14.1, 14.2, 14.3, 14.4, 14.5, 14.6, 8.5_

  - [x] 14.2 Write property test for version history completeness
    - **Property 26: Version History Completeness**
    - **Validates: Requirements 14.1, 14.2**

  - [x] 14.3 Implement missed benefits analyzer
    - Create `MissedBenefitsAnalyzer` identifying schemes citizen was eligible for but didn't apply before deadline
    - Calculate estimated monetary value of missed benefits (monetary only)
    - Display missed schemes with name, met criteria, expired deadline, estimated amount
    - Notify citizen when missed scheme reopens within 24 hours
    - Show summary on Benefits_Dashboard (count + total monetary value)
    - _Requirements: 15.1, 15.2, 15.3, 15.4, 15.5, 15.6_

  - [x] 14.4 Write property test for missed benefits identification
    - **Property 25: Missed Benefits Identification**
    - **Validates: Requirements 15.1, 15.2, 15.5, 15.6**

- [x] 15. Implement Scheme Discovery and Browsing Frontend
  - [x] 15.1 Implement scheme browsing pages with categories and filters
    - Create Next.js pages for scheme listing by category (Education, Agriculture, Healthcare, etc.)
    - Implement filter UI for State, Income Level, Category, Age, Gender, Occupation, Benefit Type
    - Apply AND logic for combined filters; return within 2 seconds; paginate at 20 per page
    - Display Central/State Government labels on each scheme
    - Handle zero results with suggestions
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.7_

  - [x] 15.2 Write property test for filter AND logic
    - **Property 4: Filter AND Logic**
    - **Validates: Requirements 2.3**

  - [x] 15.3 Implement scheme search functionality
    - Create search input accepting 2+ characters with semantic + full-text search
    - Rank results by match against name, category, description; return within 2 seconds
    - Paginate at 20 results per page
    - _Requirements: 2.6, 2.7_

  - [x] 15.4 Write property test for search result ordering
    - **Property 5: Search Result Ordering**
    - **Validates: Requirements 2.6**

  - [x] 15.5 Implement scheme detail view
    - Display name, simplified description (8th-grade level), eligibility criteria, benefits, application process, required documents, official source URL, last verified date
    - Show eligibility status and compatibility information
    - _Requirements: 2.5, 4.1, 7.2_

  - [x] 15.6 Implement scheme comparison tool
    - Allow selection of up to 3 schemes for side-by-side comparison
    - Display tabular comparison: eligibility criteria, benefits, deadline, documents, application process
    - Highlight differences; show eligibility status per scheme; handle missing data
    - Render within 3 seconds; enforce 3-scheme maximum with message
    - _Requirements: 24.1, 24.2, 24.3, 24.4, 24.5, 24.6, 24.7_

  - [x] 15.7 Write property test for scheme comparison difference highlighting
    - **Property 22: Scheme Comparison Difference Highlighting**
    - **Validates: Requirements 24.4**

- [x] 16. Implement Multilingual Support
  - [x] 16.1 Implement i18n framework and translation service
    - Configure Next.js i18n for English, Hindi, Bengali, Tamil, Telugu, Marathi
    - Translate all interface elements; switch language within 2 seconds
    - Translate scheme content while preserving official scheme names in original language
    - Persist language preference across sessions
    - Handle missing translations with English fallback and visible notice
    - _Requirements: 12.1, 12.2, 12.4, 12.5, 12.6_

  - [x] 16.2 Write property test for translation preserves scheme names
    - **Property 18: Translation Preserves Scheme Names**
    - **Validates: Requirements 12.4**

  - [x] 16.3 Implement language detection for Scheme Assistant
    - Detect input language; respond in same language; default to platform language if confidence < 80%
    - Handle mid-conversation language switches
    - _Requirements: 12.3, 12.7_

- [x] 17. Implement Voice Assistant
  - [x] 17.1 Implement voice assistant with STT and TTS
    - Integrate Azure Cognitive Services Speech for STT/TTS in 6 supported languages
    - Process voice query through Scheme_Assistant and deliver audio response within 10 seconds
    - Achieve 85% Word Recognition Rate minimum
    - Request repeat if confidence < 50% (up to 3 retries); fall back to text input after 3 failures
    - Handle service unavailability with error message and text fallback
    - _Requirements: 13.1, 13.2, 13.3, 13.4, 13.5, 13.6, 13.7_

- [x] 18. Implement Admin Dashboard
  - [x] 18.1 Implement admin dashboard and scheme management
    - Create admin pages showing system health: Crawler status, DB size, average API response time (24h)
    - Allow manual verify/edit/remove of schemes with audit logging
    - Display flagged schemes sorted by flag date; show analytics (total schemes, active citizens, queries/day, eligibility calcs/day)
    - Implement approve/reject workflow for flagged schemes
    - _Requirements: 17.1, 17.2, 17.3, 17.4, 17.5, 17.6_

- [x] 19. Implement AI Observability and Evaluation
  - [x] 19.1 Implement AI observability and evaluation pipeline
    - Log all Scheme_Assistant queries, context, and responses (retain 90 days)
    - Track RAG precision and recall daily; implement helpful/unhelpful feedback mechanism
    - Alert admins when helpful rate drops below 80% over last 100 rated responses
    - Execute weekly automated evaluation against 50+ QA test set
    - Integrate OpenTelemetry distributed tracing with unique trace IDs
    - Flag traces exceeding 10 seconds as degraded
    - _Requirements: 21.1, 21.2, 21.3, 21.4, 21.5, 21.6, 21.7_

  - [x] 19.2 Write property test for AI helpfulness alert threshold
    - **Property 27: AI Helpfulness Alert Threshold**
    - **Validates: Requirements 21.4**

- [x] 20. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 21. Implement Mobile-First Responsive Design and Accessibility
  - [x] 21.1 Implement responsive layouts and mobile optimizations
    - Apply mobile-first breakpoint strategy (320px-767px default, 768px+ enhanced)
    - Ensure no horizontal scrolling from 320px to 2560px
    - Minimum 44x44px touch targets on mobile; collapsible navigation below 768px
    - Target Lighthouse mobile score ≥ 80 and FCP ≤ 3s on 4G
    - _Requirements: 19.1, 19.2, 19.3, 19.4, 19.5, 19.6_

  - [x] 21.2 Implement WCAG 2.1 AA accessibility compliance
    - Add keyboard navigation with visible focus indicators and logical tab order
    - Add ARIA labels for all interactive components; maintain 4.5:1 contrast ratio
    - Implement heading hierarchy and landmark regions
    - Add ARIA live regions for dynamic content changes
    - Associate form errors programmatically with inputs
    - _Requirements: 20.1, 20.2, 20.3, 20.4, 20.5, 20.6, 20.7_

- [x] 22. Integration wiring and end-to-end flows
  - [x] 22.1 Wire profile updates to eligibility and recommendation recalculation
    - When profile updates, trigger eligibility recalculation (30s) and recommendation regeneration (60s)
    - Wire change detection to benefit value recalculation and citizen notifications
    - _Requirements: 3.3, 5.5, 14.5, 23.3_

  - [x] 22.2 Wire crawler pipeline to all downstream systems
    - Connect crawl results to PostgreSQL, vector DB, Elasticsearch, and change detector
    - Trigger notifications for affected citizens on scheme changes
    - Flag unreachable sources after 3 consecutive failures
    - _Requirements: 1.4, 1.5, 1.8, 14.3_

  - [x] 22.3 Wire frontend to all backend services
    - Connect scheme browsing, search, comparison, dashboard, profile, and voice UIs to API endpoints
    - Implement caching layer for repeated scheme reads (500ms target)
    - Set up WebSocket for real-time in-app notifications
    - _Requirements: 18.5, 10.6_

- [x] 23. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation throughout development
- Property tests validate universal correctness properties using fast-check
- Unit tests validate specific examples and edge cases
- The technology stack uses TypeScript throughout: Next.js 14 (frontend), Node.js/Fastify (backend), PostgreSQL, Redis, Elasticsearch, Pinecone/pgvector, Vitest + fast-check (testing)
- All 30 correctness properties from the design are covered by property-based test tasks

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "1.3", "1.4"] },
    { "id": 2, "tasks": ["2.1", "2.4", "3.1"] },
    { "id": 3, "tasks": ["2.2", "2.3", "3.2"] },
    { "id": 4, "tasks": ["5.1", "5.4", "5.6"] },
    { "id": 5, "tasks": ["5.2", "5.3", "5.5", "5.7", "5.8"] },
    { "id": 6, "tasks": ["5.9", "5.10"] },
    { "id": 7, "tasks": ["6.1"] },
    { "id": 8, "tasks": ["6.2", "7.1"] },
    { "id": 9, "tasks": ["7.2", "7.3", "7.4", "7.5"] },
    { "id": 10, "tasks": ["9.1", "10.1", "11.1", "11.3"] },
    { "id": 11, "tasks": ["9.2", "9.3", "10.2", "10.3", "11.2"] },
    { "id": 12, "tasks": ["9.4", "9.5", "12.1", "12.4"] },
    { "id": 13, "tasks": ["12.2", "12.3", "12.5", "12.6"] },
    { "id": 14, "tasks": ["14.1", "14.3"] },
    { "id": 15, "tasks": ["14.2", "14.4", "15.1", "15.3", "15.5"] },
    { "id": 16, "tasks": ["15.2", "15.4", "15.6"] },
    { "id": 17, "tasks": ["15.7", "16.1", "16.3", "17.1"] },
    { "id": 18, "tasks": ["16.2", "18.1", "19.1"] },
    { "id": 19, "tasks": ["19.2", "21.1", "21.2"] },
    { "id": 20, "tasks": ["22.1", "22.2", "22.3"] }
  ]
}
```
