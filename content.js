// Content Script — Exxat One Downloader Extension
// Injected into Exxat One pages. Handles recording and replay.
// Implementation: Tasks 4, 6, 7, 8, 9

console.log("[Exxat Downloader] content.js loaded on", window.location.href);

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** @type {"IDLE" | "RECORDING" | "REPLAYING"} */
let mode = "IDLE";

// ---------------------------------------------------------------------------
// Task 4.1 — Click capture listener (Requirements 1.1, 1.2)
// ---------------------------------------------------------------------------

/** Tracks last click to deduplicate rapid repeated clicks on same element */
let lastClickSelector = null;
let lastClickTime = 0;
const CLICK_DEBOUNCE_MS = 300;

function onRecordClick(event) {
  const element = /** @type {Element} */ (event.target);
  if (!element || element.nodeType !== Node.ELEMENT_NODE) return;

  let selector;
  try {
    selector = buildSelector(element);
  } catch (err) {
    console.warn("[Exxat:RECORD] buildSelector failed:", err.message, element);
    return;
  }

  // Deduplicate: skip if same selector clicked within debounce window
  const now = Date.now();
  if (selector === lastClickSelector && (now - lastClickTime) < CLICK_DEBOUNCE_MS) {
    console.log("[Exxat:RECORD] Deduplicated rapid click on:", selector);
    return;
  }
  lastClickSelector = selector;
  lastClickTime = now;

  const step = {
    type: "click",
    selector,
    tag: element.tagName.toLowerCase(),
    textContent: (element.textContent || "").trim().slice(0, 200),
  };

  console.log(`[Exxat:RECORD] ✅ Click captured (step #${lastClickTime}):`, step);
  chrome.runtime.sendMessage({ action: "STEP_CAPTURED", step }, (resp) => {
    console.log("[Exxat:RECORD] STEP_CAPTURED ack:", resp);
  });
}

// ---------------------------------------------------------------------------
// Task 4.2 — Scroll capture listener (Requirements 1.5)
// ---------------------------------------------------------------------------

/** Tracks the last known scrollY per scroll container to determine direction. */
const lastScrollTop = new WeakMap();

/** Debounce timer for scroll events — only record one scroll per 800ms per container */
const scrollDebounceTimers = new WeakMap();
const SCROLL_DEBOUNCE_MS = 800;

function onRecordScroll(event) {
  const container = /** @type {Element | Window} */ (event.target);

  // Debounce: cancel previous timer for this container and set a new one
  if (scrollDebounceTimers.has(container)) {
    clearTimeout(scrollDebounceTimers.get(container));
  }

  const timer = setTimeout(() => {
    scrollDebounceTimers.delete(container);

    const currentTop =
      container === document || container === window
        ? window.scrollY
        : /** @type {Element} */ (container).scrollTop;

    const previous = lastScrollTop.has(container)
      ? lastScrollTop.get(container)
      : currentTop;

    const direction = currentTop >= previous ? "down" : "up";
    lastScrollTop.set(container, currentTop);

    let containerSelector = "window";
    if (container !== document && container !== window && container instanceof Element) {
      try {
        containerSelector = buildSelector(container);
      } catch (_) {
        containerSelector = "window";
      }
    }

    const step = {
      type: "scroll",
      selector: containerSelector,
      tag: container instanceof Element ? container.tagName.toLowerCase() : "window",
      textContent: "",
      scrollDirection: direction,
      scrollContainer: containerSelector,
    };

    console.log("[Exxat:RECORD] 📜 Scroll captured:", step);
    chrome.runtime.sendMessage({ action: "STEP_CAPTURED", step }, (resp) => {
      console.log("[Exxat:RECORD] STEP_CAPTURED scroll ack:", resp);
    });
  }, SCROLL_DEBOUNCE_MS);

  scrollDebounceTimers.set(container, timer);
}

// ---------------------------------------------------------------------------
// Service worker keepalive — ping background every 20s during active sessions
// so the SW doesn't go idle and lose state mid-recording or mid-replay.
// ---------------------------------------------------------------------------

let keepaliveInterval = null;

function startKeepalive() {
  if (keepaliveInterval) return;
  keepaliveInterval = setInterval(() => {
    chrome.runtime.sendMessage({ action: "PING" }).catch(() => {});
  }, 20000);
}

