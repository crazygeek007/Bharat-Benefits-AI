# Requirements Document

## Introduction

Bharat Benefits AI is an AI-powered platform that helps Indian citizens discover, understand, and apply for government welfare schemes from verified official government sources. The platform acts as a personal government benefits assistant that identifies schemes a user is eligible for, explains them in simple language, provides official application links, tracks updates, and uses AI to answer questions about schemes. The platform exclusively uses verified government data from official sources (gov.in, nic.in, official ministry and state portals) and never relies on unofficial third-party sources.

The platform addresses the challenge that India has thousands of Central and State Government welfare schemes, but citizens face barriers including lack of awareness, complex eligibility criteria, scattered information across multiple government websites, language barriers, confusing application processes, and inability to determine scheme compatibility.

## Glossary

- **Platform**: The Bharat Benefits AI web application system
- **Citizen**: A primary user of the Platform who is an Indian citizen seeking government welfare schemes
- **Scheme**: A government welfare program offered by Central or State government with defined eligibility criteria, benefits, and application process
- **Eligibility_Engine**: The AI subsystem that calculates whether a Citizen qualifies for a given Scheme based on their profile data
- **Recommendation_Engine**: The AI subsystem that ranks and suggests the most relevant Schemes for a Citizen
- **Scheme_Assistant**: The RAG-based AI chatbot that answers Citizen questions about Schemes with source citations
- **Crawler_System**: The automated background system that discovers, extracts, verifies, and ingests Scheme data from official government sources
- **Compatibility_Engine**: The subsystem that determines which Schemes can or cannot be combined
- **Document_Checklist_Generator**: The subsystem that produces the list of required and optional documents for a Scheme application
- **Deadline_Tracker**: The subsystem that monitors and notifies Citizens about upcoming Scheme deadlines
- **Benefits_Dashboard**: The user interface showing a Citizen's eligible, applied, saved, and expired Schemes with estimated total benefit value
- **Voice_Assistant**: The subsystem providing speech-to-text and text-to-speech capabilities in Indian languages
- **Change_Detector**: The subsystem that tracks version history and changes to Scheme eligibility, deadlines, and benefits
- **Missed_Benefits_Analyzer**: The subsystem that identifies Schemes a Citizen was eligible for but did not apply to
- **Admin_Dashboard**: The administrative interface for managing Schemes, users, and system configuration
- **Trust_Score**: A numerical rating (0-100) indicating the verification confidence level of a Scheme's data
- **User_Profile**: The collection of demographic, financial, and occupational data a Citizen provides to enable eligibility calculation
- **Official_Source**: A government website with domain ending in gov.in, nic.in, or an officially recognized ministry or state government portal
- **Match_Score**: A percentage (0-100) indicating how well a Scheme aligns with a Citizen's profile
- **RAG**: Retrieval-Augmented Generation — an AI architecture that retrieves relevant documents before generating responses
- **Vector_Database**: A database optimized for storing and querying high-dimensional embeddings for semantic search
- **Comparison_Tool**: The subsystem that enables side-by-side comparison of up to 3 Schemes across key attributes
- **Planner_Agent**: The AI agent that analyzes user intent and routes queries to appropriate downstream agents
- **Eligibility_Agent**: The AI agent that evaluates Scheme qualification based on User_Profile data
- **Retrieval_Agent**: The AI agent that retrieves relevant Schemes from the Vector_Database using semantic search
- **Compatibility_Agent**: The AI agent that checks compatibility relationships between retrieved Schemes
- **Recommendation_Agent**: The AI agent that ranks and selects the best matching Schemes from filtered results
- **Response_Agent**: The AI agent that generates the final user-facing answer by synthesizing upstream agent outputs

## Requirements

### Requirement 1: Scheme Data Ingestion from Official Sources

**User Story:** As a platform administrator, I want the system to automatically discover and ingest scheme data exclusively from verified official government sources, so that Citizens receive only trustworthy and accurate information.

#### Acceptance Criteria

1. THE Crawler_System SHALL ingest Scheme data only from Official_Source domains (gov.in, nic.in, official ministry websites, official state government portals)
2. IF a data source does not belong to an Official_Source domain, THEN THE Crawler_System SHALL reject the data and log the rejection reason
3. WHEN a new Scheme is discovered, THE Crawler_System SHALL store the official source URL, ministry or department name, date discovered, last verified date, and Trust_Score
4. THE Crawler_System SHALL execute a daily background crawl workflow to discover new Schemes and updates to existing Schemes, and SHALL complete each crawl cycle within 6 hours of initiation
5. WHEN the Crawler_System discovers a new Scheme, THE Crawler_System SHALL process it through content extraction, verification, categorization, database update, vector index update, and change detection stages within 10 minutes of discovery
6. THE Crawler_System SHALL assign a Trust_Score between 0 and 100 to each ingested Scheme based on source reliability and verification checks
7. WHILE a Scheme has a Trust_Score below 60, THE Platform SHALL mark the Scheme as unverified and hide it from Citizen-facing views
8. WHEN a previously verified Scheme's source URL becomes unreachable for 3 consecutive verification attempts or the Scheme's Trust_Score drops below 60 after re-evaluation, THE Change_Detector SHALL flag the Scheme for manual review and notify administrators within 15 minutes
9. IF the daily crawl workflow fails to complete due to infrastructure or network errors, THEN THE Crawler_System SHALL log the failure with the error reason, retain all previously ingested Scheme data unchanged, and notify administrators within 15 minutes

