# Implementation Plan

- [x] 1. Set up Chrome extension project structure and manifest





  - Create `manifest.json` (Manifest V3) with permissions: `storage`, `activeTab`, `scripting`, `downloads`
  - Define content script injection for Exxat One URLs
  - Create empty entry files: `background.js`, `content.js`, `popup.html`, `popup.js`
  - _Requirements: 1.1, 2.1_

- [x] 2. Implement the selector builder utility





- [x] 2.1 Implement `buildSelector(element)` function in `selector.js`


  - Priority order: data-testid → other data-* → non-generated ID → short class path → XPath fallback
  - _Requirements: 1.2_
- [ ]* 2.2 Write property test for selector round-trip stability
  - **Property 1: Selector round-trip stability**
  - **Validates: Requirements 1.2**
  - Generate random DOM trees, call `buildSelector`, verify `document.querySelector(result) === element`
  - Tag: `// Feature: exactone-downloader-extension, Property 1: Selector round-trip stability`

- [x] 3. Implement Chrome storage persistence layer





- [x] 3.1 Implement `storage.js` with `saveSteps(steps)`, `loadSteps()`, `saveLog(log)`, `loadLog()`, `clearAll()` functions


  - Wrap `chrome.storage.local` get/set with Promise-based API
  - _Requirements: 1.3_
- [ ]* 3.2 Write property test for step persistence round-trip
  - **Property 7: Step persistence round-trip**
  - **Validates: Requirements 1.3**
  - Generate random Step arrays, serialize/deserialize via storage functions, verify deep equality
  - Tag: `// Feature: exactone-downloader-extension, Property 7: Step persistence round-trip`

- [x] 4. Implement recording mode in content script





- [x] 4.1 Implement click capture listener in `content.js`


  - On each click during RECORDING mode, call `buildSelector`, capture tag and trimmed textContent, post `STEP_CAPTURED` message to background
  - _Requirements: 1.1, 1.2_
- [x] 4.2 Implement scroll capture listener in `content.js`


  - Detect scroll events, record direction and container selector as a step
  - _Requirements: 1.5_

- [x] 5. Implement service worker state machine and message routing





- [x] 5.1 Implement `background.js` state machine (IDLE → RECORDING → IDLE → REPLAYING → IDLE)


  - Handle messages: `START_RECORD`, `STOP_RECORD`, `START_REPLAY`, `STOP_REPLAY`, `CLEAR_STEPS`, `EXPORT_LOG`
  - Forward commands to active tab content script via `chrome.tabs.sendMessage`
  - Persist steps on `STOP_RECORD`, broadcast `STATUS_UPDATE` to popup
  - _Requirements: 1.3, 1.4, 2.1_

- [x] 6. Implement row status detection and filtering





- [x] 6.1 Implement `getOnboardingStatus(row)` in `content.js`


  - Locate the Onboarding Status cell within a row element and return its trimmed text value
  - _Requirements: 3.1_
- [x] 6.2 Implement `getTableRows()` in `content.js`


  - Return all visible student row elements from the current page table
  - _Requirements: 2.1, 3.1_
- [ ]* 6.3 Write property test for skip invariant
  - **Property 2: Skip invariant**
  - **Validates: Requirements 3.1, 3.2, 3.4**
  - Generate random row arrays with mixed statuses, run filter logic, verify "Not Started" rows never enter execution queue and produce skip log entries
  - Tag: `// Feature: exactone-downloader-extension, Property 2: Skip invariant`
- [ ]* 6.4 Write property test for eligible row inclusion
  - **Property 3: Eligible row inclusion**
  - **Validates: Requirements 3.3**
  - Verify "Action Needed" and "Compliant Confirmed" rows always appear in the processing queue
  - Tag: `// Feature: exactone-downloader-extension, Property 3: Eligible row inclusion`

- [x] 7. Implement `waitForElement` and single step execution





- [x] 7.1 Implement `waitForElement(selector, timeout)` in `content.js`


  - Poll DOM with `MutationObserver` or interval until element is present and visible, reject after timeout
  - _Requirements: 2.2_