function stopKeepalive() {
  if (keepaliveInterval) {
    clearInterval(keepaliveInterval);
    keepaliveInterval = null;
  }
}

// ---------------------------------------------------------------------------
// Recording mode helpers
// ---------------------------------------------------------------------------

/** Attach recording listeners to the document. */
function startRecording() {
  mode = "RECORDING";
  lastClickSelector = null;
  lastClickTime = 0;
  startKeepalive();
  document.addEventListener("click", onRecordClick, { capture: true });
  document.addEventListener("scroll", onRecordScroll, { capture: true, passive: true });
  console.log("[Exxat:RECORD] 🔴 Recording STARTED on", window.location.href);
}

/** Detach recording listeners from the document. */
function stopRecording() {
  mode = "IDLE";
  stopKeepalive();
  document.removeEventListener("click", onRecordClick, { capture: true });
  document.removeEventListener("scroll", onRecordScroll, { capture: true });
  console.log("[Exxat:RECORD] ⏹ Recording STOPPED");
}

// ---------------------------------------------------------------------------
// Task 6.1 — getOnboardingStatus(row) (Requirements 3.1)
// ---------------------------------------------------------------------------

/**
 * The header text used to identify the Onboarding Status column.
 * Adjust if the column label differs on the live site.
 */
const ONBOARDING_STATUS_HEADER = "onboarding status";

/**
 * Reads the Onboarding Status cell value from a table row element.
 *
 * Strategy:
 *  1. Walk up from the row to find the parent <table> or <thead> and locate
 *     the column index whose header text matches "Onboarding Status".
 *  2. Return the trimmed text of the <td> at that column index.
 *  3. If the column cannot be found, fall back to scanning every <td> for a
 *     cell whose text matches one of the known status values.
 *
 * @param {Element} row - A <tr> element representing a student row.
 * @returns {string} Trimmed text of the Onboarding Status cell, or "" if not found.
 */
function getOnboardingStatus(row) {
  if (!row) return "";

  // --- Strategy 1: locate column by header ---
  const table = row.closest("table");
  if (table) {
    const headerCells = Array.from(
      table.querySelectorAll("thead th, thead td")
    );
    const colIndex = headerCells.findIndex(
      (th) => th.textContent.trim().toLowerCase() === ONBOARDING_STATUS_HEADER
    );

    if (colIndex !== -1) {
      const cells = row.querySelectorAll("td, th");
      const cell = cells[colIndex];
      if (cell) return cell.textContent.trim();
    }
  }

  // --- Strategy 2: scan cells for known status values ---
  const knownStatuses = ["not started", "action needed", "compliant confirmed"];
  const cells = Array.from(row.querySelectorAll("td, th"));
  for (const cell of cells) {
    const text = cell.textContent.trim();
    if (knownStatuses.includes(text.toLowerCase())) {
      return text;
    }
  }

  return "";
}

// ---------------------------------------------------------------------------
// Task 6.2 — getTableRows() (Requirements 2.1, 3.1)
// ---------------------------------------------------------------------------

/**
 * Returns all visible student row elements from the current page table.
 *
 * Looks for <tr> elements inside a <tbody> that are currently visible
 * (not hidden via display:none or visibility:hidden). Header rows (rows
 * that contain only <th> cells) are excluded.
 *
 * @returns {Element[]} Array of visible <tr> data-row elements.
 */