### Requirement 2: Scheme Discovery and Browsing

**User Story:** As a Citizen, I want to browse and search government welfare schemes by category and filters, so that I can discover relevant schemes available to me.

#### Acceptance Criteria

1. THE Platform SHALL display Schemes organized by categories: Education, Agriculture, Healthcare, Women, Employment, Skill Development, Housing, Startups, MSME, Pension, Scholarships, and Financial Assistance
2. THE Platform SHALL provide filters for State, Income Level, Category, Age, Gender, Occupation, and Benefit Type
3. WHEN a Citizen applies one or more filters, THE Platform SHALL combine all active filters using AND logic and return matching Schemes within 2 seconds, displaying up to 20 Schemes per page with pagination controls
4. THE Platform SHALL display a visible label on each Scheme indicating whether it is a Central Government Scheme or a State Government Scheme
5. WHEN a Citizen selects a Scheme, THE Platform SHALL display the Scheme name, description written at or below an 8th-grade reading level, eligibility criteria, benefits, application process, required documents, official source URL, and last verified date
6. WHEN a Citizen enters a search query of at least 2 characters, THE Platform SHALL return Schemes ranked by match against Scheme name, category, and description within 2 seconds, displaying up to 20 results per page
7. IF a filter selection or search query returns zero matching Schemes, THEN THE Platform SHALL display a message indicating no results were found and suggest the Citizen adjust filters or broaden search terms

### Requirement 3: User Profile Management

**User Story:** As a Citizen, I want to create and manage my profile with demographic and financial details, so that the system can calculate my eligibility for schemes.

#### Acceptance Criteria

1. THE Platform SHALL allow Citizens to create a User_Profile with the following attributes: age (integer, 0 to 150), gender (Male, Female, Other), state of residence (from list of Indian states and union territories), district (from list of districts within selected state), income level (annual household income in INR, 0 to 99,99,99,999), occupation (from predefined list: Farmer, Student, Salaried, Self-Employed, Unemployed, Retired, Other), education level (from predefined list: None, Primary, Secondary, Higher Secondary, Graduate, Post-Graduate, Doctorate), caste category (General, OBC, SC, ST), disability status (Yes or No), marital status (Single, Married, Widowed, Divorced, Separated), and number of dependents (integer, 0 to 20)
2. THE Platform SHALL designate age, gender, state of residence, and income level as required fields, and all remaining User_Profile attributes as optional fields
3. WHEN a Citizen updates their User_Profile, THE Eligibility_Engine SHALL recalculate eligibility for all saved Schemes within 30 seconds
4. IF a Citizen submits User_Profile data that fails validation rules (value out of defined range, required field missing, or invalid selection), THEN THE Platform SHALL reject the submission, retain the previously saved values, and display an error message indicating which fields failed validation and why
5. THE Platform SHALL store User_Profile data securely using encryption at rest and in transit
6. WHEN a Citizen requests deletion of their User_Profile, THE Platform SHALL require confirmation, and upon confirmation permanently delete the User_Profile and all associated data within 30 days
7. THE Platform SHALL never share User_Profile data with third parties without explicit Citizen consent

### Requirement 4: AI Eligibility Calculation

**User Story:** As a Citizen, I want the system to automatically determine my eligibility for government schemes based on my profile, so that I can quickly understand which schemes I qualify for.

#### Acceptance Criteria

1. WHEN a Citizen views a Scheme, THE Eligibility_Engine SHALL calculate eligibility status as one of: Eligible (all criteria met), Partially Eligible (at least one criterion met and remaining criteria cannot be evaluated due to missing User_Profile data), or Not Eligible (at least one criterion definitively not met based on available User_Profile data)
2. WHEN the Eligibility_Engine determines a Citizen is Not Eligible for a Scheme, THE Eligibility_Engine SHALL list each unmet criterion individually, stating the criterion requirement and the Citizen's corresponding profile value that does not satisfy it
3. WHEN the Eligibility_Engine determines a Citizen is Partially Eligible, THE Eligibility_Engine SHALL list the criteria that are met, the criteria that cannot be evaluated due to missing User_Profile data, and the specific profile fields required to complete the evaluation
4. THE Eligibility_Engine SHALL base eligibility calculations exclusively on officially published criteria from the Scheme's Official_Source
5. IF the Eligibility_Engine cannot determine eligibility due to missing User_Profile data, THEN THE Eligibility_Engine SHALL indicate which profile fields are needed and prompt the Citizen to provide them
6. IF the Eligibility_Engine cannot evaluate one or more eligibility criteria due to unsupported criterion types or unavailable Scheme data, THEN THE Eligibility_Engine SHALL display the eligibility result for evaluable criteria and indicate which criteria could not be assessed, along with a recommendation to verify eligibility at the Scheme's Official_Source

