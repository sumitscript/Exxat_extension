// Content Script — Exxat One Downloader Extension
// Injected into Exxat One pages. Handles recording and replay.
// Rebuilt to match the actual Exxat One workflow observed in screenshots.

console.warn("🔴🔴🔴 [Exxat Downloader] content.js Loaded on:", window.location.href);
console.warn("🔴🔴🔴 [Exxat Downloader] Mode state:", typeof chrome !== 'undefined' ? "chrome extension context ok" : "no chrome context");


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
 * Returns all visible student rows from the list page table.
 * ONLY works on the list page — returns empty array on detail pages.
 * @returns {Element[]}
 */
function getTableRows() {
  // Only run on the list page — detail page URL contains /assignments/{24-char-hex}
  if (/\/assignments\/[a-f0-9]{24}/.test(window.location.href)) {
    console.warn("[Exxat:ROWS] On detail page — getTableRows() returning empty");
    return [];
  }

  // Standard HTML table rows (the list page uses a <table>)
  const tableRows = Array.from(
    document.querySelectorAll("table tbody tr")
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

  console.warn("[Exxat:ROWS] No table rows found on list page");
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
  return "(unknown)";
}

/**
 * Extract Schedule ID (assumed to be a ~6-12 digit number in the row).
 * @param {Element} row
 * @returns {string|null}
 */
function extractScheduleId(row) {
  const cells = Array.from(row.querySelectorAll("td"));
  for (const cell of cells) {
    const text = cell.textContent.trim();
    if (/^\d{5,15}$/.test(text)) {
      return text;
    }
  }
  // Try finding anywhere in text if not isolated in a cell
  const match = row.textContent.match(/\b\d{5,15}\b/);
  return match ? match[0] : null;
}

/**
 * Extract clean student name.
 * @param {Element} row
 * @returns {string}
 */
function extractStudentName(row) {
  const cells = Array.from(row.querySelectorAll("td"));
  for (const cell of cells) {
    const text = cell.textContent.trim();
    if (text.includes("@")) {
      const parts = text.split("@")[0].split(/(?=[A-Z])/); // basic split or just take first part
      // Usually Exxat has name and email. We can just take the first 15 chars or so
      const name = text.split("@")[0].replace(/Flagged.*|prod_.*/i, '').trim();
      return name.replace(/[<>:"/\\|?*]+/g, '_').slice(0, 30) || "Unknown_Student";
    }
  }
  return "Unknown_Student";
}

/**
 * Extract the entire row text as a CSV line for the metadata file.
 * @param {Element} row
 * @returns {string}
 */
function extractRowAsCsvLine(row) {
  const cells = Array.from(row.querySelectorAll("td"));
  const rowData = cells.map(c => `"${c.textContent.trim().replace(/"/g, '""')}"`);
  return rowData.join(",");
}

// ---------------------------------------------------------------------------
// Exxat-specific: navigate into a student row
// ---------------------------------------------------------------------------

function simulateReactClick(element) {
  const clickEvent = new MouseEvent("click", {
    view: window,
    bubbles: true,
    cancelable: true,
    button: 0
  });
  element.dispatchEvent(clickEvent);
}

/**
 * From the logs: clicking the status cell link (a.flex.gap-2 or the row's
 * detail link) navigates to /assignments/{id}?tab=caas.
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
    simulateReactClick(detailLink);
    return true;
  }

  // Strategy 2: the status/name cell
  const statusLink = row.querySelector("a.flex, a[class*='flex']");
  if (statusLink) {
    console.log("[Exxat:NAV] Clicking flex link:", statusLink.textContent.trim().slice(0, 50));
    simulateReactClick(statusLink);
    return true;
  }

  // Strategy 3: click the onboarding status cell div
  const statusCell = row.querySelector("div.min-w-0.py-3, td div[class*='py-3']");
  if (statusCell) {
    console.log("[Exxat:NAV] Clicking status cell div");
    simulateReactClick(statusCell);
    return true;
  }

  // Strategy 4: click the row itself
  console.log("[Exxat:NAV] Clicking row directly");
  simulateReactClick(row);
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
  console.log("[Exxat:GROUP/DETAIL] Starting on", window.location.href);

  // 1. Give the right pane time to load
  await sleep(4000);

  // 2. Find all requirement rows in the main pane (NOT the Group Sidebar)
  const allListItems = Array.from(document.querySelectorAll("[role='listitem']"));
  const isGroupPage = window.location.href.includes("/assignments/group/");
  const groupSidebar = isGroupPage ? document.querySelector("div.w-60, div[class*='lg:w-[16rem]']") : null;
  
  const requirementRows = allListItems.filter(item => {
      if (groupSidebar && groupSidebar.contains(item)) {
          return false; // Skip if it's inside the Group Sidebar
      }
      if (!isGroupPage) {
          const sidebar = item.closest(".w-60");
          return !sidebar;
      }
      return true;
  });
  
  if (requirementRows.length === 0) {
      console.warn("[Exxat:GROUP/DETAIL] No requirement rows found on the right pane.");
      return { downloaded: 0, total: 0 };
  }

  let downloaded = 0;
  let total = 0;

  for (let i = 0; i < requirementRows.length; i++) {
      if (stopReplayRequested) break;
      
      const row = requirementRows[i];
      const rowText = row.textContent.trim().substring(0, 40).replace(/\n/g, ' ');
      console.log(`[Exxat:GROUP/DETAIL] Checking requirement: ${rowText}`);
      
      // Look for a download button immediately visible (just in case)
      let directDownload = row.querySelector("svg[data-icon='download'], svg.fa-download");
      if (directDownload) {
          console.log("[Exxat:GROUP/DETAIL]     Found direct download button! Clicking...");
          simulateReactClick(directDownload.closest("button") || directDownload);
          downloaded++;
          total++;
          await sleep(2000);
          continue;
      }
      
      // Otherwise, click the row to open the drawer
      console.log("[Exxat:GROUP/DETAIL]     Clicking row to open drawer...");
      const clickableRow = row.querySelector("button, a") || row;
      simulateReactClick(clickableRow);
      await sleep(3500); // Wait for drawer to slide out and load
      
      // Now look for download buttons anywhere on the page (usually in the active drawer)
      const svgs = Array.from(document.querySelectorAll("svg[data-icon='download'], svg.fa-download"));
      const downloadBtns = svgs.map(svg => svg.closest("button")).filter(b => b && !b.disabled);
      
      if (downloadBtns.length > 0) {
          // Assume the last button in the DOM is inside the active drawer
          const targetBtn = downloadBtns[downloadBtns.length - 1];
          console.log("[Exxat:GROUP/DETAIL]     Found download button in drawer! Clicking...");
          simulateReactClick(targetBtn);
          downloaded++;
          total++;
          await sleep(2500); // Wait for download to start
      } else {
          console.log("[Exxat:GROUP/DETAIL]     No download button found in drawer.");
      }
      
      // Close the drawer if there is a close button
      const closeBtns = Array.from(document.querySelectorAll("button[aria-label='Close'], button[aria-label='close' i], button svg.fa-times, .e-close"));
      if (closeBtns.length > 0) {
          const targetClose = closeBtns[closeBtns.length - 1];
          simulateReactClick(targetClose.closest("button") || targetClose);
          console.log("[Exxat:GROUP/DETAIL]     Drawer closed.");
          await sleep(1500); // Wait for drawer to close
      } else {
          // Fallback: press Escape
          document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
          console.log("[Exxat:GROUP/DETAIL]     Escape key sent to close drawer.");
          await sleep(1500);
      }
  }

  console.log(`[Exxat:GROUP/DETAIL] Done — ${downloaded}/${total} downloaded`);
  return { downloaded, total };
}

// (Removed obsolete getRequirementItems and findDownloadButton logic)

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
  await sleep(3500); // Increased for safety
  try {
    await waitForElement("table tbody tr", 15000);
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
 * NOTE: The engine does NOT use recorded steps — it drives the UI directly based on
 * the known page structure (which is far more robust against React's dynamic DOM
 * and changing row IDs). It inherently handles looping across all rows and requirements.
 *
 * @returns {Promise<void>}
 */
async function runReplaySession(customSteps = null) {
  stopReplayRequested = false;
  mode = "REPLAYING";
  startKeepalive();

  const currentUrl = window.location.href;
  console.log(`[Exxat:REPLAY] 🚀 Session STARTED on: ${currentUrl}`);

  // GUARD: Must be started from the list page.
  // The list page URL contains "/assignments/list".
  // If started from a detail page (/assignments/{id}), refuse and tell the user.
  if (!currentUrl.includes("/assignments/list")) {
    console.error("[Exxat:REPLAY] ❌ Not on the list page. Please navigate to the Schedules List page first.");
    mode = "IDLE";
    stopKeepalive();
    try {
      await chrome.runtime.sendMessage({
        action: "SESSION_INTERRUPTED",
        reason: "Please navigate to the Schedules List page (/assignments/list) before starting replay."
      });
    } catch (_) {}
    return;
  }

  const listPageUrl = currentUrl;
  const progress = { processed: 0, skipped: 0, failed: 0, total: 0 };
  let pageIndex = 0;

  // Load target template list and processing history from storage
  let targetScheduleIds = [];
  let processedHistory = [];
  try {
    const data = await new Promise(r => chrome.storage.local.get(["targetScheduleIds", "processedHistory"], r));
    targetScheduleIds = data.targetScheduleIds || [];
    processedHistory = data.processedHistory || [];
  } catch (_) {}

  const targetSet = new Set(targetScheduleIds.map(String));
  const historySet = new Set(processedHistory.map(item => typeof item === "string" ? item : String(item.scheduleId || item.id)));

  console.log(`[Exxat:REPLAY] Target Set size: ${targetSet.size}, History size: ${historySet.size}`);

  while (true) {
    if (stopReplayRequested) break;

    // Verify we're still on the list page before reading rows
    if (!window.location.href.includes("/assignments/list")) {
      console.warn("[Exxat:REPLAY] Drifted off list page — navigating back");
      window.history.back();
      await sleep(2500);
      try { await waitForElement("table tbody tr", 8000); } catch (_) {}
    }

    const initialRows = getTableRows();
    console.log(`[Exxat:REPLAY] 📄 Page ${pageIndex + 1}: ${initialRows.length} rows`);

    if (initialRows.length === 0) {
      console.warn("[Exxat:REPLAY] No rows found — ending session");
      break;
    }

    progress.total += initialRows.length;
    await sendProgressUpdate({ ...progress });

    for (let i = 0; i < initialRows.length; i++) {
      if (stopReplayRequested) break;

      // RE-QUERY the DOM to get the fresh element!
      const currentRows = getTableRows();
      if (i >= currentRows.length) {
         console.warn("[Exxat:REPLAY] Table rows shrank unexpectedly. Moving to next page.");
         break;
      }
      
      const row = currentRows[i];
      const studentId = extractStudentId(row);
      const scheduleId = extractScheduleId(row);
      const studentName = extractStudentName(row);
      const onboardingStatus = getOnboardingStatus(row);
      
      console.log(`[Exxat:REPLAY] Row ${i + 1}/${initialRows.length}: "${studentId}" ID="${scheduleId}" status="${onboardingStatus}"`);

      // 1. Target Template Filter
      let isExplicitlyTargeted = false;
      if (targetSet.size > 0 && scheduleId) {
        if (!targetSet.has(String(scheduleId))) {
          console.log(`[Exxat:REPLAY]   ⏭ SKIPPING (Schedule ID ${scheduleId} not in target template)`);
          progress.skipped++;
          await sendProgressUpdate({ ...progress });
          continue;
        } else {
          isExplicitlyTargeted = true;
        }
      }

      // 2. Duplicate Prevention
      if (scheduleId && historySet.has(String(scheduleId))) {
        console.log(`[Exxat:REPLAY]   ⏭ SKIPPING (Schedule ID ${scheduleId} already downloaded previously)`);
        progress.skipped++;
        await sendLogEntry({
          rowIndex: pageIndex * initialRows.length + i, studentId, scheduleId,
          status: "SKIPPED", reason: `Already downloaded previously`,
          timestamp: new Date().toISOString(),
        });
        await sendProgressUpdate({ ...progress });
        continue;
      }

      // 3. Skip Status Filter (Bypass if explicitly targeted)
      if (!isExplicitlyTargeted && SKIP_STATUSES.includes(onboardingStatus.toLowerCase())) {
        console.log(`[Exxat:REPLAY]   ⏭ SKIPPING (${onboardingStatus})`);
        progress.skipped++;
        await sendLogEntry({
          rowIndex: pageIndex * initialRows.length + i, studentId, scheduleId,
          status: "SKIPPED", reason: `Onboarding Status: ${onboardingStatus}`,
          timestamp: new Date().toISOString(),
        });
        await sendProgressUpdate({ ...progress });
        continue;
      }

      let logEntry;
      const startTime = Date.now();
      try {
        // Set the Subfolder for downloads in the Background Worker
        const folderName = `Exxat_Downloads/${scheduleId || 'UnknownID'}`;
        await chrome.runtime.sendMessage({ action: "SET_DOWNLOAD_FOLDER", folder: folderName });

        // Download the Metadata file directly using a blob
        try {
          const csvLine = extractRowAsCsvLine(row);
          const blob = new Blob([csvLine], { type: "text/csv" });
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = `student_metadata.csv`; // The background worker will prepend the folder!
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
          await sleep(500);
        } catch(e) {
          console.warn("[Exxat:REPLAY] Failed to download metadata CSV", e);
        }

        let result;
        if (customSteps && customSteps.length > 0) {
          result = await replayRowWithSteps(row, customSteps, listPageUrl);
        } else {
          result = await replayRowBuiltIn(row, listPageUrl);
        }

        if (result.success) {
          progress.processed++;
          logEntry = {
            rowIndex: pageIndex * initialRows.length + i, studentId, scheduleId,
            status: "SUCCESS", reason: `Downloaded ${result.downloaded || 0} document(s)`,
            timestamp: new Date().toISOString(),
          };
          console.log(`[Exxat:REPLAY]   ✅ PROCESSED — ${result.downloaded || 0} downloads`);
          
          // Save to persistent history to prevent duplicates
          if (scheduleId) {
            historySet.add(String(scheduleId));
            const exists = processedHistory.some(item => 
              (typeof item === "string" ? item : String(item.scheduleId || item.id)) === String(scheduleId)
            );
            if (!exists) {
              processedHistory.push({
                scheduleId: String(scheduleId),
                studentName: studentName || "Unknown",
                timestamp: new Date().toISOString()
              });
              await chrome.storage.local.set({ processedHistory });
            }
          }

        } else {
          progress.failed++;
          logEntry = {
            rowIndex: pageIndex * initialRows.length + i, studentId, scheduleId,
            status: "FAILED", reason: result.reason || "Unknown failure",
            timestamp: new Date().toISOString(),
          };
          console.error(`[Exxat:REPLAY]   ❌ FAILED: ${result.reason}`);
        }
      } catch (err) {
        console.error("[Exxat:REPLAY] Error processing row:", err);
        progress.failed++;
        logEntry = {
          rowIndex: pageIndex * initialRows.length + i, studentId, scheduleId,
          status: "FAILED", reason: err.message,
          timestamp: new Date().toISOString(),
        };
        console.error(`[Exxat:REPLAY]   ❌ ERROR: ${err.message}`);
        // Try to recover back to list page
        if (!window.location.href.includes("/assignments/list")) {
          window.history.back();
          await sleep(2500);
          try { await waitForElement("table tbody tr", 6000); } catch (_) {}
        }
      }

      await sendLogEntry(logEntry);
      await sendProgressUpdate({ ...progress });
      // Wait for React to fully hydrate the list page before clicking the next row.
      // If we click too early, the <a> tag won't have its SPA onClick handler yet,
      // which causes a full page reload and breaks the script.
      await sleep(5000);
    }

    if (stopReplayRequested) break;

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
  try { await chrome.runtime.sendMessage({ action: "REPLAY_COMPLETE" }); } catch (_) {}
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

  const clicked = clickRowToOpenDetail(row);
  if (!clicked) {
    return { success: false, reason: "Could not find a link to open the student detail page" };
  }

  // Wait for navigation to the detail page
  try {
    await waitForNavigation(currentUrl, 15000);
    console.log("[Exxat:REPLAY] Navigated to:", window.location.href);
  } catch (err) {
    return { success: false, reason: "Navigation to detail page timed out" };
  }

  // Wait for the page to fully load (React data fetch completes)
  // The app logs show: [OnboardingContainer] runFetch COMMIT — we wait for that
  // by waiting for the requirement rows to appear
  await sleep(1000);

  // Download all documents using the left-side ↓ buttons
  const { downloaded, total } = await downloadAllDocumentsOnDetailPage();

  // Navigate back using the breadcrumb
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
  console.log("[Exxat:GROUP/REPLAY] Navigating back to list page");

  // Approach 1: Click the "Schedules and onboarding" breadcrumb link using TreeWalker
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
  let breadcrumb = null;
  let node;
  while (node = walker.nextNode()) {
    if (node.nodeValue.trim().toLowerCase() === "schedules and onboarding") {
      breadcrumb = node.parentElement;
      break;
    }
  }

  if (breadcrumb) {
    console.log("[Exxat:GROUP/REPLAY] Clicking breadcrumb: Schedules and onboarding");
    const clickable = breadcrumb.closest("a, button, [role='button']") || breadcrumb;
    const beforeUrl = window.location.href;
    simulateReactClick(clickable);
    try {
      await waitForNavigation(beforeUrl, 15000);
      await waitForElement("table tbody tr", 15000);
      console.log("[Exxat:GROUP/REPLAY] Back on list page ✅");
      return;
    } catch (_) {
      console.warn("[Exxat:GROUP/REPLAY] Breadcrumb click did not navigate — trying history.back()");
    }
  }

  // Fallback: history.back() — safe for React SPA, no full reload
  console.log("[Exxat:GROUP/REPLAY] Using history.back()");
  const beforeUrl = window.location.href;
  window.history.back();
  try {
    await waitForNavigation(beforeUrl, 8000);
    
    // Force React to reload the list table by clicking the "Group" tab if it exists
    await sleep(2500); 
    const activeTab = document.querySelector(".e-toolbar-item.e-active button, [role='tab'][aria-selected='true'], a[href*='tab=Group']");
    if (activeTab) {
      console.log("[Exxat:GROUP/REPLAY] Clicking active tab to force data refresh");
      simulateReactClick(activeTab);
    }

    await waitForElement("table tbody tr.e-row", 8000);
    console.log("[Exxat:GROUP/REPLAY] Back on list page ✅");
  } catch (_) {
    console.warn("[Exxat:GROUP/REPLAY] Could not confirm return to list page — continuing anyway");
    await sleep(2000);
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
// Group Engine
// ---------------------------------------------------------------------------

async function runGroupReplaySession() {
  stopReplayRequested = false;
  mode = "REPLAYING";
  startKeepalive();

  const currentUrl = window.location.href;
  console.log(`[Exxat:GROUP] 🚀 Session STARTED on: ${currentUrl} (Extension v${chrome.runtime.getManifest().version})`);

  if (!currentUrl.includes("/assignments/list")) {
    console.error("[Exxat:GROUP] ❌ Not on the list page.");
    mode = "IDLE";
    stopKeepalive();
    try { await chrome.runtime.sendMessage({ action: "SESSION_INTERRUPTED", reason: "Please navigate to the Schedules List page." }); } catch (_) {}
    return;
  }

  const listPageUrl = currentUrl;
  const progress = { processed: 0, skipped: 0, failed: 0, total: 0 };
  let pageIndex = 0;

  // Load target template list and processing history from storage
  let targetScheduleIds = [];
  let processedHistory = [];
  try {
    const data = await new Promise(r => chrome.storage.local.get(["targetScheduleIds", "processedHistory"], r));
    targetScheduleIds = data.targetScheduleIds || [];
    processedHistory = data.processedHistory || [];
  } catch (_) {}

  const targetSet = new Set(targetScheduleIds.map(String));
  const historySet = new Set(processedHistory.map(item => typeof item === "string" ? item : String(item.scheduleId || item.id)));

  while (true) {
    if (stopReplayRequested) break;
    if (!window.location.href.includes("/assignments/list")) {
      window.history.back();
      await sleep(2500);
      continue;
    }

    // Determine how many parent group rows there are
    let parentRows = Array.from(document.querySelectorAll("tr.e-row:not(.e-hiddenrow):not(.e-detailrow)")).filter(r => !r.closest('.e-detailrow'));
    if (parentRows.length === 0) {
      console.log("[Exxat:GROUP] No group rows found. Waiting 5s...");
      await sleep(5000);
      parentRows = Array.from(document.querySelectorAll("tr.e-row:not(.e-hiddenrow):not(.e-detailrow)")).filter(r => !r.closest('.e-detailrow'));
      if (parentRows.length === 0) {
        break; // No rows at all
      }
    }

    progress.total = parentRows.length * 2; // Rough estimate
    await sendProgressUpdate({ ...progress });

    for (let i = 0; i < parentRows.length; i++) {
      if (stopReplayRequested) break;

      // Re-fetch parent row in case DOM changed
      const currentParentRows = Array.from(document.querySelectorAll("tr.e-row:not(.e-hiddenrow):not(.e-detailrow)")).filter(r => !r.closest('.e-detailrow'));
      if (i >= currentParentRows.length) break;
      const parentRow = currentParentRows[i];

      const groupName = parentRow.querySelector("td[aria-colindex='1']")?.textContent?.trim() || 
                        parentRow.querySelector("td[aria-colindex='2']")?.textContent?.trim() || `Group_${i+1}`;
      console.log(`[Exxat:GROUP] Processing Group: ${groupName}`);

      // Find expand icon
      const expandIcon = parentRow.querySelector(".e-detailrowexpand, .e-detailrowcollapse");
      if (!expandIcon) {
        console.warn(`[Exxat:GROUP] No expand icon found for Group ${groupName}`);
        continue;
      }

      // Expand if collapsed
      if (expandIcon.classList.contains("e-detailrowcollapse")) {
        expandIcon.click();
        await sleep(3500); // Wait for inner grid to render
      } else {
        await sleep(500);
      }

      // Now it's expanded. The detail row is usually nextElementSibling
      const detailRow = parentRow.nextElementSibling;
      if (!detailRow || !detailRow.classList.contains("e-detailrow")) {
         console.warn(`[Exxat:GROUP] Could not locate detail row for Group ${groupName}`);
         continue;
      }

      const innerRows = Array.from(detailRow.querySelectorAll("tr.e-row:not(.e-hiddenrow)"));
      console.log(`[Exxat:GROUP] Group ${groupName} has ${innerRows.length} slots/students`);

      if (innerRows.length === 0) {
          console.warn(`[Exxat:GROUP] No rows found inside group ${groupName}`);
          continue;
      }

      // 1. Navigate to the Group Detail Page by clicking the first valid link in the nested grid
      let entered = false;
      for (const row of innerRows) {
          const clicked = clickRowToOpenDetail(row);
          if (clicked) {
              entered = true;
              break;
          }
      }

      if (!entered) {
          console.warn(`[Exxat:GROUP] Could not find a link to enter group detail page for ${groupName}`);
          continue;
      }

      try {
          await waitForNavigation(currentUrl, 15000);
      } catch (err) { 
          console.error("[Exxat:GROUP] Failed to navigate to group detail");
          continue;
      }

      // Wait for the detail page sidebar to fully load (can take time due to massive API fetches)
      let initialBtnsFound = false;
      for (let w = 0; w < 30; w++) {
          await sleep(1000);
          const btns = document.querySelectorAll("div.w-60 [role='listitem'] button, div.w-60 [role='listitem'] a, .bg-card [role='listitem'] button, .bg-card [role='listitem'] a");
          if (btns.length > 0) {
              await sleep(2500); // Give it an extra moment to fully stabilize
              initialBtnsFound = true;
              break;
          }
      }

      if (!initialBtnsFound) {
          console.warn(`[Exxat:GROUP] Timed out waiting for left sidebar to load for Group ${groupName}.`);
      } else {
          console.log(`[Exxat:GROUP] Sidebar loaded for Group ${groupName}. Processing all entities via scrolling...`);
      }
      
      const processedNames = new Set();
      let scrollContainer = document.querySelector("div.w-60 [role='list'], .bg-card [role='list'], div.flex-1.overflow-y-auto");
      
      console.log(`[Exxat:GROUP] --- PHASE 1: SCROLLING DOWN ---`);
      let direction = "down";
      
      while (true) {
          if (stopReplayRequested) break;
          
          // Restrict to descendants of the left sidebar container (w-60)
          const groupSidebar = document.querySelector("div.w-60, div[class*='lg:w-[16rem]']");
          const currentItems = groupSidebar 
              ? Array.from(groupSidebar.querySelectorAll("[role='listitem']"))
              : Array.from(document.querySelectorAll("div.w-60 [role='listitem'], div[class*='lg:w-[16rem]'] [role='listitem']"));
          
          for (const item of currentItems) {
              if (stopReplayRequested) break;
              
              const entityNameText = item.textContent.trim().replace(/\n/g, ' ');
              if (!entityNameText) continue; // Skip empty spacers
              
              const entityName = entityNameText.substring(0, 100);
              
              if (!processedNames.has(entityName)) {
                  processedNames.add(entityName);
                  
                  console.log(`[Exxat:GROUP] Processing Sidebar Entity: ${entityName}`);
                  
                  const uid = `${groupName}_${entityName}`;
                  if (historySet.has(uid)) {
                      console.log(`[Exxat:GROUP]     ⏭ SKIPPING (Entity already in download history)`);
                      continue; // Skip without clicking or waiting!
                  }

                  // Determine active state by checking inner active elements
                  const innerActive = item.querySelector("[aria-current='true'], [aria-current='page']");
                  const isActive = !!innerActive || item.getAttribute("aria-current") === "true" || item.getAttribute("aria-current") === "page";
                  
                  if (!isActive) {
                      console.log(`[Exxat:GROUP]     Clicking entity box and waiting 6s for data to fetch...`);
                      
                      // Click the button or anchor tag inside the listitem if present, otherwise fall back to the wrapper div
                      let clickable = item.querySelector("button, a") || item;
                      simulateReactClick(clickable);
                      await sleep(6000); // Wait for the new content to fetch
                  } else {
                      console.log(`[Exxat:GROUP]     Entity is already active.`);
                  }
                  
                  try {
                      const result = await downloadAllDocumentsOnDetailPage();
                      progress.processed++;
                      
                      historySet.add(uid);
                      processedHistory.push({
                          scheduleId: String(uid),
                          studentName: entityName,
                          timestamp: new Date().toISOString(),
                          groupName: groupName
                      });
                      await chrome.storage.local.set({ processedHistory });
                      
                      await sendLogEntry({
                         rowIndex: processedNames.size, studentId: entityName, scheduleId: uid,
                         status: "SUCCESS", reason: `Downloaded ${result.downloaded} files`,
                         timestamp: new Date().toISOString(),
                      });
                      await sendProgressUpdate({ ...progress });
                  } catch (e) {
                      progress.failed++;
                      console.error("[Exxat:GROUP] Failed to download for entity", e);
                  }
              }
          }
          
          if (scrollContainer) {
              const oldScroll = scrollContainer.scrollTop;
              if (direction === "down") {
                  scrollContainer.scrollTop += 400; // Scroll down
                  await sleep(1500); // Wait for DOM to update
                  
                  if (scrollContainer.scrollTop === oldScroll) {
                      console.log("[Exxat:GROUP] ⬇️ Reached Bottom. Reversing direction to scroll UP...");
                      direction = "up";
                  }
              } else {
                  scrollContainer.scrollTop -= 400; // Scroll up
                  await sleep(1500); // Wait for DOM to update
                  
                  if (scrollContainer.scrollTop === oldScroll || scrollContainer.scrollTop === 0) {
                      console.log("[Exxat:GROUP] ⬆️ Reached Top. Sidebar traversal complete.");
                      break;
                  }
              }
          } else {
              console.log("[Exxat:GROUP] No scroll container found, traversal complete.");
              break; // No scroll container, can't scroll at all
          }
      }

      // 3. Navigate back to List Page
      await navigateBackToList(listPageUrl);

      // Wait for list page to re-render
      let retryCount = 0;
      while (retryCount < 40) {
          const checkRows = Array.from(document.querySelectorAll("tr.e-row:not(.e-hiddenrow):not(.e-detailrow)")).filter(r => !r.closest('.e-detailrow'));
          if (checkRows.length > 0) {
              await sleep(2000); // extra buffer for react to finish painting
              break;
          }
          await sleep(1000);
          retryCount++;
      }
    }

    // Next page logic
    const nextBtn = document.querySelector(".e-next:not(.e-disabled), .e-nextpage:not(.e-disabled)");
    if (!nextBtn || stopReplayRequested) {
      console.log("[Exxat:GROUP] No more pages or stopped.");
      break;
    }
    console.log(`[Exxat:GROUP] Moving to page ${pageIndex + 2}`);
    nextBtn.click();
    pageIndex++;
    await sleep(3500); // WAIT FOR NEXT PAGE TO LOAD
  }

  console.log("[Exxat:GROUP] ✅ Session Finished!");
  mode = "IDLE";
  stopKeepalive();
  try { await chrome.runtime.sendMessage({ action: "REPLAY_COMPLETE" }); } catch (_) {}
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
      // Always use the built-in engine for Start Auto-Engine
      sendResponse({ ok: true });
      runReplaySession().catch((err) => {
        console.error("[Exxat] runReplaySession error:", err);
        chrome.runtime.sendMessage({ action: "REPLAY_COMPLETE" }).catch(() => {});
      });
      break;
    }

    case "START_GROUP_REPLAY": {
      sendResponse({ ok: true });
      runGroupReplaySession().catch((err) => {
        console.error("[Exxat] runGroupReplaySession error:", err);
        chrome.runtime.sendMessage({ action: "REPLAY_COMPLETE" }).catch(() => {});
      });
      break;
    }
    case "EXECUTE_RECORDED": {
      // Use the macro execution engine for recorded steps
      sendResponse({ ok: true });
      runReplaySession(message.steps).catch((err) => {
        console.error("[Exxat] runMacroReplaySession error:", err);
        chrome.runtime.sendMessage({ action: "REPLAY_COMPLETE" }).catch(() => {});
      });
      break;
    }

    case "STOP_REPLAY":
      stopReplayRequested = true;
      mode = "IDLE";
      sendResponse({ ok: true });
      break;

    case "GET_CURRENT_MANUAL_PATH": {
      const folder3 = detectCandidateName();
      const folderPath = `Exxat_Downloads/${folder3}`.replace(/\/+/g, '/');
      console.warn(`[Exxat:MANUAL] Dynamic path request GET_CURRENT_MANUAL_PATH resolved to: "${folderPath}"`);
      sendResponse({ folderPath });
      break;
    }

    default:
      sendResponse({ ok: true });
      break;
  }
});

// ---------------------------------------------------------------------------
// Hidden Manual Download / Folder Bifurcation Logic (Content Script)
// ---------------------------------------------------------------------------

let cachedGroups = {}; // maps groupId -> { displayId, groupName }

function isExxatPage() {
  const url = window.location.href.toLowerCase();
  if (url.includes("exxat") || url.includes("steepgraph")) return true;
  if (document.title.toLowerCase().includes("exxat")) return true;
  if (document.querySelector("[class*='e-grid'], [class*='e-control'], .e-row")) return true;
  
  const bodyText = document.body ? document.body.textContent.toLowerCase() : "";
  if (bodyText.includes("onboarding") && bodyText.includes("schedule")) return true;
  
  return false;
}

function cleanName(text) {
  if (!text) return "";
  
  // Remove email suffix if present
  let cleaned = text.split("@")[0].trim();
  
  // Remove common status words if they leaked in
  const statusRegex = /\b(compliant|pending|not started|draft|in progress|action needed|some action needed|approved|rejected|under review|confirmed|flagged|prod_)\b/gi;
  cleaned = cleaned.replace(statusRegex, "");
  
  // Remove standalone initials or number badges (like GG, CC, CID, CIDI, F, c, St, 0, 1)
  // Let's remove any words that are fully uppercase or single letters or numbers, if there are other words
  const words = cleaned.split(/\s+/);
  if (words.length > 1) {
    const cleanWords = words.filter(word => {
      if (/^\d+$/.test(word)) return false; // number
      if (/^[A-Z]{1,4}$/.test(word)) return false; // uppercase initials
      if (word.length === 1) return false; // single letter
      return true;
    });
    if (cleanWords.length > 0) {
      cleaned = cleanWords.join(" ");
    }
  }

  // Replace special characters invalid for folders
  cleaned = cleaned.replace(/[<>:"/\\|?*]+/g, '_')
                   .replace(/\s+/g, ' ')
                   .trim();
                   
  return cleaned;
}

function extractCleanText(item) {
  if (!item) return "";
  
  // If the item has child elements, try to find the specific main text container first
  const nameEl = item.querySelector('.font-medium, .font-semibold, [class*="name" i], [class*="title" i], [class*="label" i], .e-anchor, a');
  if (nameEl) {
    const text = nameEl.textContent.trim();
    if (text && text.length > 1) {
      return text;
    }
  }
  
  // Otherwise, clone and strip noise
  const clone = item.cloneNode(true);
  const noiseSelectors = [
    'svg', 'i', '.avatar', '.initials', '.badge', '.status', '.count', '.number',
    '[class*="avatar" i]', '[class*="badge" i]', '[class*="status" i]', '[class*="count" i]',
    '[class*="icon" i]', 'button', '.e-checkbox-wrapper'
  ];
  
  for (const sel of noiseSelectors) {
    const elements = clone.querySelectorAll(sel);
    for (const el of elements) {
      el.remove();
    }
  }
  
  return clone.textContent.trim();
}

function getGroupIdFromUrl() {
  const currentUrl = window.location.href;
  const urlMatch = currentUrl.match(/\/assignments\/group\/([a-f0-9]{24}|\d+)/i) ||
                   currentUrl.match(/\/assignments\/group\/([^/]+)/i);
  return urlMatch ? urlMatch[1] : null;
}

function getGroupPlacementInfo() {
  const currentUrl = window.location.href;
  const displayId = getGroupIdFromUrl() || "UnknownID";
  
  if (cachedGroups[displayId]) {
    return cachedGroups[displayId];
  }
  
  let groupName = "";
  
  // 1. Breadcrumbs check (extremely reliable for group name)
  const breadcrumb = document.querySelector('.e-breadcrumb, [class*="breadcrumb" i]');
  if (breadcrumb) {
    const items = breadcrumb.querySelectorAll('li, a, span');
    if (items.length > 0) {
      const text = items[items.length - 1].textContent.trim();
      if (text && text.length > 2 && text.length < 100 && !/group|placement|assignment/i.test(text)) {
        groupName = cleanName(text);
      }
    }
  }

  // 2. Scan page headers, excluding candidate list sidebar and details pane
  if (!groupName) {
    const headers = document.querySelectorAll('h1, h2, h3, .font-bold, .font-semibold, [class*="title" i], [class*="header" i]');
    for (const el of headers) {
      if (el.closest('div.w-60') || el.closest("div[class*='lg:w-[16rem]']") || el.closest('.bg-card') || el.closest('#detail-pane') || el.closest('main')) {
        continue;
      }
      
      const text = el.textContent.trim();
      if (!text || text.length > 150 || text.includes("\n")) continue;

      const numMatch = text.match(/\b\d{4,15}\b/);
      if (numMatch) {
        groupName = text.replace(numMatch[0], '')
                        .replace(/^[-\s(),:|]+|[-\s(),:|]+$/g, '')
                        .trim();
        groupName = cleanName(groupName);
        break;
      } else if (text.length > 5 && !/requirements|onboarding|schedules/i.test(text)) {
        groupName = cleanName(text);
      }
    }
  }

  // 3. Fallback to Document Title
  if (!groupName) {
    const docTitle = document.title.split("|")[0].split("-")[0].trim();
    if (docTitle && !/exxat/i.test(docTitle)) {
      groupName = cleanName(docTitle);
    } else {
      groupName = "GroupPlacement";
    }
  }

  groupName = groupName || "Group";
  groupName = groupName.replace(/[<>:"/\\|?*]+/g, '_').substring(0, 50).trim();

  cachedGroups[displayId] = { displayId, groupName };
  console.warn(`[Exxat:MANUAL] getGroupPlacementInfo detected: DisplayID=${displayId}, GroupName=${groupName}`);
  return cachedGroups[displayId];
}

function detectCategory() {
  // Strategy 1: Active toolbar items or tabs, excluding candidate list/sidebar
  const activeElements = document.querySelectorAll(
    '.e-toolbar-item.e-active button, [role="tab"][aria-selected="true"], .tab.active, [class*="tab" i][class*="active" i], [class*="active" i], .selected'
  );
  
  for (const el of activeElements) {
    if (el.closest('div.w-60') || el.closest("div[class*='lg:w-[16rem]']") || el.closest('.bg-card')) {
      continue;
    }
    const text = extractCleanText(el);
    if (text.length > 2 && text.length < 50 && !/close|next|prev|cancel|save|edit|delete|download/i.test(text)) {
      const cleaned = cleanName(text);
      console.warn(`[Exxat:MANUAL] detectCategory: Matched active tab element: "${text}" -> "${cleaned}"`);
      return cleaned;
    }
  }

  // Strategy 2: Sidebar categories (if separate from candidate list)
  const activeSidebarItem = document.querySelector(
    'div.w-60 [aria-current="true"], div.w-60 [aria-current="page"], div.w-60 .active, div.w-60 .selected, [class*="sidebar" i] [class*="active" i]'
  );
  if (activeSidebarItem) {
    const text = extractCleanText(activeSidebarItem);
    if (text && text.length < 50 && /requirement|document|schedule/i.test(text)) {
      const cleaned = cleanName(text);
      console.warn(`[Exxat:MANUAL] detectCategory: Matched active sidebar category: "${text}" -> "${cleaned}"`);
      return cleaned;
    }
  }

  // Strategy 3: Main page header containing requirement keywords
  const headers = document.querySelectorAll('h1, h2, h3, h4, h5, .font-bold, .font-semibold');
  for (const el of headers) {
    if (el.closest('div.w-60') || el.closest("div[class*='lg:w-[16rem]']") || el.closest('.bg-card')) {
      continue;
    }
    const text = el.textContent.trim();
    if (text && text.length < 50 && /requirement|instructor|faculty|coordinator|student|school|preceptor/i.test(text)) {
      const cleaned = cleanName(text);
      console.warn(`[Exxat:MANUAL] detectCategory: Matched header keyword: "${text}" -> "${cleaned}"`);
      return cleaned;
    }
  }

  console.warn("[Exxat:MANUAL] detectCategory: Defaulting to General Requirements");
  return "General Requirements";
}

let lastDetectedCandidate = "General Candidates";
let lastDetectedGroup = "General Group";

function cleanName(raw) {
  if (!raw) return "";
  return raw.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/[<>:"/\\|?*]+/g, '');
}

function detectGroupName() {
  // Try to find the group name heading provided by user HTML
  const groupHeading = document.querySelector('span[role="heading"][aria-level="2"]');
  if (groupHeading && groupHeading.textContent) {
    return cleanName(groupHeading.textContent);
  }
  
  // Fallback to older class
  const oldGroup = document.querySelector(".group-name");
  if (oldGroup && oldGroup.textContent) {
     return cleanName(oldGroup.textContent);
  }

  return "General Group";
}

function detectCandidateNameFromDOM() {
  // Try to find the active student/faculty in the list
  // The active one typically has a different border or background class in Exxat (e.g. border-l-primary-600)
  // Let's look for all select-able candidate rows
  const rows = document.querySelectorAll('div[aria-label^="Select student"], div[aria-label^="Select faculty"], div[aria-label^="Select "]');
  
  for (const row of rows) {
    // Check if this row is visually active. Exxat often uses border-l-primary-xxx or bg-primary-xxx for active items
    if (row.className.includes('border-l-primary') || row.className.includes('bg-primary-50') || row.getAttribute('aria-current') === 'true') {
      const link = row.querySelector('a.link-text');
      if (link && link.textContent) {
        return cleanName(link.textContent);
      }
      // Fallback: extract from aria-label
      const aria = row.getAttribute('aria-label');
      if (aria) {
         return cleanName(aria.replace(/Select (student|faculty) /i, ''));
      }
    }
  }

  // Fallback to general DOM scanning if aria-labels aren't found
  const badWords = /^(students?|faculty|coordinators?|school|requirements?|documents?|status|onboarding|history|details|schedule|submission|group|placement|assignments|dashboard|home|reports|help|logout|profile|general candidates)$/i;
  
  const activeItems = document.querySelectorAll(".e-active, .e-selected, [aria-current='true'], [aria-current='page'], [aria-selected='true'], tr.e-active, tr.e-selected, .active");
  for (const item of activeItems) {
    const link = item.querySelector('a.link-text');
    if (link && link.textContent) {
       const cleaned = cleanName(link.textContent);
       if (cleaned && !badWords.test(cleaned)) return cleaned;
    }
  }

  return null;
}

document.addEventListener('click', (e) => {
  const candidateRow = e.target.closest('div[aria-label^="Select student"], div[aria-label^="Select faculty"], div[aria-label^="Select "]');
  if (candidateRow) {
    const link = candidateRow.querySelector('a.link-text');
    if (link && link.textContent) {
      lastDetectedCandidate = cleanName(link.textContent);
    } else {
      const aria = candidateRow.getAttribute('aria-label');
      if (aria) {
        lastDetectedCandidate = cleanName(aria.replace(/Select (student|faculty) /i, ''));
      }
    }
  }
}, true);

let lastDetectedRequirement = "General Requirement";

async function updateManualDownloadFolder(clickedElement = null) {
  chrome.storage.local.get(["manualDownloadMode"], (res) => {
    if (!res.manualDownloadMode) return;
    
    lastDetectedGroup = detectGroupName();
    
    const domCandidate = detectCandidateNameFromDOM();
    if (domCandidate) {
      lastDetectedCandidate = domCandidate;
    }
    
    if (clickedElement) {
       const req = detectRequirementName(clickedElement);
       if (req !== "General Requirement") {
          lastDetectedRequirement = req;
       }
    }
    
    const safeCandidate = lastDetectedCandidate && lastDetectedCandidate !== "General Candidates" ? lastDetectedCandidate : "General Candidates";
    const safeGroup = lastDetectedGroup && lastDetectedGroup !== "General Group" ? lastDetectedGroup : "General Group";
    
    const folderPath = `Exxat_Downloads/${safeGroup}/${lastDetectedRequirement}/${safeCandidate}`.replace(/\/+/g, '/');
    
    const pathEl = document.getElementById("exxat-manual-path");
    if (pathEl) {
      pathEl.innerText = folderPath;
    }

    chrome.storage.local.set({ 
      manualCandidate: safeCandidate,
      manualDownloadFolder: folderPath 
    });

    chrome.runtime.sendMessage({ action: "SET_MANUAL_DOWNLOAD_FOLDER", folder: folderPath }).catch(() => {});
    chrome.runtime.sendMessage({ action: "SET_MANUAL_DOWNLOAD_MODE", active: true }).catch(() => {});
    
    updateSecretUI(safeGroup, lastDetectedRequirement, safeCandidate, folderPath);
  });
}

function updateSecretUI(group, req, candidate, targetPath) {
  const dataDiv = document.getElementById('exxat-secret-data');
  if (dataDiv) {
    dataDiv.innerHTML = `
      Group: ${group}<br>
      Requirement: ${req}<br>
      Candidate: ${candidate}<br>
      <span style="color:#4ade80; font-weight:bold; word-break: break-all;">Target Path: ${targetPath}</span>
    `;
  }
}

function injectPageSecretUI() {
  if (!document.body) {
    setTimeout(injectPageSecretUI, 100);
    return;
  }

  if (document.getElementById("exxat-page-secret-dot")) return;

  const dot = document.createElement("div");
  dot.id = "exxat-page-secret-dot";
  dot.title = "Open Exxat Manual Routing Menu";
  dot.style.position = "fixed";
  dot.style.bottom = "10px";
  dot.style.left = "10px";
  dot.style.width = "16px";
  dot.style.height = "16px";
  dot.style.backgroundColor = "#ef4444";
  dot.style.borderRadius = "50%";
  dot.style.zIndex = "2147483647";
  dot.style.cursor = "pointer";
  dot.style.boxShadow = "0 2px 5px rgba(0,0,0,0.5)";

  document.body.appendChild(dot);

  const menu = document.createElement("div");
  menu.id = "exxat-manual-menu";
  menu.style.position = "fixed";
  menu.style.bottom = "35px";
  menu.style.left = "10px";
  menu.style.width = "320px";
  menu.style.backgroundColor = "#1e293b";
  menu.style.color = "#f8fafc";
  menu.style.padding = "16px";
  menu.style.borderRadius = "8px";
  menu.style.zIndex = "2147483647";
  menu.style.display = "none";
  menu.innerHTML = `
    <div style="font-weight: 600; margin-bottom: 12px; display: flex; justify-content: space-between;">
      <span>🔴 Exxat Routing Tools</span>
      <span id="exxat-menu-close" style="cursor: pointer;">✕</span>
    </div>
    <input type="checkbox" id="exxat-manual-toggle"> Enable Routing
    <div id="exxat-secret-data" style="margin-top: 10px; font-size: 11px;"></div>
    <div id="exxat-manual-path" style="display:none;"></div>
  `;
  document.body.appendChild(menu);

  dot.addEventListener("click", () => menu.style.display = menu.style.display === "none" ? "block" : "none");
  document.getElementById("exxat-menu-close").addEventListener("click", () => menu.style.display = "none");
  document.getElementById("exxat-manual-toggle").addEventListener("change", (e) => {
    chrome.storage.local.set({ manualDownloadMode: e.target.checked });
  });
}

chrome.storage.onChanged.addListener((changes, namespace) => {
  if (namespace === "local" && "manualDownloadMode" in changes) {
    const isModeActive = !!changes.manualDownloadMode.newValue;
    const toggle = document.getElementById("exxat-manual-toggle");
    if (toggle) toggle.checked = isModeActive;
    if (isModeActive) updateManualDownloadFolder();
  }
});

document.addEventListener("click", (e) => updateManualDownloadFolder(e.target));
document.addEventListener("mousedown", (e) => updateManualDownloadFolder(e.target));

setInterval(() => {
  chrome.storage.local.get(["manualDownloadMode"], (res) => {
    if (res.manualDownloadMode) updateManualDownloadFolder();
  });
}, 1000);

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", injectPageSecretUI);
} else {
  injectPageSecretUI();
}