function getTableRows() {
  // Strategy 1: standard HTML table rows
  const tableRows = Array.from(
    document.querySelectorAll("table tbody tr, table tr")
  ).filter((row) => {
    const cells = Array.from(row.children);
    if (cells.length === 0) return false;
    if (cells.every((c) => c.tagName === "TH")) return false;
    const style = window.getComputedStyle(row);
    if (style.display === "none" || style.visibility === "hidden") return false;
    return true;
  });

  if (tableRows.length > 0) {
    console.log(`[Exxat:ROWS] Found ${tableRows.length} HTML table rows`);
    return tableRows;
  }

  // Strategy 2: ARIA list rows (role="row" or role="listitem")
  const ariaRows = Array.from(
    document.querySelectorAll('[role="row"], [role="listitem"]')
  ).filter((el) => {
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return false;
    // Must have some meaningful content
    if ((el.textContent || "").trim().length === 0) return false;
    return true;
  });

  if (ariaRows.length > 0) {
    console.log(`[Exxat:ROWS] Found ${ariaRows.length} ARIA rows`);
    return ariaRows;
  }

  // Strategy 3: MUI card/list items — look for repeated sibling divs inside a list container
  // Find the largest group of same-depth sibling divs that look like data rows
  const candidates = Array.from(document.querySelectorAll(
    '[class*="MuiList"] > *, [class*="MuiGrid"] > [class*="MuiGrid-item"], [class*="list"] > li, ul > li'
  )).filter((el) => {
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return false;
    if ((el.textContent || "").trim().length < 5) return false;
    return true;
  });

  if (candidates.length > 0) {
    console.log(`[Exxat:ROWS] Found ${candidates.length} MUI list/grid rows`);
    return candidates;
  }

  console.warn("[Exxat:ROWS] No rows found — page may not have a recognizable list/table structure");
  return [];
}

// ---------------------------------------------------------------------------
// Task 7.1 — waitForElement(selector, timeout) (Requirements 2.2)
// ---------------------------------------------------------------------------

/**
 * Waits for a DOM element matching `selector` to be present and visible.
 * Uses a MutationObserver to react to DOM changes, with a polling fallback.
 * Rejects with an Error if the element is not found within `timeout` ms.
 *
 * @param {string} selector - CSS selector to wait for.
 * @param {number} [timeout=10000] - Maximum wait time in milliseconds.
 * @returns {Promise<Element>} Resolves with the matched element.
 */
function waitForElement(selector, timeout = 10000) {
  return new Promise((resolve, reject) => {
    /**
     * Returns the element if it exists and is visible, otherwise null.
     * @returns {Element|null}
     */
    function findVisible() {
      const el = document.querySelector(selector);
      if (!el) return null;
      const style = window.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") return null;
      return el;
    }

    // Check immediately before setting up the observer
    const immediate = findVisible();
    if (immediate) {
      resolve(immediate);
      return;
    }

    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      observer.disconnect();
      reject(new Error(`waitForElement: timeout after ${timeout}ms for selector "${selector}"`));
    }, timeout);

    const observer = new MutationObserver(() => {
      if (settled) return;
      const el = findVisible();
      if (el) {
        settled = true;
        clearTimeout(timer);
        observer.disconnect();
        resolve(el);
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["style", "class", "hidden"],
    });
  });
}

// ---------------------------------------------------------------------------
// Task 7.2 — executeStep(step) (Requirements 2.2, 2.4)
// ---------------------------------------------------------------------------

/** Number of retry attempts when a selector cannot be resolved. */
const STEP_RETRY_COUNT = 3;
/** Delay in ms between retry attempts. */
const STEP_RETRY_DELAY_MS = 500;

/**
 * Pauses execution for `ms` milliseconds.
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Executes a single recorded step against the live DOM.
 *
 * - click steps: waits for the target element to appear, then dispatches a
 *   MouseEvent click. Retries selector resolution up to STEP_RETRY_COUNT
 *   times with STEP_RETRY_DELAY_MS between attempts.
 * - scroll steps: scrolls the target container in the recorded direction.
 *
 * @param {import('./selector.js').Step} step
 * @returns {Promise<void>}
 */