### Requirement 5: Personalized Scheme Recommendations

**User Story:** As a Citizen, I want AI-powered personalized recommendations of the best matching schemes, so that I can prioritize the most valuable and urgent schemes for me.

#### Acceptance Criteria

1. WHEN a Citizen accesses their recommendations, THE Recommendation_Engine SHALL rank Schemes by Match_Score as the primary factor, Benefit Amount as the secondary factor, and Application Deadline proximity as the tertiary factor
2. THE Recommendation_Engine SHALL assign a Match_Score between 0 and 100 to each recommended Scheme based on User_Profile alignment
3. THE Recommendation_Engine SHALL prioritize Schemes with deadlines within 30 days by boosting their ranking position above Schemes with later or no deadlines
4. THE Recommendation_Engine SHALL exclude Schemes for which the Citizen is Not Eligible
5. WHEN a Citizen's User_Profile changes, THE Recommendation_Engine SHALL regenerate recommendations within 60 seconds
6. THE Recommendation_Engine SHALL provide an explanation of no more than 200 characters for each recommendation describing why the Scheme matches the Citizen's profile
7. THE Recommendation_Engine SHALL return a maximum of 50 Schemes in the recommendation list
8. IF no Schemes match the Citizen's User_Profile with a Match_Score above 0, THEN THE Recommendation_Engine SHALL display a message indicating no recommendations are available and prompt the Citizen to complete or update their User_Profile

### Requirement 6: AI Scheme Assistant (RAG-based Q&A)

**User Story:** As a Citizen, I want to ask questions about government schemes in natural language and receive accurate answers with source citations, so that I can understand schemes without navigating complex government websites.

#### Acceptance Criteria

1. WHEN a Citizen asks a question, THE Scheme_Assistant SHALL retrieve the top 5 most relevant Scheme data chunks from the Vector_Database and generate a response using RAG
2. THE Scheme_Assistant SHALL include the official source URL and last updated date for each Scheme referenced in every response
3. IF the Scheme_Assistant cannot find verified information to answer a question, THEN THE Scheme_Assistant SHALL respond with a message indicating it does not have verified information on the topic rather than generating an unverified answer
4. IF a Citizen asks a question unrelated to government schemes, THEN THE Scheme_Assistant SHALL respond with a message indicating it can only answer questions about government schemes
5. THE Scheme_Assistant SHALL generate responses within 5 seconds of receiving a question
6. THE Scheme_Assistant SHALL support conversational context by retaining at least the previous 5 exchanges within a session, allowing Citizens to ask follow-up questions about the same Scheme without repeating context
7. THE Scheme_Assistant SHALL never generate information that contradicts the verified Scheme data stored in the system
8. THE Scheme_Assistant SHALL limit each response to a maximum of 500 words

### Requirement 7: Scheme Compatibility Engine

**User Story:** As a Citizen, I want to know which schemes can be combined and which are mutually exclusive, so that I can maximize my benefits without violating scheme rules.

#### Acceptance Criteria

1. THE Compatibility_Engine SHALL maintain relationships between Schemes: can_combine_with, cannot_combine_with, and prerequisite_schemes
2. WHEN a Citizen views a Scheme, THE Compatibility_Engine SHALL display compatible Schemes and incompatible Schemes, showing for each the Scheme name, relationship type, and the official rule or reason for the relationship
3. WHEN a Citizen attempts to save two incompatible Schemes, THE Compatibility_Engine SHALL warn the Citizen about the conflict, explain the restriction citing the official rule, and allow the Citizen to proceed with saving or cancel the action
4. WHEN a Citizen views or starts the application process for a Scheme that has prerequisite_schemes, THE Compatibility_Engine SHALL display the prerequisite Schemes in their required order as steps to complete before the dependent Scheme
5. WHEN a new Scheme is ingested, THE Crawler_System SHALL extract compatibility relationships from the official documentation
6. IF the Crawler_System cannot extract compatibility relationships for a Scheme during ingestion, THEN THE Crawler_System SHALL flag the Scheme as having unknown compatibility status and log the extraction failure for administrator review
7. IF no compatibility data is available for a Scheme, THEN THE Compatibility_Engine SHALL display a notice to the Citizen indicating that compatibility information is not yet verified for that Scheme

