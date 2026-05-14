// Content Script — Exxat One Downloader Extension
// Injected into Exxat One pages. Handles recording and replay.
// Rebuilt to match the actual Exxat One workflow observed in screenshots.

console.log("[Exxat Downloader] content.js loaded on", window.location.href);

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** @type {"IDLE" | "RECORDING" | "REPLAYING"} */
let mode = "IDLE";

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/**
 * Pauses execution for `ms` milliseconds.
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Waits for a DOM element matching `selector` to be present and visible.
 * Uses MutationObserver + timeout.
 * @param {string} selector
 * @param {number} [timeout=10000]
 * @returns {Promise<Element>}
 */
function waitForElement(selector, timeout = 10000) {
  return new Promise((resolve, reject) => {
    function findVisible() {
      const el = document.querySelector(selector);
      if (!el) return null;
      const style = window.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") return null;
      return el;
    }

    const immediate = findVisible();
    if (immediate) { resolve(immediate); return; }

    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      observer.disconnect();
      reject(new Error(`waitForElement: timeout after ${timeout}ms for "${selector}"`));
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
      childList: true, subtree: true, attributes: true,
      attributeFilter: ["style", "class", "hidden"],
    });
  });
}

/**
 * Wait for the URL to change (React navigation).
 * @param {string} fromUrl - URL before navigation
 * @param {number} [timeout=10000]
 * @returns {Promise<void>}
 */
function waitForNavigation(fromUrl, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = setInterval(() => {
      if (window.location.href !== fromUrl) {
        clearInterval(check);
        resolve();
      } else if (Date.now() - start > timeout) {
        clearInterval(check);
        reject(new Error("waitForNavigation: timeout — URL did not change"));
      }
    }, 100);
  });
}

/**
 * Wait for the URL to match a pattern.
 * @param {RegExp} pattern
 * @param {number} [timeout=10000]
 * @returns {Promise<void>}
 */
function waitForUrl(pattern, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = setInterval(() => {
      if (pattern.test(window.location.href)) {
        clearInterval(check);
        resolve();
      } else if (Date.now() - start > timeout) {
        clearInterval(check);
        reject(new Error(`waitForUrl: timeout — URL never matched ${pattern}`));
      }
    }, 100);
  });
}

// ---------------------------------------------------------------------------
// Service worker keepalive
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
// Recording — click + scroll capture
// ---------------------------------------------------------------------------

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

  const now = Date.now();
  if (selector === lastClickSelector && (now - lastClickTime) < CLICK_DEBOUNCE_MS) return;
  lastClickSelector = selector;
  lastClickTime = now;

  const step = {
    type: "click",
    selector,
    tag: element.tagName.toLowerCase(),
    textContent: (element.textContent || "").trim().slice(0, 200),
  };

  console.log("[Exxat:RECORD] ✅ Click:", step);
  chrome.runtime.sendMessage({ action: "STEP_CAPTURED", step });
}

const lastScrollTop = new WeakMap();
const scrollDebounceTimers = new WeakMap();
const SCROLL_DEBOUNCE_MS = 800;

function onRecordScroll(event) {
  const container = /** @type {Element | Window} */ (event.target);
  if (scrollDebounceTimers.has(container)) clearTimeout(scrollDebounceTimers.get(container));

  const timer = setTimeout(() => {
    scrollDebounceTimers.delete(container);
    const currentTop = container === document || container === window
      ? window.scrollY
      : /** @type {Element} */ (container).scrollTop;
    const previous = lastScrollTop.has(container) ? lastScrollTop.get(container) : currentTop;
    const direction = currentTop >= previous ? "down" : "up";
    lastScrollTop.set(container, currentTop);

    let containerSelector = "window";
    if (container !== document && container !== window && container instanceof Element) {
      try { containerSelector = buildSelector(container); } catch (_) {}
    }

    const step = {
      type: "scroll", selector: containerSelector,
      tag: container instanceof Element ? container.tagName.toLowerCase() : "window",
      textContent: "", scrollDirection: direction, scrollContainer: containerSelector,
    };
    console.log("[Exxat:RECORD] 📜 Scroll:", step);
    chrome.runtime.sendMessage({ action: "STEP_CAPTURED", step });
  }, SCROLL_DEBOUNCE_MS);

  scrollDebounceTimers.set(container, timer);
}