async function executeStep(step) {
  console.log(`[Exxat:REPLAY] ▶ executeStep type=${step.type} selector="${step.selector}" text="${step.textContent}"`);
  if (step.type === "click") {
    let lastError;
    for (let attempt = 0; attempt <= STEP_RETRY_COUNT; attempt++) {
      try {
        console.log(`[Exxat:REPLAY]   waitForElement attempt ${attempt + 1}/${STEP_RETRY_COUNT + 1}: "${step.selector}"`);
        const el = await waitForElement(step.selector);
        console.log(`[Exxat:REPLAY]   ✅ Element found, dispatching click:`, el);
        el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        console.log(`[Exxat:REPLAY]   ✅ Click dispatched on "${step.selector}"`);
        return;
      } catch (err) {
        lastError = err;
        console.warn(`[Exxat:REPLAY]   ❌ Attempt ${attempt + 1} failed: ${err.message}`);
        if (attempt < STEP_RETRY_COUNT) {
          console.log(`[Exxat:REPLAY]   ⏳ Retrying in ${STEP_RETRY_DELAY_MS}ms...`);
          await sleep(STEP_RETRY_DELAY_MS);
        }
      }
    }
    console.error(`[Exxat:REPLAY] ❌ executeStep FAILED after all retries: "${step.selector}"`);
    throw lastError;
  }

  if (step.type === "scroll") {
    const containerSelector = step.scrollContainer || step.selector;
    let container;
    if (!containerSelector || containerSelector === "window") {
      container = window;
    } else {
      container = document.querySelector(containerSelector);
      if (!container) {
        console.warn(`[Exxat:REPLAY]   scroll container not found "${containerSelector}", falling back to window`);
        container = window;
      }
    }
    const SCROLL_AMOUNT = 300;
    const delta = step.scrollDirection === "up" ? -SCROLL_AMOUNT : SCROLL_AMOUNT;
    console.log(`[Exxat:REPLAY]   scrolling ${step.scrollDirection} by ${delta}px on`, container);
    if (container === window) {
      window.scrollBy({ top: delta, behavior: "smooth" });
    } else {
      container.scrollBy({ top: delta, behavior: "smooth" });
    }
  }
}

// ---------------------------------------------------------------------------
// Task 8.1 — detectRepeatingBlock(steps)
// ---------------------------------------------------------------------------

/**
 * Auto-detects which steps form the "repeating download loop" by finding
 * the first selector that appears more than once in the recorded sequence.
 *
 * Your recording might look like:
 *   [0] click row          ← pre-loop (runs once)
 *   [1] click Download     ← loop start (same selector repeats)
 *   [2] click Next-doc     ← loop (same block)
 *   [1] click Download     ← second occurrence → marks loop boundary
 *   [2] click Next-doc
 *   [3] click Back         ← post-loop (runs once)
 *
 * Algorithm:
 *  1. Find the first selector that appears more than once → that's the
 *     loop-start index.
 *  2. The loop block is the slice from loop-start up to (but not including)
 *     the second occurrence of that same selector.
 *  3. Everything before loop-start is pre-steps; everything from the second
 *     occurrence onward is post-steps.
 *
 * If no selector repeats, the entire sequence is treated as pre-steps
 * (runs once per row, no loop).
 *
 * @param {Array<object>} steps
 * @returns {{ preSteps: object[], loopSteps: object[], postSteps: object[] }}
 */
function detectRepeatingBlock(steps) {
  if (!steps || steps.length === 0) {
    return { preSteps: [], loopSteps: [], postSteps: [] };
  }

  // If any step already has isRepeating set (manual override), use that.
  const hasManualMarkers = steps.some((s) => s.isRepeating);
  if (hasManualMarkers) {
    const firstRepeatingIdx = steps.findIndex((s) => s.isRepeating);
    const lastRepeatingIdx = steps.reduce((last, s, i) => (s.isRepeating ? i : last), -1);
    return {
      preSteps: steps.slice(0, firstRepeatingIdx),
      loopSteps: steps.slice(firstRepeatingIdx, lastRepeatingIdx + 1),
      postSteps: steps.slice(lastRepeatingIdx + 1),
    };
  }

  // Auto-detect: find the first selector that appears more than once.
  // Only consider click steps for loop detection (scrolls are usually unique).
  const clickSteps = steps.map((s, i) => ({ ...s, _origIdx: i })).filter((s) => s.type === "click");

  let loopStartOrigIdx = -1;
  let loopBlockLength = 0;

  for (let i = 0; i < clickSteps.length; i++) {
    const sel = clickSteps[i].selector;
    // Find the next occurrence of this same selector
    const nextOccurrence = clickSteps.findIndex((s, j) => j > i && s.selector === sel);
    if (nextOccurrence !== -1) {
      // The loop block is the steps between the first and second occurrence (inclusive of first)
      loopStartOrigIdx = clickSteps[i]._origIdx;
      loopBlockLength = clickSteps[nextOccurrence]._origIdx - loopStartOrigIdx;
      break;
    }
  }

  if (loopStartOrigIdx === -1 || loopBlockLength <= 0) {
    // No repeating pattern found — run everything once
    console.log("[Exxat:REPLAY] No repeating block detected — running all steps once per row");
    return { preSteps: steps, loopSteps: [], postSteps: [] };
  }

  const preSteps = steps.slice(0, loopStartOrigIdx);
  const loopSteps = steps.slice(loopStartOrigIdx, loopStartOrigIdx + loopBlockLength);
  const postSteps = steps.slice(loopStartOrigIdx + loopBlockLength);

  console.log(
    `[Exxat:REPLAY] Auto-detected loop: pre=${preSteps.length} loop=${loopSteps.length} post=${postSteps.length}`,
    "\n  Loop steps:", loopSteps.map((s) => `${s.type}:${s.selector}`)
  );

  return { preSteps, loopSteps, postSteps };
}