### Requirement 8: Document Checklist Generation

**User Story:** As a Citizen, I want a clear checklist of documents required for each scheme application, so that I can prepare everything before starting the application process.

#### Acceptance Criteria

1. WHEN a Citizen views a Scheme's application details, THE Document_Checklist_Generator SHALL display a list of required documents and optional documents
2. THE Document_Checklist_Generator SHALL categorize documents as Required or Optional
3. THE Document_Checklist_Generator SHALL provide the official name and a description stating the purpose and accepted format for each document
4. WHEN a Citizen views a Scheme's application details and the Citizen has other saved Schemes that require the same document, THE Document_Checklist_Generator SHALL display a shared-document indicator listing the other saved Schemes that also require that document
5. IF a document requirement changes in a Scheme update, THEN THE Change_Detector SHALL notify Citizens who have saved that Scheme within 24 hours of detecting the change
6. IF a Scheme has no document requirements listed in the official source, THEN THE Document_Checklist_Generator SHALL display a message indicating that no documents are specified and direct the Citizen to the official source URL for confirmation

### Requirement 9: Application Guidance

**User Story:** As a Citizen, I want step-by-step instructions for applying to schemes, so that I can complete applications correctly without confusion.

#### Acceptance Criteria

1. WHEN a Citizen selects "Apply" for a Scheme, THE Platform SHALL display numbered step-by-step application instructions where each step includes an action description and the expected outcome of completing that step
2. THE Platform SHALL provide the official application link for each Scheme
3. THE Platform SHALL list at least 3 common mistakes to avoid during the application process, sourced from the official Scheme documentation or extracted by the Crawler_System from Official_Source data
4. THE Platform SHALL indicate whether the application is online, offline, or hybrid, and for offline or hybrid applications, THE Platform SHALL display the relevant office name and address where the Citizen must submit the application
5. IF the official application portal is inaccessible for more than 30 seconds, THEN THE Platform SHALL display the last known accessibility date, the application mode (online/offline/hybrid), and an alternate contact method if available, and suggest the Citizen try again later

### Requirement 10: Deadline Tracking and Notifications

**User Story:** As a Citizen, I want to save schemes and receive notifications about upcoming deadlines, so that I never miss an application window.

#### Acceptance Criteria

1. THE Platform SHALL allow Citizens to save up to 100 Schemes to their Benefits_Dashboard
2. WHEN a saved Scheme's deadline is within 7 days, THE Deadline_Tracker SHALL send a notification to the Citizen containing the Scheme name, deadline date, and a link to the Scheme details
3. WHEN a saved Scheme's deadline is within 1 day, THE Deadline_Tracker SHALL send a notification to the Citizen marked with high-priority designation and repeated at 24 hours and 6 hours before the deadline
4. THE Deadline_Tracker SHALL display all saved Scheme deadlines occurring within the next 90 days in a calendar or timeline view on the Benefits_Dashboard
5. WHEN a Scheme's deadline is extended or changed, THE Deadline_Tracker SHALL notify affected Citizens with the previous deadline, updated deadline, and the source of the change
6. THE Deadline_Tracker SHALL support notification delivery via email and in-app notifications
7. IF a saved Scheme has no fixed deadline or has a rolling application window, THEN THE Deadline_Tracker SHALL display the Scheme in the Benefits_Dashboard with an "Open/No Deadline" indicator and exclude it from deadline-based notifications
8. IF a notification delivery fails via email, THEN THE Deadline_Tracker SHALL retry delivery up to 3 times over 24 hours and deliver the notification via in-app notification as a fallback

### Requirement 11: Benefits Dashboard

**User Story:** As a Citizen, I want a dashboard showing my eligible, applied, saved, and expired schemes with estimated total benefit value, so that I can track my benefits in one place.

#### Acceptance Criteria

1. THE Benefits_Dashboard SHALL display Schemes grouped by status: Eligible, Applied, Saved, and Expired
2. THE Benefits_Dashboard SHALL calculate and display the Estimated Total Benefit Value by summing the monetary benefit amounts of all Schemes in the Eligible status, displayed in INR
3. WHEN a Citizen marks a Scheme as "Applied", THE Benefits_Dashboard SHALL move the Scheme to the Applied section and retain it there regardless of deadline status
4. WHEN a Scheme's deadline passes and the Citizen has not marked the Scheme as "Applied", THE Benefits_Dashboard SHALL move the Scheme to the Expired section
5. THE Benefits_Dashboard SHALL display the count of Schemes in each status category
6. IF a Scheme has non-monetary benefits (services, training, assets) without a quantifiable monetary value, THEN THE Benefits_Dashboard SHALL exclude that Scheme from the Estimated Total Benefit Value calculation and display its benefit as a descriptive label
7. IF a Citizen has no Schemes in any status category, THEN THE Benefits_Dashboard SHALL display an empty state message encouraging the Citizen to discover Schemes