function startRecording() {
  mode = "RECORDING";
  lastClickSelector = null;
  lastClickTime = 0;
  startKeepalive();
  document.addEventListener("click", onRecordClick, { capture: true });
  document.addEventListener("scroll", onRecordScroll, { capture: true, passive: true });
  console.log("[Exxat:RECORD] 🔴 Recording STARTED on", window.location.href);
}

function stopRecording() {
  mode = "IDLE";
  stopKeepalive();
  document.removeEventListener("click", onRecordClick, { capture: true });
  document.removeEventListener("scroll", onRecordScroll, { capture: true });
  console.log("[Exxat:RECORD] ⏹ Recording STOPPED");
}

// ---------------------------------------------------------------------------
// Onboarding Status detection (list page)
// ---------------------------------------------------------------------------

const ONBOARDING_STATUS_HEADER = "onboarding status";

/**
 * Known statuses to skip — "Not Applicable" is also not actionable.
 * "Some Action Needed" and "Action Needed" are both eligible.
 */
const SKIP_STATUSES = ["not started", "not applicable"];

/**
 * Reads the Onboarding Status cell value from a table row element.
 * @param {Element} row
 * @returns {string}
 */
function getOnboardingStatus(row) {
  if (!row) return "";

  const table = row.closest("table");
  if (table) {
    const headerCells = Array.from(table.querySelectorAll("thead th, thead td"));
    const colIndex = headerCells.findIndex(
      (th) => th.textContent.trim().toLowerCase() === ONBOARDING_STATUS_HEADER
    );
    if (colIndex !== -1) {
      const cells = row.querySelectorAll("td, th");
      const cell = cells[colIndex];
      if (cell) return cell.textContent.trim();
    }
  }

  // Fallback: scan cells for known status text
  const knownStatuses = [
    "not started", "not applicable",
    "some action needed", "action needed", "compliant confirmed"
  ];
  const cells = Array.from(row.querySelectorAll("td, th"));
  for (const cell of cells) {
    const text = cell.textContent.trim();
    if (knownStatuses.includes(text.toLowerCase())) return text;
  }

  return "";
}

/**
 * Returns all visible data rows from the current page table.
 * @returns {Element[]}
 */
function getTableRows() {
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
    console.log(`[Exxat:ROWS] Found ${tableRows.length} table rows`);
    return tableRows;
  }

  // ARIA rows fallback
  const ariaRows = Array.from(
    document.querySelectorAll('[role="row"], [role="listitem"]')
  ).filter((el) => {
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return false;
    if ((el.textContent || "").trim().length === 0) return false;
    return true;
  });

  if (ariaRows.length > 0) {
    console.log(`[Exxat:ROWS] Found ${ariaRows.length} ARIA rows`);
    return ariaRows;
  }

  console.warn("[Exxat:ROWS] No rows found");
  return [];
}

/**
 * Extract a human-readable student identifier from a row.
 * @param {Element} row
 * @returns {string}
 */
function extractStudentId(row) {
  const cells = Array.from(row.querySelectorAll("td"));
  for (const cell of cells) {
    const text = cell.textContent.trim();
    if (text.includes("@")) return text.slice(0, 100);
  }
  for (const cell of cells) {
    const text = cell.textContent.trim();
    if (text.length > 0) return text.slice(0, 100);
  }
  return "(unknown)";
}

// ---------------------------------------------------------------------------
// Exxat-specific: navigate into a student row
// ---------------------------------------------------------------------------

/**
 * From the logs: clicking the status cell link (a.flex.gap-2 or the row's
 * detail link) navigates to /assignments/{id}?tab=caas.
 * The selector from the recording was:
 *   tr.group.duration-150:nth-of-type(2) > td... > div.min-w-0.py-3
 * but that's row-specific. We find the link dynamically per row.
 *
 * @param {Element} row
 * @returns {boolean}
 */