// ---------------------------------------------------------------------------
// Task 8.1 — replayForRow(row, steps) (Requirements 2.1, 2.3, 2.4, 2.5, 5.1, 5.2, 5.3)
// ---------------------------------------------------------------------------

/**
 * Executes the recorded step sequence for a single eligible table row.
 *
 * Behaviour:
 *  - Skips the row immediately if its Onboarding Status is "Not Started".
 *  - Auto-detects the repeating download loop from duplicate selectors in
 *    the recording (no manual marking needed).
 *  - Runs pre-loop steps once, then loops the loop-block until the first
 *    element in the loop can no longer be found (documents exhausted).
 *  - Runs post-loop steps once.
 *  - If any non-loop step fails, the row is marked failed.
 *
 * @param {Element} row - The <tr> element for this student.
 * @param {Array<object>} steps - The recorded step sequence.
 * @returns {Promise<{ result: "success" | "skip" | "fail", reason?: string }>}
 */
async function replayForRow(row, steps) {
  const status = getOnboardingStatus(row);
  const studentId = extractStudentId(row);
  console.log(`[Exxat:REPLAY] 👤 replayForRow student="${studentId}" status="${status}"`);

  if (status.toLowerCase() === "not started") {
    console.log(`[Exxat:REPLAY]   ⏭ SKIPPING row (Not Started)`);
    return { result: "skip", reason: "Onboarding Status is Not Started" };
  }

  if (!steps || steps.length === 0) {
    return { result: "success" };
  }

  const { preSteps, loopSteps, postSteps } = detectRepeatingBlock(steps);

  // --- Execute pre-loop steps (run once) ---
  for (const step of preSteps) {
    try {
      await executeStep(step);
    } catch (err) {
      return {
        result: "fail",
        reason: `Pre-loop step failed (selector: "${step.selector}"): ${err.message}`,
      };
    }
  }

  // --- Execute repeating download loop ---
  if (loopSteps.length > 0) {
    const loopTriggerSelector = loopSteps[0].selector;
    let iteration = 0;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      // Probe: is the loop-trigger element still present?
      // Use a short timeout (1.5s) so we don't stall when docs are exhausted.
      let elementPresent = false;
      try {
        await waitForElement(loopTriggerSelector, 1500);
        elementPresent = true;
      } catch (_) {
        elementPresent = false;
      }

      if (!elementPresent) {
        console.log(`[Exxat:REPLAY]   🔁 Loop ended after ${iteration} iteration(s) — no more documents`);
        break;
      }

      console.log(`[Exxat:REPLAY]   🔁 Loop iteration ${iteration + 1}`);
      let loopBroke = false;
      for (const step of loopSteps) {
        try {
          await executeStep(step);
        } catch (_) {
          // Element disappeared mid-loop — treat as loop exhausted
          loopBroke = true;
          break;
        }
      }

      if (loopBroke) {
        console.log(`[Exxat:REPLAY]   🔁 Loop broke mid-iteration — treating as exhausted`);
        break;
      }
      iteration++;
    }
  }

  // --- Execute post-loop steps (run once) ---
  for (const step of postSteps) {
    try {
      await executeStep(step);
    } catch (err) {
      return {
        result: "fail",
        reason: `Post-loop step failed (selector: "${step.selector}"): ${err.message}`,
      };
    }
  }

  return { result: "success" };
}

