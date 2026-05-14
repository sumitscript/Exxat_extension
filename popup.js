// Popup UI — Exxat One Downloader Extension
// Requirements: 1.4, 6.1, 6.2, 6.4

// ---------------------------------------------------------------------------
// Element references
// ---------------------------------------------------------------------------

const modeBadge          = document.getElementById("mode-badge");
const stepCountEl        = document.getElementById("step-count");
const interruptionWarn   = document.getElementById("interruption-warning");
const storageErrorEl     = document.getElementById("storage-error");

const btnStartRecord     = document.getElementById("btn-start-record");
const btnStopRecord      = document.getElementById("btn-stop-record");
const btnStartReplay     = document.getElementById("btn-start-replay");
const btnStopReplay      = document.getElementById("btn-stop-replay");
const btnClear           = document.getElementById("btn-clear");
const btnExport          = document.getElementById("btn-export");

const progressSection    = document.getElementById("progress-section");
const progProcessed      = document.getElementById("prog-processed");
const progSkipped        = document.getElementById("prog-skipped");
const progFailed         = document.getElementById("prog-failed");
const progTotal          = document.getElementById("prog-total");

const summarySection     = document.getElementById("summary-section");
const summaryStats       = document.getElementById("summary-stats");
const failedListWrapper  = document.getElementById("failed-list-wrapper");
const failedList         = document.getElementById("failed-list");

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** @type {"IDLE" | "RECORDING" | "REPLAYING"} */
let currentMode = "IDLE";

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

/**
 * Update all UI elements to reflect the given status payload.
 * @param {{ mode: string, stepCount: number, progress: object, log: object[], interrupted: boolean, storageError: string|null }} payload
 */
function render(payload) {
  const { mode, stepCount, progress, log, interrupted, storageError } = payload;

  currentMode = mode;

  // --- Mode badge ---
  modeBadge.textContent = mode;
  modeBadge.style.background =
    mode === "RECORDING" ? "rgba(224,36,36,0.7)"
    : mode === "REPLAYING" ? "rgba(5,122,85,0.7)"
    : "rgba(255,255,255,0.25)";

  // --- Step count (Requirement 1.4) ---
  stepCountEl.textContent = stepCount ?? 0;

  // --- Interruption warning (Requirement 6.4) ---
  // Use the explicit flag from background rather than inferring from mode transitions
  interruptionWarn.classList.toggle("visible", !!interrupted);

  // --- Storage error (Requirement 1.3) ---
  if (storageErrorEl) {
    storageErrorEl.textContent = storageError || "";
    storageErrorEl.classList.toggle("visible", !!storageError);
  }

  // --- Button visibility ---
  btnStartRecord.style.display  = mode === "IDLE"       ? "" : "none";
  btnStopRecord.style.display   = mode === "RECORDING"  ? "" : "none";
  btnStartReplay.style.display  = mode === "IDLE"       ? "" : "none";
  btnStopReplay.style.display   = mode === "REPLAYING"  ? "" : "none";

  // Disable Start Replay only if there's a storage error
  btnStartReplay.disabled = !!storageError;

  // Clear / Export always visible but disabled during active sessions
  btnClear.disabled   = mode !== "IDLE";
  btnExport.disabled  = !log || log.length === 0;

  // --- Live progress (Requirement 6.1) ---
  const isReplaying = mode === "REPLAYING";
  progressSection.classList.toggle("visible", isReplaying);

  if (progress) {
    progProcessed.textContent = progress.processed ?? 0;
    progSkipped.textContent   = progress.skipped   ?? 0;
    progFailed.textContent    = progress.failed    ?? 0;
    progTotal.textContent     = progress.total     ?? 0;
  }

  // --- Session summary (Requirement 6.2) ---
  // Show summary when idle, not interrupted, and log has entries
  const showSummary = mode === "IDLE" && !interrupted && log && log.length > 0;
  summarySection.classList.toggle("visible", showSummary);

  if (showSummary && progress) {
    summaryStats.textContent =
      `Processed: ${progress.processed}  |  Skipped: ${progress.skipped}  |  Failed: ${progress.failed}`;

    const failedEntries = log.filter((e) => e.status === "failed");
    failedListWrapper.classList.toggle("visible", failedEntries.length > 0);

    failedList.innerHTML = "";
    failedEntries.forEach((entry) => {
      const li = document.createElement("li");
      li.textContent = entry.studentId || `Row ${entry.rowIndex}`;
      failedList.appendChild(li);
    });
  }
}

// ---------------------------------------------------------------------------
// Button handlers
// ---------------------------------------------------------------------------

function sendAndRefresh(action) {
  // Get the current tab first, then send the action with the tabId
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tabId = tabs[0]?.id;
    chrome.runtime.sendMessage({ action, tabId }, () => {
      chrome.runtime.sendMessage({ action: "GET_STATUS" }, (response) => {
        if (response?.payload) render(response.payload);
      });
    });
  });
}

btnStartRecord.addEventListener("click", () => {
  sendAndRefresh("START_RECORD");
});

btnStopRecord.addEventListener("click", () => {
  sendAndRefresh("STOP_RECORD");
});

btnStartReplay.addEventListener("click", () => {
  summarySection.classList.remove("visible");
  sendAndRefresh("START_REPLAY");
});

btnStopReplay.addEventListener("click", () => {
  sendAndRefresh("STOP_REPLAY");
});

btnClear.addEventListener("click", () => {
  summarySection.classList.remove("visible");
  sendAndRefresh("CLEAR_STEPS");
});

btnExport.addEventListener("click", () => {
  chrome.runtime.sendMessage({ action: "EXPORT_LOG" }, (response) => {
    if (!response?.ok || !response.log?.length) return;
    downloadCsv(response.log);
  });
});

// ---------------------------------------------------------------------------
// CSV export helper
// ---------------------------------------------------------------------------

/**
 * Convert the session log to CSV and trigger a browser download.
 * @param {object[]} log
 */
function downloadCsv(log) {
  const headers = ["rowIndex", "studentId", "status", "reason", "timestamp"];
  const rows = log.map((e) =>
    headers.map((h) => JSON.stringify(e[h] ?? "")).join(",")
  );
  const csv = [headers.join(","), ...rows].join("\n");

  const blob = new Blob([csv], { type: "text/csv" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href     = url;
  a.download = `exxat-log-${Date.now()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------------------
// Listen for status updates from background
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "STATUS_UPDATE") {
    render(message.payload);
  }
});

// ---------------------------------------------------------------------------
// Bootstrap: request current state when popup opens
// ---------------------------------------------------------------------------

chrome.runtime.sendMessage({ action: "GET_STATUS" }, (response) => {
  if (response?.payload) {
    render(response.payload);
  }
});

// Poll every second while popup is open to stay in sync with background state
setInterval(() => {
  chrome.runtime.sendMessage({ action: "GET_STATUS" }, (response) => {
    if (response?.payload) render(response.payload);
  });
}, 1000);