function clickRowToOpenDetail(row) {
  // Strategy 1: any <a> inside the row that links to /assignments/{id}
  const links = Array.from(row.querySelectorAll("a[href]"));
  const detailLink = links.find((a) => {
    const href = a.getAttribute("href") || "";
    return /\/assignments\/[a-f0-9]{24}/.test(href);
  });
  if (detailLink) {
    console.log("[Exxat:NAV] Clicking detail link:", detailLink.getAttribute("href"));
    detailLink.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    return true;
  }

  // Strategy 2: the status/name cell — from logs it's a div or anchor in the row
  // The onboarding status cell is the last meaningful cell; the student name cell
  // is earlier. Click the student name/details cell which is a link.
  const statusLink = row.querySelector("a.flex, a[class*='flex']");
  if (statusLink) {
    console.log("[Exxat:NAV] Clicking flex link:", statusLink.textContent.trim().slice(0, 50));
    statusLink.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    return true;
  }

  // Strategy 3: click the onboarding status cell div (from logs: div.min-w-0.py-3)
  const statusCell = row.querySelector("div.min-w-0.py-3, td div[class*='py-3']");
  if (statusCell) {
    console.log("[Exxat:NAV] Clicking status cell div");
    statusCell.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    return true;
  }

  // Strategy 4: click the row itself
  console.log("[Exxat:NAV] Clicking row directly");
  row.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  return true;
}

// ---------------------------------------------------------------------------
// Exxat-specific: download all documents on the student detail page
// ---------------------------------------------------------------------------

/**
 * On the student detail page, iterates through every requirement in the
 * left panel, clicks it, and if a Download button appears — clicks it.
 *
 * The left panel shows items like:
 *   "Carry Forward - Epic Request Form"  → Get Started (no download)
 *   "Tuberculosis (TB)"                  → Download button visible
 *
 * @returns {Promise<{ downloaded: number, total: number }>}
 */
async function downloadAllDocumentsOnDetailPage() {
  console.log("[Exxat:DETAIL] Starting on", window.location.href);

  // Wait for requirement rows — confirmed selector from logs: div.mb-2.flex
  try {
    await waitForElement("div.mb-2.flex", 8000);
  } catch (_) {
    console.warn("[Exxat:DETAIL] div.mb-2.flex not found, trying span.text-sm.text-gray-900");
    try { await waitForElement("span.text-sm.text-gray-900", 5000); } catch (_2) {}
  }
  await sleep(500);

  const requirementRows = getRequirementItems();
  console.log(`[Exxat:DETAIL] Found ${requirementRows.length} requirement rows`);

  let downloaded = 0;

  for (let i = 0; i < requirementRows.length; i++) {
    if (stopReplayRequested) break;

    const row = requirementRows[i];
    const nameEl = row.querySelector("span.text-sm.text-gray-900, span[class*='text-sm']");
    const name = nameEl ? nameEl.textContent.trim() : `Requirement ${i + 1}`;
    console.log(`[Exxat:DETAIL] Req ${i + 1}/${requirementRows.length}: "${name}"`);

    // Primary: the download arrow button is button.px-3.min-w-[32px] inside this row
    // CSS.escape needed for the bracket characters in the class name
    const downloadBtn = row.querySelector("button.px-3") ||
      row.querySelector("button[class*='min-w']") ||
      row.querySelector("button[class*='px-3']");

    if (downloadBtn) {
      const style = window.getComputedStyle(downloadBtn);
      if (style.display !== "none" && style.visibility !== "hidden") {
        console.log(`[Exxat:DETAIL]   ⬇ Clicking download button for "${name}"`);
        downloadBtn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        downloaded++;
        await sleep(1000);
        continue;
      }
    }

    // Fallback: click the row to open right panel, then find Download button
    console.log(`[Exxat:DETAIL]   Opening right panel for "${name}"`);
    row.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await sleep(800);

    const rightBtn = await findDownloadButton();
    if (rightBtn) {
      console.log(`[Exxat:DETAIL]   ⬇ Right-panel Download for "${name}"`);
      rightBtn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      downloaded++;
      await sleep(1000);
    } else {
      console.log(`[Exxat:DETAIL]   ℹ No download for "${name}"`);
    }
  }

  console.log(`[Exxat:DETAIL] Done — ${downloaded}/${requirementRows.length} downloaded`);
  return { downloaded, total: requirementRows.length };
}

