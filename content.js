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
  const knownStatuses = ["not started", "not applicable", "some action needed", "action needed", "compliant confirmed"];
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
 * Finds and clicks the eye/view icon on a list-page row to open the student
 * detail page. The eye icon is in the ACTIONS column.
 *
 * Exxat renders it as an SVG icon button — we look for a button/anchor in
 * the row that is NOT the edit (pencil) or message (chat) icon.
 * The eye icon typically has aria-label containing "view" or is the first
 * icon button in the actions cell.
 *
 * @param {Element} row
 * @returns {boolean} true if the eye icon was found and clicked
 */
function clickEyeIcon(row) {
  // Strategy 1: aria-label containing "view" or "eye"
  const byAriaLabel = row.querySelector(
    '[aria-label*="view" i], [aria-label*="eye" i], [aria-label*="detail" i], [title*="view" i]'
  );
  if (byAriaLabel) {
    console.log("[Exxat:NAV] Clicking eye icon (aria-label):", byAriaLabel);
    byAriaLabel.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    return true;
  }

  // Strategy 2: look for the SVG eye icon — Exxat uses MUI icons.
  // The eye icon SVG path starts with "M12 4.5C7 4.5..." (MUI Visibility icon)
  // We look for a button containing an SVG in the last cell (ACTIONS column)
  const cells = Array.from(row.querySelectorAll("td"));
  const actionsCell = cells[cells.length - 1];
  if (actionsCell) {
    // The eye icon button is typically the SECOND button in the actions cell
    // (after the edit pencil icon). But it can vary — find the one that is
    // NOT a pencil (edit) and NOT a chat/message icon.
    const buttons = Array.from(actionsCell.querySelectorAll('button, [role="button"]'));
    // Filter out buttons that contain text like "Edit" or "Message"
    const iconButtons = buttons.filter((btn) => {
      const text = btn.textContent.trim().toLowerCase();
      return text === "" || text.length < 5; // icon-only buttons have no text
    });

    // The eye icon is typically the first icon button in the actions cell
    // that is NOT the edit button. On Exxat, the order is: edit(pencil), eye, chat
    // Based on screenshots: eye icon is the SECOND icon button
    if (iconButtons.length >= 2) {
      console.log("[Exxat:NAV] Clicking eye icon (2nd icon button in actions cell)");
      iconButtons[1].dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      return true;
    }
    if (iconButtons.length === 1) {
      console.log("[Exxat:NAV] Clicking only icon button in actions cell");
      iconButtons[0].dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      return true;
    }
  }

  // Strategy 3: any link in the row that goes to /assignments/{id}
  const links = Array.from(row.querySelectorAll("a[href]"));
  const detailLink = links.find((a) => /\/assignments\/[a-f0-9]+/.test(a.getAttribute("href") || ""));
  if (detailLink) {
    console.log("[Exxat:NAV] Clicking detail link:", detailLink.href);
    detailLink.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    return true;
  }

  console.warn("[Exxat:NAV] Could not find eye icon in row");
  return false;
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
  console.log("[Exxat:DETAIL] Starting document download pass on", window.location.href);

  // Wait for the requirements list to render
  // The left panel items are list items — wait for at least one to appear
  let requirementItems = [];
  try {
    await waitForElement('[class*="requirement"], [class*="Requirement"], .onboarding-item, li', 8000);
  } catch (_) {
    console.warn("[Exxat:DETAIL] Requirements list did not appear");
  }

  // Find all clickable requirement items in the left panel.
  // They are list items or divs that contain the requirement name text.
  // We use multiple strategies since the class names are dynamic (MUI).
  requirementItems = getRequirementItems();
  console.log(`[Exxat:DETAIL] Found ${requirementItems.length} requirement items`);

  let downloaded = 0;

  for (let i = 0; i < requirementItems.length; i++) {
    if (stopReplayRequested) break;

    const item = requirementItems[i];
    const itemText = (item.textContent || "").trim().slice(0, 80);
    console.log(`[Exxat:DETAIL] Clicking requirement ${i + 1}/${requirementItems.length}: "${itemText}"`);

    // Click the requirement item to load its detail in the right panel
    item.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    // Wait a moment for the right panel to update
    await sleep(800);

    // Check if a Download button appeared in the right panel
    const downloadBtn = await findDownloadButton();
    if (downloadBtn) {
      console.log(`[Exxat:DETAIL]   ⬇ Download button found — clicking`);
      downloadBtn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      downloaded++;
      // Wait for the download to initiate before moving to next requirement
      await sleep(1200);
    } else {
      console.log(`[Exxat:DETAIL]   ℹ No download button for this requirement`);
    }
  }

  console.log(`[Exxat:DETAIL] Done — downloaded ${downloaded}/${requirementItems.length} requirements`);
  return { downloaded, total: requirementItems.length };
}