### Requirement 12: Multilingual Support

**User Story:** As a Citizen, I want to use the platform in my preferred Indian language, so that language barriers do not prevent me from accessing scheme information.

#### Acceptance Criteria

1. THE Platform SHALL support the following languages: English, Hindi, Bengali, Tamil, Telugu, and Marathi
2. WHEN a Citizen selects a language, THE Platform SHALL display all interface elements (navigation labels, buttons, form fields, error messages, and informational text) and Scheme descriptions in the selected language within 2 seconds of selection
3. THE Scheme_Assistant SHALL detect the language of a Citizen's input question and provide the response in that same language, defaulting to the Citizen's selected platform language if detection confidence is below 80%
4. THE Platform SHALL translate Scheme eligibility criteria, benefits, and application steps into the selected language while preserving official Scheme names in their original language
5. IF a Scheme's eligibility criteria, benefits, application steps, or description are not available in the selected language, THEN THE Platform SHALL display the English version with a visible notice indicating translation is unavailable for the specific content
6. WHEN a Citizen sets a language preference, THE Platform SHALL persist that preference across sessions so that subsequent logins display the platform in the previously selected language
7. WHEN a Citizen switches language during an active Scheme_Assistant conversation, THE Scheme_Assistant SHALL continue the conversation context and respond in the newly selected language from the next interaction onward

### Requirement 13: Voice Assistant

**User Story:** As a Citizen, I want to interact with the platform using voice in my preferred Indian language, so that I can access scheme information without reading or typing.

#### Acceptance Criteria

1. THE Voice_Assistant SHALL convert Citizen speech to text in English, Hindi, Bengali, Tamil, Telugu, and Marathi
2. THE Voice_Assistant SHALL convert Platform text responses to speech in the Citizen's selected language
3. WHEN a Citizen speaks a question, THE Voice_Assistant SHALL process it through the Scheme_Assistant and deliver the answer as audio within 10 seconds of the Citizen finishing speaking
4. THE Voice_Assistant SHALL achieve a Word Recognition Rate of at least 85% for each supported language, measured as the percentage of correctly recognized words in a standard test set
5. IF the Voice_Assistant produces a recognition confidence score below 50% for a speech input, THEN THE Voice_Assistant SHALL request the Citizen to repeat the question, up to a maximum of 3 consecutive retry attempts
6. IF the Voice_Assistant fails to recognize speech input after 3 consecutive retry attempts, THEN THE Voice_Assistant SHALL display the query as a text input field and inform the Citizen to type their question instead
7. IF the Voice_Assistant speech or text-to-speech service is unavailable, THEN THE Voice_Assistant SHALL display an error message indicating the voice feature is temporarily unavailable and offer text-based interaction as a fallback

### Requirement 14: Scheme Change Tracking

**User Story:** As a Citizen, I want to see what changed in a scheme's eligibility, deadline, or benefits, so that I stay informed about updates that affect me.

#### Acceptance Criteria

1. THE Change_Detector SHALL maintain a version history for each Scheme including changes to eligibility criteria, deadlines, benefit amounts, and application process, retaining at least the 50 most recent versions per Scheme
2. WHEN a Scheme is updated, THE Change_Detector SHALL record the previous value, new value, change date, and source URL within 10 minutes of detecting the update
3. WHEN a saved Scheme's eligibility criteria, deadline, or benefit amount changes, THE Change_Detector SHALL notify affected Citizens who have saved that Scheme via email and in-app notification within 60 minutes of recording the change
4. THE Platform SHALL display a change history timeline for each Scheme showing the changed field, previous value, new value, change date, and source URL, ordered from most recent to oldest with a maximum of 20 entries per page
5. WHEN a Scheme's benefit amount changes, THE Benefits_Dashboard SHALL recalculate the Estimated Total Benefit Value within 30 seconds
6. IF the Change_Detector cannot compare a Scheme's current data with its previous version due to source unavailability, THEN THE Change_Detector SHALL retain the last known version, log the failure with the source URL and timestamp, and retry comparison during the next crawl cycle

### Requirement 15: Missed Benefits Analyzer

**User Story:** As a Citizen, I want to know which schemes I was eligible for but did not apply to, so that I can understand the benefits I missed and be more proactive in the future.

#### Acceptance Criteria

