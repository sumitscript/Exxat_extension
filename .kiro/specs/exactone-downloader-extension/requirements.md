# Requirements Document

## Introduction

A Chrome browser extension for the Exxat One learning platform that automates the repetitive task of downloading student-submitted documents. The extension records a user's click sequence on the Exxat One website, then replays those steps automatically across all eligible table rows — handling pagination, variable document counts per student, and row-level status filtering. Rows with an "Onboarding" status of "Not Started" are skipped; all others ("Action Needed", "Compliant Confirmed") are processed.

## Glossary

- **Extension**: The Chrome browser extension built to automate document downloads on Exxat One.
- **Exxat One**: The target React-based learning management website where students upload documents.
- **Recording**: The process of capturing a user's click interactions and DOM targets as a replayable sequence of steps.
- **Replay**: The automated re-execution of a recorded step sequence across multiple table rows.
- **Step**: A single recorded user interaction (e.g., a click on a specific DOM element).
- **Row**: A single entry in the ExactOne student table, representing one student's submission record.
- **Onboarding Status**: A cell value in the student table row indicating one of three states: "Not Started", "Action Needed", or "Compliant Confirmed".
- **Pagination**: The mechanism on the ExactOne table that splits rows across multiple pages, navigated via next/previous controls.
- **Document Set**: The collection of uploaded documents associated with a single student row; count varies per student.
- **DOM Selector**: A stable identifier (CSS selector or XPath) used to locate a specific element in the page's Document Object Model.
- **Session**: A single run of the replay automation from start to finish across all pages and rows.

## Requirements

### Requirement 1

**User Story:** As an administrator, I want to record my click sequence on the ExactOne page, so that the extension can learn the exact steps needed to download documents for one student.

#### Acceptance Criteria

1. WHEN the user activates recording mode via the extension popup, THE Extension SHALL begin capturing every click event along with the target element's DOM selector, element tag, text content, and position within the page.
2. WHEN the user clicks a DOM element during recording, THE Extension SHALL store the step with a stable DOM selector (preferring data attributes, then ID, then CSS class path) so that the selector survives React re-renders.
3. WHEN the user completes the recording and stops it via the extension popup, THE Extension SHALL persist the recorded step sequence to Chrome extension storage.
4. WHEN a recorded step sequence already exists in storage, THE Extension SHALL display the number of recorded steps and allow the user to clear and re-record.
5. WHEN the user scrolls the page during recording, THE Extension SHALL record the scroll action as a step including the scroll direction and target container selector.

### Requirement 2

**User Story:** As an administrator, I want the extension to replay my recorded steps for every eligible student row, so that I do not have to manually repeat the download process.

#### Acceptance Criteria

1. WHEN the user starts a replay session, THE Extension SHALL iterate over every visible row in the current table page and execute the full recorded step sequence for each eligible row.
2. WHEN replaying steps for a row, THE Extension SHALL wait for each target DOM element to become present and visible before executing the next step, with a configurable timeout of up to 10 seconds per step.
3. WHEN a step involves navigating away from the table (e.g., opening a student detail page), THE Extension SHALL execute the remaining steps in sequence and then navigate back to the table page before processing the next row.
4. WHEN the replay encounters a DOM element that cannot be located within the timeout period, THE Extension SHALL log the failure for that row, skip to the next row, and continue the session.
5. WHEN all steps for a row are completed, THE Extension SHALL mark that row as processed and record a success entry in the session log.

### Requirement 3

**User Story:** As an administrator, I want the extension to skip rows where the Onboarding status is "Not Started", so that I only process students who require action.

#### Acceptance Criteria

1. WHEN evaluating a table row before replay, THE Extension SHALL read the Onboarding Status cell value for that row.
2. WHEN the Onboarding Status cell value is "Not Started", THE Extension SHALL skip that row entirely without executing any recorded steps.
3. WHEN the Onboarding Status cell value is "Action Needed" or "Compliant Confirmed", THE Extension SHALL include that row in the replay queue.
4. WHEN a row is skipped due to "Not Started" status, THE Extension SHALL record a skip entry in the session log with the student identifier from that row.

### Requirement 4

**User Story:** As an administrator, I want the extension to handle pagination automatically, so that all students across all table pages are processed without manual page navigation.

#### Acceptance Criteria

1. WHEN the replay session completes all eligible rows on the current page, THE Extension SHALL detect the presence of a "Next" pagination control and activate it to advance to the next page.
2. WHEN a new page loads after pagination, THE Extension SHALL wait for the table rows to render before beginning row processing on the new page.
3. WHEN no "Next" pagination control is present or it is disabled, THE Extension SHALL treat the current page as the last page and end the session.
4. WHEN paginating, THE Extension SHALL preserve the session log across page transitions so that a complete record of all processed and skipped rows is available at the end.

### Requirement 5

**User Story:** As an administrator, I want the extension to handle students with varying numbers of uploaded documents, so that all documents for every eligible student are downloaded regardless of document count.

#### Acceptance Criteria

1. WHEN replaying steps for a row, THE Extension SHALL detect whether a "download next document" or equivalent repeating action exists in the recorded steps and execute it until no further documents are available for that student.
2. WHEN the extension detects that a repeating download action yields no new downloadable element, THE Extension SHALL treat the document set for that student as complete and proceed to the next row.
3. WHEN a student has zero documents available despite having an eligible Onboarding Status, THE Extension SHALL log a warning entry for that row and continue to the next row.

### Requirement 6

**User Story:** As an administrator, I want to see a session log and progress indicator, so that I can monitor the automation and review results.

#### Acceptance Criteria

1. WHEN a replay session is running, THE Extension SHALL display a live progress indicator in the extension popup showing the count of rows processed, rows skipped, rows failed, and total rows detected.
2. WHEN the replay session ends, THE Extension SHALL display a summary in the extension popup with total processed, skipped, failed counts, and a list of any failed row identifiers.
3. WHEN the user requests the session log, THE Extension SHALL provide an option to export the log as a plain-text or CSV file.
4. IF the browser tab is closed or navigated away from ExactOne during a session, THEN THE Extension SHALL pause the session and display a warning in the popup indicating the session was interrupted.