/**
 * Finds all clickable requirement items in the left panel of the detail page.
 *
 * From the Exxat page structure observed in logs and screenshots:
 * - The left panel has a list of requirements
 * - Each item shows the requirement name + a status ("Get Started", "Pending Review", etc.)
 * - Clicking an item loads its detail in the right panel
 * - Items that have a document uploaded show a Download button in the right panel
 *
 * @returns {Element[]}
 */
function getRequirementItems() {
  // Primary selector confirmed from recording logs:
  // Each requirement row is div.mb-2.flex (Tailwind: margin-bottom-2 + flex)
  const primary = Array.from(document.querySelectorAll("div.mb-2.flex")).filter((el) => {
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return false;
    // Must contain a span with text (the requirement name)
    const span = el.querySelector("span");
    return span && (span.textContent || "").trim().length > 3;
  });

  if (primary.length > 0) {
    console.log(`[Exxat:DETAIL] Found ${primary.length} requirement rows (div.mb-2.flex)`);
    return primary;
  }

  // Fallback: find by status text
  const statusTexts = ["get started", "pending review", "compliant", "not started", "action needed"];
  const byStatus = Array.from(document.querySelectorAll("div, li")).filter((el) => {
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return false;
    const text = (el.textContent || "").trim().toLowerCase();
    if (text.length > 400) return false;
    return statusTexts.some((s) => text.includes(s));
  });

  const deduped = byStatus.filter((el) =>
    !byStatus.some((other) => other !== el && other.contains(el))
  );

  if (deduped.length > 0) {
    console.log(`[Exxat:DETAIL] Found ${deduped.length} requirement rows (status text fallback)`);
    return deduped;
  }

  console.warn("[Exxat:DETAIL] No requirement rows found");
  return [];
}

/**
 * Looks for a Download button in the right panel of the detail page.
 * Returns the button element if found, null otherwise.
 *
 * From console logs: Exxat uses FontAwesome icons with data-prefix="fal"/"fas".
 * The Download button contains a FontAwesome download icon + "Download" text.
 * @returns {Promise<Element|null>}
 */
async function findDownloadButton() {
  function search() {
    const allButtons = Array.from(document.querySelectorAll('button, a, [role="button"]'));
    return allButtons.find((btn) => {
      const style = window.getComputedStyle(btn);
      if (style.display === "none" || style.visibility === "hidden") return false;
      const text = (btn.textContent || "").trim().toLowerCase();
      // Must contain "download" text
      if (!text.includes("download")) return false;
      // Must NOT be a "History" button or other non-download button
      if (text.includes("history") || text.includes("upload")) return false;
      return true;
    }) || null;
  }

  // Try immediately
  const immediate = search();
  if (immediate) return immediate;

  // Wait up to 1.5s for the right panel to update after clicking a requirement
  await sleep(500);
  return search();
}

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

/**
 * Clicks the Next pagination button if present and enabled.
 * @returns {Promise<boolean>}
 */
async function clickNextPage() {
  const candidates = Array.from(
    document.querySelectorAll('button, a, [role="button"], [role="link"]')
  );

  const nextBtn = candidates.find((el) => {
    if (el.hasAttribute("disabled")) return false;
    if (el.getAttribute("aria-disabled") === "true") return false;
    const label = (
      el.textContent.trim() + " " +
      (el.getAttribute("aria-label") || "") + " " +
      (el.getAttribute("title") || "")
    ).toLowerCase();
    return label.includes("next") && !label.includes("previous");
  });

  if (!nextBtn) return false;

  console.log("[Exxat:PAGINATION] Clicking Next button");
  nextBtn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

  // Wait for table rows to re-render
  await sleep(1500);
  try {
    await waitForElement("table tbody tr", 10000);
  } catch (_) {}

  return true;
}