- [x] 7.2 Implement `executeStep(step)` in `content.js`

  - For click steps: call `waitForElement`, then dispatch a click event on the resolved element
  - For scroll steps: scroll the target container in the recorded direction
  - Retry selector resolution up to 3 times with 500ms delay on failure
  - _Requirements: 2.2, 2.4_

- [x] 8. Implement per-row replay logic





- [x] 8.1 Implement `replayForRow(row, steps)` in `content.js`


  - Execute all steps in sequence, handle repeating download loop (isRepeating steps), detect loop termination when no new element found
  - Return `"success"`, `"skip"`, or `"fail"` with reason
  - _Requirements: 2.1, 2.3, 2.4, 2.5, 5.1, 5.2, 5.3_
- [ ]* 8.2 Write property test for step sequence completeness
  - **Property 4: Step sequence completeness**
  - **Validates: Requirements 2.1, 2.2**
  - Generate random step arrays and mock rows, verify replay attempts all N steps in order before marking row done
  - Tag: `// Feature: exactone-downloader-extension, Property 4: Step sequence completeness`

- [x] 9. Implement session log and pagination loop





- [x] 9.1 Implement `runReplaySession(steps)` in `content.js`


  - Outer loop: get rows → filter by status → replay each → log result → detect and click Next → repeat until no Next
  - Preserve log across page transitions via background storage
  - _Requirements: 4.1, 4.2, 4.3, 4.4, 6.1_
- [ ]* 9.2 Write property test for pagination exhaustion
  - **Property 5: Pagination exhaustion**
  - **Validates: Requirements 4.1, 4.2, 4.3**
  - Generate multi-page mock tables, run session, verify processed+skipped+failed equals total row count across all pages
  - Tag: `// Feature: exactone-downloader-extension, Property 5: Pagination exhaustion`
- [ ]* 9.3 Write property test for log entry per row
  - **Property 6: Log entry per row**
  - **Validates: Requirements 2.5, 3.4, 5.3, 6.1**
  - Generate sessions with random row counts and statuses, verify log has exactly one entry per row
  - Tag: `// Feature: exactone-downloader-extension, Property 6: Log entry per row`

- [x] 10. Checkpoint — Ensure all tests pass, ask the user if questions arise.






- [x] 11. Implement popup UI





- [x] 11.1 Build `popup.html` and `popup.js`


  - Render mode-appropriate controls (Start/Stop Record, Start/Stop Replay, Clear, Export)
  - Display recorded step count
  - Display live progress: processed / skipped / failed / total
  - Display session summary on completion with failed row identifiers
  - Show interruption warning when session is paused due to tab navigation
  - _Requirements: 1.4, 6.1, 6.2, 6.4_

- [x] 12. Implement CSV log export





- [x] 12.1 Implement `exportLog(log)` in `export.js`


  - Convert log array to CSV string with headers: rowIndex, studentId, status, reason, timestamp
  - Trigger browser download via `chrome.downloads.download`
  - _Requirements: 6.3_
- [ ]* 12.2 Write property test for log export completeness
  - **Property — log export**: For any log array, the CSV output must contain one data row per log entry with all required fields
  - **Validates: Requirements 6.3**
  - Tag: `// Feature: exactone-downloader-extension, Property: log export completeness`

- [x] 13. Wire all components together and handle edge cases





- [x] 13.1 Connect background ↔ content script message passing for all commands and events


  - Ensure `STATUS_UPDATE` messages flow from background to popup on every state change
  - Handle tab close / navigation interruption: listen for `chrome.tabs.onRemoved` and `chrome.webNavigation.onBeforeNavigate`, pause session and notify popup
  - _Requirements: 2.4, 6.4_
- [x] 13.2 Add storage error handling

  - Wrap all storage calls; on failure show error in popup and block session start
  - _Requirements: 1.3_

- [x] 14. Final Checkpoint — Ensure all tests pass, ask the user if questions arise.