1. THE Missed_Benefits_Analyzer SHALL identify Schemes for which a Citizen was eligible (based on User_Profile data at the time of the Scheme's deadline) but did not mark as "Applied" before the deadline passed
2. THE Missed_Benefits_Analyzer SHALL calculate the estimated monetary value of missed benefits by summing the published benefit amounts of all identified missed Schemes
3. THE Missed_Benefits_Analyzer SHALL display each missed Scheme with the Scheme name, the eligibility criteria that were met, the expired deadline date, and the estimated benefit amount
4. WHEN a previously missed Scheme reopens for applications or a new cycle begins, THE Missed_Benefits_Analyzer SHALL notify the Citizen via in-app notification and email within 24 hours of detecting the reopening
5. THE Missed_Benefits_Analyzer SHALL provide a summary on the Benefits_Dashboard showing the total count of missed Schemes and the total estimated monetary value of missed benefits
6. IF a missed Scheme has non-monetary benefits without a quantifiable value, THEN THE Missed_Benefits_Analyzer SHALL include the Scheme in the missed list with a descriptive benefit label and exclude it from the total monetary value calculation

### Requirement 16: Authentication and Security

**User Story:** As a Citizen, I want secure authentication and privacy protection, so that my personal data remains safe and private.

#### Acceptance Criteria

1. IF an unauthenticated user attempts to access personalized features (User_Profile, Benefits_Dashboard, saved Schemes), THEN THE Platform SHALL redirect the user to the login page and prevent access to the requested content
2. THE Platform SHALL support email/password and social login authentication methods, requiring passwords to be between 8 and 128 characters with at least one uppercase letter, one lowercase letter, one digit, and one special character
3. THE Platform SHALL encrypt all User_Profile data at rest using AES-256 encryption
4. THE Platform SHALL encrypt all data in transit using TLS 1.2 or higher
5. WHEN a Citizen session has been inactive for 30 minutes, THE Platform SHALL terminate the session and redirect the Citizen to the login page on their next interaction
6. THE Platform SHALL maintain audit logs of all User_Profile data access and modifications, retaining logs for a minimum of 365 days, including the action performed, the timestamp, and the actor identity
7. WHEN a Citizen requests data deletion, THE Platform SHALL permanently delete all Citizen data (User_Profile, saved Schemes, Benefits_Dashboard data, and notification preferences) within 30 days and send a confirmation notification to the Citizen's registered email upon completion
8. IF a Citizen fails authentication 5 consecutive times, THEN THE Platform SHALL lock the account for 15 minutes and notify the Citizen via registered email of the failed login attempts

### Requirement 17: Admin Dashboard

**User Story:** As a platform administrator, I want a dashboard to manage schemes, monitor system health, and review flagged content, so that I can maintain data quality and system reliability.

#### Acceptance Criteria

1. THE Admin_Dashboard SHALL display system health metrics including Crawler_System status (running, stopped, or error with last execution timestamp), database size in megabytes, and average API response time over the last 24 hours in milliseconds
2. THE Admin_Dashboard SHALL allow administrators to manually verify, edit, or remove Schemes, and SHALL record the administrator identity, action taken, and timestamp for each modification
3. THE Admin_Dashboard SHALL display Schemes flagged for review by the Change_Detector or Crawler_System, showing the flag reason, flag date, and source URL for each flagged Scheme, sorted by flag date with most recent first
4. THE Admin_Dashboard SHALL show analytics including total Schemes, active Citizens (Citizens who have logged in within the last 30 days), queries per day, and eligibility calculations per day, calculated over a rolling 30-day period
5. WHEN an administrator approves a flagged Scheme, THE Platform SHALL update the Scheme's Trust_Score to reflect verification and make the Scheme visible to Citizens
6. IF an administrator rejects a flagged Scheme, THEN THE Platform SHALL keep the Scheme hidden from Citizen-facing views and record the rejection reason provided by the administrator

### Requirement 18: Performance and Scalability

**User Story:** As a Citizen, I want the platform to respond quickly and reliably, so that I can access scheme information without delays.

#### Acceptance Criteria

1. THE Platform SHALL return search results within 2 seconds for 95% of queries under normal operating load (up to 10,000 concurrent users)
2. THE Platform SHALL return eligibility calculations within 3 seconds for a single Scheme for 95% of requests under normal operating load
3. THE Platform SHALL support at least 10,000 concurrent users while maintaining response times within the thresholds defined in criteria 1 and 2
4. THE Platform SHALL achieve 99.5% uptime measured on a monthly basis, where downtime is defined as the Platform being unreachable or returning errors on more than 5% of requests within any 1-minute window
5. THE Platform SHALL return previously accessed Scheme data within 500 milliseconds for 95% of repeated read requests for the same Scheme within a 10-minute window
6. WHEN concurrent users exceed 10,000 by up to 3x (30,000 users) during traffic spikes, THE Platform SHALL maintain response times within 2x of the thresholds defined in criteria 1 and 2
7. IF concurrent users exceed the maximum supported capacity (30,000 users), THEN THE Platform SHALL return an informative message indicating temporary unavailability and suggesting the Citizen retry after 60 seconds, rather than failing silently or producing errors without guidance

### Requirement 19: Mobile-First Responsive Design

**User Story:** As a Citizen, I want to access the platform on my mobile phone, so that I can discover and apply for schemes from any device.

#### Acceptance Criteria

1. THE Platform SHALL render all pages without horizontal scrolling, content overlap, or text truncation on screen widths from 320px to 2560px
2. THE Platform SHALL use a mobile-first responsive breakpoint strategy where the default layout targets screens 320px to 767px, and enhanced layouts apply at 768px and above
3. THE Platform SHALL achieve a Lighthouse mobile performance score of at least 80
4. THE Platform SHALL ensure all interactive elements (buttons, links, form inputs) have a minimum touch target size of 44x44 CSS pixels on screens below 768px width
5. THE Platform SHALL achieve a First Contentful Paint within 3 seconds on a simulated 4G mobile connection (9 Mbps downlink, 170ms RTT)
6. WHILE the viewport width is below 768px, THE Platform SHALL display all navigation links within a collapsible menu accessible via a single tap

### Requirement 20: Accessibility

**User Story:** As a Citizen with disabilities, I want the platform to be accessible, so that I can independently discover and apply for government schemes.

#### Acceptance Criteria

1. THE Platform SHALL conform to WCAG 2.1 Level AA accessibility guidelines
2. THE Platform SHALL support keyboard navigation for all interactive elements with visible focus indicators and a logical tab order that follows the visual reading flow
3. THE Platform SHALL provide ARIA labels for all interactive components
4. THE Platform SHALL maintain a minimum contrast ratio of 4.5:1 for normal text elements and 3:1 for large text (18px or above) and non-text UI components
5. THE Platform SHALL support screen reader navigation with meaningful heading hierarchy (sequential levels, no skipped levels) and landmark regions for major page sections (header, navigation, main content, footer)
6. WHEN dynamic content changes occur (notifications, form validation errors, status updates), THE Platform SHALL announce changes to assistive technologies using ARIA live regions
7. WHEN form validation errors occur, THE Platform SHALL programmatically associate error messages with their corresponding input fields so that screen readers announce the errors in context

### Requirement 21: AI Observability and Evaluation

**User Story:** As a platform administrator, I want to monitor AI system performance and accuracy, so that I can ensure the quality of AI-generated responses and recommendations.

#### Acceptance Criteria

1. THE Platform SHALL log all Scheme_Assistant queries, retrieved context, and generated responses for audit purposes and SHALL retain these logs for a minimum of 90 days
2. THE Platform SHALL track RAG retrieval accuracy metrics: precision and recall, computed daily over all Scheme_Assistant queries from the preceding 24-hour period
3. THE Platform SHALL provide a feedback mechanism for Citizens to rate each Scheme_Assistant response as helpful or unhelpful
4. WHEN the percentage of Scheme_Assistant responses rated as helpful falls below 80% over a rolling window of the most recent 100 rated responses, THE Platform SHALL send an alert notification to administrators via the Admin_Dashboard and email
5. THE Platform SHALL execute an automated evaluation on a weekly basis measuring answer correctness, source citation accuracy, and hallucination rate against a maintained test set of at least 50 question-answer pairs, and SHALL make results accessible on the Admin_Dashboard
6. THE Platform SHALL integrate distributed tracing for all Scheme_Assistant, Eligibility_Engine, and Recommendation_Engine operations, assigning a unique trace identifier to each request that spans retrieval, generation, and response delivery stages
7. IF a Scheme_Assistant trace exceeds a total duration of 10 seconds from query receipt to response delivery, THEN THE Platform SHALL flag the trace as degraded and log it for administrator review

### Requirement 22: Scheme Data Parsing and Serialization

**User Story:** As a platform administrator, I want the system to reliably parse scheme data from various official source formats and serialize it into a consistent internal format, so that all scheme data is uniformly structured regardless of source.

#### Acceptance Criteria

1. WHEN the Crawler_System extracts Scheme data from an Official_Source, THE Crawler_System SHALL parse the data into a standardized Scheme object containing the following mandatory fields: name, description, eligibility criteria, benefits, source URL, and ministry; and the following optional fields: application process, required documents, and deadline
2. THE Crawler_System SHALL support parsing Scheme data from HTML pages, PDF documents up to 50 MB in size, and structured API responses in JSON or XML format
3. THE Platform SHALL serialize Scheme objects into JSON format for storage and API responses
4. THE Platform SHALL ensure that parsing a serialized Scheme JSON and re-serializing the result produces output that is semantically equivalent to the original serialization, where equivalence means all field values are identical regardless of key ordering (round-trip property)
5. IF the Crawler_System encounters unparseable content from an Official_Source, THEN THE Crawler_System SHALL log the error with source URL and content type, and skip the Scheme without affecting other ingestion operations
6. IF the Crawler_System extracts content where one or more mandatory fields cannot be parsed from the source, THEN THE Crawler_System SHALL reject the Scheme, log the missing fields with the source URL, and flag the source for administrator review
7. IF the Crawler_System extracts content where all mandatory fields are present but one or more optional fields cannot be parsed, THEN THE Crawler_System SHALL create the Scheme object with available fields and set missing optional fields to null

### Requirement 23: State-Aware Recommendation Engine

**User Story:** As a Citizen, I want scheme recommendations prioritized by my state of residence, so that I see the most relevant local schemes first before central and mixed recommendations.

#### Acceptance Criteria

1. WHEN a Citizen accesses their recommendations, THE Recommendation_Engine SHALL rank Schemes in the following priority order: first, Schemes offered by the Citizen's state of residence; second, Central Government Schemes; third, compatible combined opportunities from other states or cross-government programs
2. WHEN a Citizen's state of residence is set in their User_Profile, THE Recommendation_Engine SHALL assign a higher ranking position to Schemes matching the Citizen's state than to Central Government Schemes with an equivalent Match_Score
3. WHEN a Citizen's state of residence changes in their User_Profile, THE Recommendation_Engine SHALL regenerate the state-prioritized recommendation ranking within 60 seconds
4. THE Recommendation_Engine SHALL apply state-based prioritization as a grouping layer above the existing Match_Score, Benefit Amount, and Deadline proximity ranking factors within each priority group
5. IF the Citizen's state of residence is not set in their User_Profile, THEN THE Recommendation_Engine SHALL display Central Government Schemes first followed by all State Schemes without state-based prioritization, and prompt the Citizen to set their state for personalized recommendations

### Requirement 24: Scheme Comparison Tool

**User Story:** As a Citizen, I want to compare multiple schemes side-by-side, so that I can make informed decisions about which schemes to apply for.

#### Acceptance Criteria

1. THE Platform SHALL allow Citizens to select up to 3 Schemes for side-by-side comparison
2. WHEN a Citizen selects Schemes for comparison, THE Platform SHALL display a tabular comparison view showing the following attributes for each selected Scheme: eligibility criteria, benefits, application deadline, required documents, and application process
3. THE Platform SHALL display the comparison table within 3 seconds of the Citizen confirming their Scheme selection
4. THE Platform SHALL highlight differences between compared Schemes by visually distinguishing cells where attribute values differ across the selected Schemes
5. IF a Citizen attempts to add more than 3 Schemes to the comparison, THEN THE Platform SHALL display a message indicating the maximum of 3 Schemes has been reached and prompt the Citizen to remove a Scheme before adding another
6. IF one or more selected Schemes are missing data for a comparison attribute, THEN THE Platform SHALL display "Information not available" in the corresponding cell and provide the Official_Source link for the Citizen to verify directly
7. WHEN a Citizen is viewing the comparison table, THE Platform SHALL display the eligibility status (Eligible, Partially Eligible, or Not Eligible) for each compared Scheme based on the Citizen's User_Profile

### Requirement 25: Multi-Agent AI Workflow

**User Story:** As a Citizen, I want my queries processed through a specialized multi-agent AI workflow, so that I receive accurate, well-reasoned responses that consider eligibility, compatibility, and personalized recommendations.

#### Acceptance Criteria

1. WHEN a Citizen submits a query, THE Platform SHALL process the query through the following agent pipeline in sequence: Planner_Agent, Eligibility_Agent, Retrieval_Agent, Compatibility_Agent, Recommendation_Agent, and Response_Agent
2. THE Planner_Agent SHALL analyze the Citizen's query to determine intent and route the query to the appropriate downstream agents, skipping agents that are not relevant to the query type
3. THE Eligibility_Agent SHALL evaluate Scheme qualification for the Citizen based on User_Profile data and return eligibility determinations to downstream agents
4. THE Retrieval_Agent SHALL retrieve relevant Schemes from the Vector_Database using semantic search and return the top 10 most relevant Scheme data chunks to downstream agents
5. THE Compatibility_Agent SHALL check compatibility relationships between retrieved Schemes and filter out incompatible combinations before passing results to the Recommendation_Agent
6. THE Recommendation_Agent SHALL rank and select the best matching Schemes from the filtered results using Match_Score and state-aware prioritization
7. THE Response_Agent SHALL generate the final user-facing answer by synthesizing outputs from upstream agents into a coherent, cited response within the 500-word limit
8. THE Platform SHALL complete the full multi-agent pipeline from query receipt to response delivery within 10 seconds for 95% of queries under normal operating load
9. IF any agent in the pipeline fails to produce output within 5 seconds, THEN THE Platform SHALL bypass the failed agent, log the failure with agent name and error reason, and continue processing with available agent outputs
10. THE Platform SHALL assign a unique trace identifier to each query that persists across all agents in the pipeline, enabling end-to-end observability of the multi-agent workflow