/**
 * Finds all requirement items in the left panel of the detail page.
 * Returns clickable elements representing each requirement.
 * @returns {Element[]}
 */
function getRequirementItems() {
  // The left panel on Exxat detail page has a list of requirements.
  // Each item is typically a div or li with the requirement name.
  // We look for the container that holds the list, then get its children.

  // Strategy 1: look for elements with text matching requirement patterns
  // The panel has items like "Carry Forward - ...", "Non Carry Forward - ...", "Tuberculosis (TB)"
  // These are typically inside a scrollable list container on the left side.

  // Try to find the requirements list container
  // Common patterns: a div with multiple child divs that each have a title + status text
  const allClickable = Array.from(document.querySelectorAll(
    'li[class*="item"], li[class*="Item"], ' +
    'div[class*="item"][class*="list"], ' +
    '[class*="requirement-item"], [class*="RequirementItem"], ' +
    '[class*="onboarding"] li, [class*="Onboarding"] li'
  )).filter((el) => {
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return false;
    const text = (el.textContent || "").trim();
    if (text.length < 3) return false;
    return true;
  });

  if (allClickable.length > 0) {
    console.log(`[Exxat:DETAIL] Found ${allClickable.length} requirement items (strategy 1)`);
    return allClickable;
  }

  // Strategy 2: find the left panel by looking for the "Onboarding Requirements" heading
  // then get all sibling/child clickable items
  const headings = Array.from(document.querySelectorAll("h1, h2, h3, h4, h5, h6, [class*='heading'], [class*='title']"));
  const reqHeading = headings.find((h) =>
    (h.textContent || "").toLowerCase().includes("onboarding requirement")
  );

  if (reqHeading) {
    // Walk up to find the container, then get all list items within it
    const container = reqHeading.closest("div, section, aside") || reqHeading.parentElement;
    if (container) {
      const items = Array.from(container.querySelectorAll("li, [role='listitem'], [class*='item']"))
        .filter((el) => {
          const style = window.getComputedStyle(el);
          if (style.display === "none" || style.visibility === "hidden") return false;
          const text = (el.textContent || "").trim();
          return text.length > 3;
        });
      if (items.length > 0) {
        console.log(`[Exxat:DETAIL] Found ${items.length} requirement items (strategy 2 - heading)`);
        return items;
      }
    }
  }

  // Strategy 3: find all elements that contain "Get Started", "Pending Review", "Download"
  // as status text — these are the requirement rows
  const statusTexts = ["get started", "pending review", "compliant", "not started"];
  const byStatus = Array.from(document.querySelectorAll("li, div, tr"))
    .filter((el) => {
      const text = (el.textContent || "").trim().toLowerCase();
      return statusTexts.some((s) => text.includes(s)) && text.length < 300;
    })
    .filter((el) => {
      const style = window.getComputedStyle(el);
      return style.display !== "none" && style.visibility !== "hidden";
    });

  if (byStatus.length > 0) {
    console.log(`[Exxat:DETAIL] Found ${byStatus.length} requirement items (strategy 3 - status text)`);
    return byStatus;
  }

  console.warn("[Exxat:DETAIL] Could not find requirement items");
  return [];
}