// ---------------------------------------------------------------------------
// Progress / log messaging
// ---------------------------------------------------------------------------

async function sendLogEntry(entry) {
  try {
    await chrome.runtime.sendMessage({ action: "LOG_ENTRY", entry });
  } catch (_) {}
}

async function sendProgressUpdate(progress) {
  try {
    await chrome.runtime.sendMessage({ action: "PROGRESS_UPDATE", progress });
  } catch (_) {}
}

// ---------------------------------------------------------------------------
// Main replay session — Exxat-specific workflow
// ---------------------------------------------------------------------------

/** Set to true when STOP_REPLAY is received */
let stopReplayRequested = false;

/**
 * Main replay loop for Exxat One.
 *
 * For each row on the list page:
 *   1. Check Onboarding Status — skip if "Not Started" or "Not Applicable"
 *   2. Click the eye icon to open the student detail page
 *   3. On the detail page, click each requirement and download if available
 *   4. Navigate back to the list page
 *   5. Repeat for next row
 *   6. After all rows, click Next page if available
 *
 * NOTE: `steps` parameter is kept for compatibility but the Exxat-specific
 * engine does NOT use recorded steps — it drives the UI directly based on
 * the known page structure. If steps are provided and contain a custom
 * recorded sequence, it falls back to the recorded-step replay.
 *
 * @param {Array<object>} steps
 * @returns {Promise<void>}
 */