// ---------------------------------------------------------------------------
// Task 9.1 — clickNextPage() helper (Requirements 4.1, 4.3)
// ---------------------------------------------------------------------------

/**
 * Attempts to locate and click the "Next" pagination button on the current page.
 *
 * Looks for common pagination patterns:
 *  - A button/anchor whose accessible text is "Next" (case-insensitive)
 *  - An element with aria-label="Next page" or similar
 *  - A disabled state is treated as "no next page"
 *
 * @returns {Promise<boolean>} true if the Next button was found and clicked,
 *                             false if no active Next button exists.
 */
async function clickNextPage() {
  // Candidate selectors for the Next pagination control
  const candidates = Array.from(
    document.querySelectorAll(
      'button, a, [role="button"], [role="link"]'
    )
  );

  const nextBtn = candidates.find((el) => {
    // Skip disabled controls
    if (el.hasAttribute("disabled")) return false;
    if (el.getAttribute("aria-disabled") === "true") return false;

    const label = (
      el.textContent.trim() +
      " " +
      (el.getAttribute("aria-label") || "") +
      " " +
      (el.getAttribute("title") || "")
    ).toLowerCase();

    return label.includes("next");
  });

  if (!nextBtn) return false;

  nextBtn.dispatchEvent(
    new MouseEvent("click", { bubbles: true, cancelable: true })
  );

  // Wait for the table to re-render after pagination (Requirement 4.2)
  // We wait for at least one <tbody tr> to appear (up to 10 s)
  try {
    await waitForElement("table tbody tr", 10000);
  } catch (_) {
    // If the table doesn't appear, we'll handle it in the outer loop
  }

  return true;
}

// ---------------------------------------------------------------------------
// Task 9.1 — runReplaySession(steps) (Requirements 4.1–4.4, 6.1)
// ---------------------------------------------------------------------------

/** Set to true when a STOP_REPLAY command is received mid-session. */
let stopReplayRequested = false;

/**
 * Sends a log entry to the background service worker for persistence and
 * broadcasts a progress update.
 *
 * @param {object} entry - LogEntry object
 */
async function sendLogEntry(entry) {
  try {
    await chrome.runtime.sendMessage({ action: "LOG_ENTRY", entry });
  } catch (_) {
    // Background may be temporarily unavailable; continue session
  }
}

/**
 * Sends a progress update to the background service worker.
 *
 * @param {{ processed?: number, skipped?: number, failed?: number, total?: number }} progress
 */
async function sendProgressUpdate(progress) {
  try {
    await chrome.runtime.sendMessage({ action: "PROGRESS_UPDATE", progress });
  } catch (_) {
    // Ignore
  }
}

/**
 * Outer replay loop.
 *
 * Algorithm:
 *  1. Get all visible table rows on the current page.
 *  2. Update total count (cumulative across pages).
 *  3. For each row, call replayForRow and log the result.
 *  4. After all rows on the page are processed, attempt to click Next.
 *  5. If Next was clicked, wait for the new page and repeat from step 1.
 *  6. If no Next button exists, end the session.
 *
 * Log entries are sent to the background after each row so they survive
 * page transitions (Requirement 4.4).
 *
 * @param {Array<import('./selector.js').Step>} steps - The recorded step sequence.
 * @returns {Promise<void>}
 */