/**
 * Looks for a Download button in the right panel of the detail page.
 * Returns the button element if found, null otherwise.
 * @returns {Promise<Element|null>}
 */
async function findDownloadButton() {
  // The Download button appears in the right panel after clicking a requirement.
  // It has text "Download" and typically an icon.
  // We give it up to 1.5s to appear (React re-render after click).

  const selectors = [
    'button[class*="download" i]',
    'a[class*="download" i]',
    '[aria-label*="download" i]',
    '[title*="download" i]',
  ];

  // First try immediate match
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el) {
      const style = window.getComputedStyle(el);
      if (style.display !== "none" && style.visibility !== "hidden") return el;
    }
  }

  // Search by text content — find any button/anchor with text "Download"
  const allButtons = Array.from(document.querySelectorAll('button, a, [role="button"]'));
  const byText = allButtons.find((btn) => {
    const text = (btn.textContent || "").trim().toLowerCase();
    const style = window.getComputedStyle(btn);
    if (style.display === "none" || style.visibility === "hidden") return false;
    return text === "download" || text.includes("download");
  });

  if (byText) return byText;

  // Wait briefly and try again (right panel may still be loading)
  await sleep(500);

  const allButtons2 = Array.from(document.querySelectorAll('button, a, [role="button"]'));
  return allButtons2.find((btn) => {
    const text = (btn.textContent || "").trim().toLowerCase();
    const style = window.getComputedStyle(btn);
    if (style.display === "none" || style.visibility === "hidden") return false;
    return text === "download" || text.includes("download");
  }) || null;
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
 * 1. Click the eye icon → navigate to detail page
 * 2. Download all available documents
 * 3. Navigate back to list page
 *
 * @param {Element} row
 * @param {string} listPageUrl
 * @returns {Promise<{ success: boolean, downloaded?: number, reason?: string }>}
 */
async function replayRowBuiltIn(row, listPageUrl) {
  const currentUrl = window.location.href;

  // Click the eye icon to open the student detail page
  const clicked = clickEyeIcon(row);
  if (!clicked) {
    return { success: false, reason: "Could not find eye/view icon on row" };
  }

  // Wait for navigation to the detail page
  try {
    await waitForNavigation(currentUrl, 10000);
    console.log("[Exxat:REPLAY] Navigated to:", window.location.href);
  } catch (err) {
    return { success: false, reason: "Navigation to detail page timed out" };
  }

  // Wait for the Onboarding tab / requirements to load
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
 * @param {string} listPageUrl
 */
async function navigateBackToList(listPageUrl) {
  console.log("[Exxat:REPLAY] Navigating back to list page");

  // Strategy 1: click the breadcrumb "Schedules and onboarding" link
  const breadcrumbs = Array.from(document.querySelectorAll('a, [role="link"], [class*="breadcrumb"]'));
  const listLink = breadcrumbs.find((el) => {
    const text = (el.textContent || "").trim().toLowerCase();
    return text.includes("schedules") || text.includes("onboarding") && !text.includes(">");
  });

  if (listLink) {
    console.log("[Exxat:REPLAY] Clicking breadcrumb:", listLink.textContent.trim());
    listLink.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await sleep(2000);

    // Wait for the table to appear
    try {
      await waitForElement("table tbody tr", 8000);
      return;
    } catch (_) {}
  }

  // Strategy 2: browser back
  console.log("[Exxat:REPLAY] Using history.back()");
  window.history.back();
  await sleep(2000);

  try {
    await waitForElement("table tbody tr", 8000);
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
      const steps = message.steps || [];
      sendResponse({ ok: true });
      runReplaySession(steps).catch((err) => {
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