async function runReplaySession(steps) {
  stopReplayRequested = false;
  mode = "REPLAYING";
  startKeepalive();

  const listPageUrl = window.location.href;
  console.log(`[Exxat:REPLAY] 🚀 Session STARTED. List page: ${listPageUrl}`);
  console.log(`[Exxat:REPLAY] Recorded steps available: ${steps.length}`);

  // Decide mode: if steps were recorded, use them; otherwise use built-in engine
  const useRecordedSteps = steps.length > 0;
  if (useRecordedSteps) {
    console.log("[Exxat:REPLAY] Using RECORDED STEPS mode");
  } else {
    console.log("[Exxat:REPLAY] Using BUILT-IN EXXAT ENGINE mode");
  }

  const progress = { processed: 0, skipped: 0, failed: 0, total: 0 };
  let pageIndex = 0;

  while (true) {
    if (stopReplayRequested) break;

    // Make sure we're on the list page
    if (!window.location.href.includes("/assignments/list") &&
        !window.location.href.includes("/assignments") &&
        pageIndex > 0) {
      console.warn("[Exxat:REPLAY] Not on list page — navigating back");
      window.history.back();
      await sleep(2000);
    }

    const rows = getTableRows();
    console.log(`[Exxat:REPLAY] 📄 Page ${pageIndex + 1}: ${rows.length} rows`);

    if (rows.length === 0) {
      console.warn("[Exxat:REPLAY] No rows found — ending session");
      break;
    }

    progress.total += rows.length;
    await sendProgressUpdate({ ...progress });

    for (let i = 0; i < rows.length; i++) {
      if (stopReplayRequested) break;

      const row = rows[i];
      const studentId = extractStudentId(row);
      const onboardingStatus = getOnboardingStatus(row);
      console.log(`[Exxat:REPLAY] Row ${i + 1}/${rows.length}: "${studentId}" status="${onboardingStatus}"`);

      // Skip rows that don't need action
      if (SKIP_STATUSES.includes(onboardingStatus.toLowerCase())) {
        console.log(`[Exxat:REPLAY]   ⏭ SKIPPING (${onboardingStatus})`);
        progress.skipped++;
        await sendLogEntry({
          rowIndex: pageIndex * rows.length + i,
          studentId,
          status: "skipped",
          reason: `Onboarding Status: ${onboardingStatus}`,
          timestamp: new Date().toISOString(),
        });
        await sendProgressUpdate({ ...progress });
        continue;
      }

      // Process this row
      let logEntry;
      try {
        let result;
        if (useRecordedSteps) {
          result = await replayRowWithSteps(row, steps, listPageUrl);
        } else {
          result = await replayRowBuiltIn(row, listPageUrl);
        }

        if (result.success) {
          progress.processed++;
          logEntry = {
            rowIndex: pageIndex * rows.length + i,
            studentId,
            status: "processed",
            reason: `Downloaded ${result.downloaded || 0} document(s)`,
            timestamp: new Date().toISOString(),
          };
          console.log(`[Exxat:REPLAY]   ✅ PROCESSED — ${result.downloaded || 0} downloads`);
        } else {
          progress.failed++;
          logEntry = {
            rowIndex: pageIndex * rows.length + i,
            studentId,
            status: "failed",
            reason: result.reason || "Unknown failure",
            timestamp: new Date().toISOString(),
          };
          console.error(`[Exxat:REPLAY]   ❌ FAILED: ${result.reason}`);
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
        console.error(`[Exxat:REPLAY]   ❌ ERROR: ${err.message}`);

        // Try to get back to the list page after an error
        try {
          if (!window.location.href.includes("/assignments/list")) {
            window.history.back();
            await sleep(2000);
          }
        } catch (_) {}
      }

      await sendLogEntry(logEntry);
      await sendProgressUpdate({ ...progress });

      // Small pause between rows
      await sleep(500);
    }

    if (stopReplayRequested) break;

    // Try to go to next page
    const advanced = await clickNextPage();
    if (!advanced) {
      console.log("[Exxat:REPLAY] 🏁 No Next button — session complete");
      break;
    }
    pageIndex++;
    await sleep(1000);
  }

  mode = "IDLE";
  stopKeepalive();

  try {
    await chrome.runtime.sendMessage({ action: "REPLAY_COMPLETE" });
  } catch (_) {}

  console.log("[Exxat:REPLAY] 🏁 Session ended. Progress:", progress);
}

// ---------------------------------------------------------------------------
// Built-in Exxat engine: process one row without recorded steps
// ---------------------------------------------------------------------------

/**
 * Process a single student row using the built-in Exxat engine.
 * 1. Click the row link → navigate to detail page
 * 2. Download all available documents
 * 3. Navigate back to list page
 *
 * @param {Element} row
 * @param {string} listPageUrl
 * @returns {Promise<{ success: boolean, downloaded?: number, reason?: string }>}
 */
async function replayRowBuiltIn(row, listPageUrl) {
  const currentUrl = window.location.href;

  // Click to open the student detail page
  const clicked = clickRowToOpenDetail(row);
  if (!clicked) {
    return { success: false, reason: "Could not find a link to open the student detail page" };
  }

  // Wait for navigation to the detail page (/assignments/{id})
  try {
    await waitForNavigation(currentUrl, 10000);
    console.log("[Exxat:REPLAY] Navigated to:", window.location.href);
  } catch (err) {
    return { success: false, reason: "Navigation to detail page timed out" };
  }

  // Wait for the page to settle
  await sleep(1500);

  // Make sure we're on the Onboarding tab
  await ensureOnboardingTab();

  // Download all documents
  const { downloaded, total } = await downloadAllDocumentsOnDetailPage();

  // Navigate back to the list page
  await navigateBackToList(listPageUrl);

  return { success: true, downloaded };
}

/**
 * Ensures the "Onboarding" tab is active on the detail page.
 * Clicks it if it's not already selected.
 */
async function ensureOnboardingTab() {
  const tabs = Array.from(document.querySelectorAll('[role="tab"], .tab, [class*="Tab"]'));
  const onboardingTab = tabs.find((t) =>
    (t.textContent || "").trim().toLowerCase().includes("onboarding")
  );

  if (onboardingTab) {
    const isSelected =
      onboardingTab.getAttribute("aria-selected") === "true" ||
      onboardingTab.classList.contains("active") ||
      onboardingTab.classList.contains("selected");

    if (!isSelected) {
      console.log("[Exxat:DETAIL] Clicking Onboarding tab");
      onboardingTab.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      await sleep(800);
    }
  }
}

/**
 * Navigate back to the list page after processing a student.
 * From logs: breadcrumb link has text "Schedules and onboarding"
 * and class "link-text".
 * @param {string} listPageUrl
 */
async function navigateBackToList(listPageUrl) {
  console.log("[Exxat:REPLAY] Navigating back to list page");

  // Strategy 1: find the breadcrumb link by text "Schedules and onboarding"
  const allLinks = Array.from(document.querySelectorAll("a, [role='link']"));
  const breadcrumb = allLinks.find((el) => {
    const text = (el.textContent || "").trim().toLowerCase();
    return text.includes("schedules and onboarding") || text === "schedules";
  });

  if (breadcrumb) {
    console.log("[Exxat:REPLAY] Clicking breadcrumb:", breadcrumb.textContent.trim());
    breadcrumb.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await sleep(2000);
    try {
      await waitForElement("table tbody tr", 8000);
      console.log("[Exxat:REPLAY] Back on list page ✅");
      return;
    } catch (_) {}
  }

  // Strategy 2: look for any link with class "link-text" that goes to /assignments/list
  const listLink = allLinks.find((el) => {
    const href = el.getAttribute("href") || "";
    return href.includes("/assignments/list") || href.includes("/assignments");
  });

  if (listLink) {
    console.log("[Exxat:REPLAY] Clicking list link:", listLink.getAttribute("href"));
    listLink.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await sleep(2000);
    try {
      await waitForElement("table tbody tr", 8000);
      return;
    } catch (_) {}
  }

  // Strategy 3: browser back
  console.log("[Exxat:REPLAY] Using history.back()");
  window.history.back();
  await sleep(2500);
  try {
    await waitForElement("table tbody tr", 8000);
    console.log("[Exxat:REPLAY] Back on list page via history.back() ✅");
  } catch (_) {
    console.warn("[Exxat:REPLAY] Table did not appear after back navigation");
  }
}

// ---------------------------------------------------------------------------
// Recorded-steps replay: process one row using the user's recorded sequence
// ---------------------------------------------------------------------------

/**
 * Replay a row using the user's recorded step sequence.
 * The recording is expected to contain:
 *   - Steps to open the student detail (eye icon click)
 *   - Steps to click requirements and download
 *   - Steps to navigate back
 *
 * The engine auto-detects the repeating block (requirement click + download)
 * by finding the first selector that appears more than once.
 *
 * @param {Element} row
 * @param {Array<object>} steps
 * @param {string} listPageUrl
 * @returns {Promise<{ success: boolean, downloaded?: number, reason?: string }>}
 */
async function replayRowWithSteps(row, steps, listPageUrl) {
  const { preSteps, loopSteps, postSteps } = detectRepeatingBlock(steps);

  console.log(`[Exxat:REPLAY] Steps: pre=${preSteps.length} loop=${loopSteps.length} post=${postSteps.length}`);

  // Execute pre-loop steps (open detail page, etc.)
  for (const step of preSteps) {
    try {
      await executeStep(step);
    } catch (err) {
      return { success: false, reason: `Pre-step failed "${step.selector}": ${err.message}` };
    }
  }

  // Execute the repeating loop (click requirement → download)
  let downloaded = 0;
  if (loopSteps.length > 0) {
    const loopTriggerSelector = loopSteps[0].selector;
    let iteration = 0;

    while (true) {
      let elementPresent = false;
      try {
        await waitForElement(loopTriggerSelector, 1500);
        elementPresent = true;
      } catch (_) {}

      if (!elementPresent) {
        console.log(`[Exxat:REPLAY] Loop ended after ${iteration} iteration(s)`);
        break;
      }

      console.log(`[Exxat:REPLAY] Loop iteration ${iteration + 1}`);
      let broke = false;
      for (const step of loopSteps) {
        try {
          await executeStep(step);
          // Count clicks on elements that look like download buttons
          if (step.textContent && step.textContent.toLowerCase().includes("download")) {
            downloaded++;
          }
        } catch (_) {
          broke = true;
          break;
        }
      }
      if (broke) break;
      iteration++;
    }
  }

  // Execute post-loop steps (navigate back, etc.)
  for (const step of postSteps) {
    try {
      await executeStep(step);
    } catch (err) {
      return { success: false, reason: `Post-step failed "${step.selector}": ${err.message}` };
    }
  }

  return { success: true, downloaded };
}

// ---------------------------------------------------------------------------
// detectRepeatingBlock — auto-detect loop from duplicate selectors
// ---------------------------------------------------------------------------

/**
 * Splits a step array into pre/loop/post sections.
 * The loop is identified as the first block of steps whose first selector
 * appears more than once in the recording.
 *
 * @param {Array<object>} steps
 * @returns {{ preSteps: object[], loopSteps: object[], postSteps: object[] }}
 */
function detectRepeatingBlock(steps) {
  if (!steps || steps.length === 0) return { preSteps: [], loopSteps: [], postSteps: [] };

  // Manual override: if any step has isRepeating set, use that
  if (steps.some((s) => s.isRepeating)) {
    const first = steps.findIndex((s) => s.isRepeating);
    const last = steps.reduce((l, s, i) => (s.isRepeating ? i : l), -1);
    return {
      preSteps: steps.slice(0, first),
      loopSteps: steps.slice(first, last + 1),
      postSteps: steps.slice(last + 1),
    };
  }

  // Auto-detect: find first click selector that repeats
  const clickSteps = steps.map((s, i) => ({ ...s, _i: i })).filter((s) => s.type === "click");
  let loopStart = -1, loopLen = 0;

  for (let i = 0; i < clickSteps.length; i++) {
    const sel = clickSteps[i].selector;
    const next = clickSteps.findIndex((s, j) => j > i && s.selector === sel);
    if (next !== -1) {
      loopStart = clickSteps[i]._i;
      loopLen = clickSteps[next]._i - loopStart;
      break;
    }
  }

  if (loopStart === -1 || loopLen <= 0) {
    console.log("[Exxat:REPLAY] No repeating block — running all steps once");
    return { preSteps: steps, loopSteps: [], postSteps: [] };
  }

  const preSteps = steps.slice(0, loopStart);
  const loopSteps = steps.slice(loopStart, loopStart + loopLen);
  const postSteps = steps.slice(loopStart + loopLen);

  console.log(`[Exxat:REPLAY] Loop detected: pre=${preSteps.length} loop=${loopSteps.length} post=${postSteps.length}`);
  console.log("  Loop steps:", loopSteps.map((s) => `${s.type}:${s.selector}`));

  return { preSteps, loopSteps, postSteps };
}

// ---------------------------------------------------------------------------
// executeStep — execute a single recorded step
// ---------------------------------------------------------------------------

const STEP_RETRY_COUNT = 3;
const STEP_RETRY_DELAY_MS = 500;

async function executeStep(step) {
  console.log(`[Exxat:REPLAY] ▶ ${step.type} "${step.selector}" "${step.textContent}"`);

  if (step.type === "click") {
    let lastError;
    for (let attempt = 0; attempt <= STEP_RETRY_COUNT; attempt++) {
      try {
        const el = await waitForElement(step.selector);
        el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        console.log(`[Exxat:REPLAY]   ✅ Clicked`);
        return;
      } catch (err) {
        lastError = err;
        if (attempt < STEP_RETRY_COUNT) await sleep(STEP_RETRY_DELAY_MS);
      }
    }
    throw lastError;
  }

  if (step.type === "scroll") {
    const containerSelector = step.scrollContainer || step.selector;
    let container = window;
    if (containerSelector && containerSelector !== "window") {
      container = document.querySelector(containerSelector) || window;
    }
    const delta = step.scrollDirection === "up" ? -300 : 300;
    if (container === window) {
      window.scrollBy({ top: delta, behavior: "smooth" });
    } else {
      container.scrollBy({ top: delta, behavior: "smooth" });
    }
  }
}

// ---------------------------------------------------------------------------
// Message listener
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
      // Always use the built-in engine — recorded steps are too fragile
      // for this React app (dynamic selectors, SVG paths, row-specific class paths).
      // Also force-clear any stored steps so the popup doesn't gray out.
      sendResponse({ ok: true });
      runReplaySession([]).catch((err) => {
        console.error("[Exxat] runReplaySession error:", err);
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
      sendResponse({ ok: true });
      break;
  }
});