async function runReplaySession(steps) {
  stopReplayRequested = false;
  mode = "REPLAYING";
  startKeepalive();
  console.log(`[Exxat:REPLAY] 🚀 Session STARTED with ${steps.length} steps:`, steps.map(s => `${s.type}:${s.selector}`));

  const progress = { processed: 0, skipped: 0, failed: 0, total: 0 };
  let pageIndex = 0;

  while (true) {
    if (stopReplayRequested) { console.log("[Exxat:REPLAY] 🛑 Stop requested, breaking"); break; }

    const rows = getTableRows();
    console.log(`[Exxat:REPLAY] 📄 Page ${pageIndex}: found ${rows.length} rows`);
    progress.total += rows.length;
    await sendProgressUpdate({ ...progress });

    for (let i = 0; i < rows.length; i++) {
      if (stopReplayRequested) break;

      const row = rows[i];
      const studentId = extractStudentId(row);
      console.log(`[Exxat:REPLAY] 🔄 Processing row ${i + 1}/${rows.length} student="${studentId}"`);

      let logEntry;
      try {
        const { result, reason } = await replayForRow(row, steps);

        if (result === "skip") {
          progress.skipped++;
          console.log(`[Exxat:REPLAY]   ⏭ Row ${i} SKIPPED: ${reason}`);
          logEntry = {
            rowIndex: progress.processed + progress.skipped + progress.failed - 1 + i,
            studentId,
            status: "skipped",
            reason: reason || "Onboarding Status is Not Started",
            timestamp: new Date().toISOString(),
          };
        } else if (result === "success") {
          progress.processed++;
          console.log(`[Exxat:REPLAY]   ✅ Row ${i} PROCESSED`);
          logEntry = {
            rowIndex: pageIndex * rows.length + i,
            studentId,
            status: "processed",
            timestamp: new Date().toISOString(),
          };
        } else {
          progress.failed++;
          console.error(`[Exxat:REPLAY]   ❌ Row ${i} FAILED: ${reason}`);
          logEntry = {
            rowIndex: pageIndex * rows.length + i,
            studentId,
            status: "failed",
            reason: reason || "Unknown failure",
            timestamp: new Date().toISOString(),
          };
        }
      } catch (err) {
        progress.failed++;
        logEntry = {
          rowIndex: pageIndex * rows.length + i,
          studentId,
          status: "failed",
          reason: err.message,
          timestamp: new Date().toISOString(),
        };
      }

      // Persist log entry immediately so it survives page transitions (Req 4.4)
      await sendLogEntry(logEntry);
      await sendProgressUpdate({ ...progress });
    }

    if (stopReplayRequested) break;

    // Attempt to advance to the next page (Requirements 4.1, 4.3)
    const advanced = await clickNextPage();
    if (!advanced) {
      console.log("[Exxat:REPLAY] 🏁 No Next button — session complete");
      break;
    }
    console.log(`[Exxat:REPLAY] ➡ Advanced to page ${pageIndex + 1}`);
    pageIndex++;
  }

  mode = "IDLE";
  stopKeepalive();

  // Notify background that the session has ended
  try {
    await chrome.runtime.sendMessage({ action: "REPLAY_COMPLETE" });
  } catch (_) {
    // Ignore
  }
}

// ---------------------------------------------------------------------------
// extractStudentId — pull a human-readable identifier from a row
// ---------------------------------------------------------------------------

/**
 * Attempts to extract a student identifier (name or email) from a table row.
 * Falls back to a generic label if nothing useful is found.
 *
 * @param {Element} row
 * @returns {string}
 */
function extractStudentId(row) {
  // Look for an email-like string in any cell
  const cells = Array.from(row.querySelectorAll("td"));
  for (const cell of cells) {
    const text = cell.textContent.trim();
    if (text.includes("@")) return text.slice(0, 100);
  }
  // Fall back to the first non-empty cell text
  for (const cell of cells) {
    const text = cell.textContent.trim();
    if (text.length > 0) return text.slice(0, 100);
  }
  return "(unknown)";
}

// ---------------------------------------------------------------------------
// Message listener — receives commands from background service worker
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  switch (message.action) {
    case "PING":
      sendResponse({ ok: true });
      break;

    case "START_RECORD":
      startRecording();
      sendResponse({ ok: true });
      break;

    case "STOP_RECORD":
      stopRecording();
      sendResponse({ ok: true });
      break;

    case "START_REPLAY": {
      const steps = message.steps || [];
      // Run the session asynchronously; respond immediately so the channel
      // doesn't time out waiting for the (potentially long) session to finish.
      sendResponse({ ok: true });
      runReplaySession(steps).catch((err) => {
        console.error("[content] runReplaySession error:", err);
        chrome.runtime.sendMessage({ action: "REPLAY_COMPLETE" }).catch(() => {});
      });
      break;
    }

    case "STOP_REPLAY":
      stopReplayRequested = true;
      mode = "IDLE";
      sendResponse({ ok: true });
      break;

    default:
      break;
  }
});
