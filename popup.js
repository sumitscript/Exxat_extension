// Popup UI — Exxat One Downloader Extension
// Requirements: 1.4, 6.1, 6.2, 6.4
console.warn("[Exxat Popup] popup.js loaded successfully.");



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
const btnStartGroup      = document.getElementById("btn-start-group");
const btnExecuteRecorded = document.getElementById("btn-execute-recorded");
const btnStopReplay      = document.getElementById("btn-stop-replay");
const btnClear           = document.getElementById("btn-clear");
const btnExport          = document.getElementById("btn-export");
const btnClearHistory    = document.getElementById("btn-clear-history");

const csvInput           = document.getElementById("csv-upload");
const csvUploadLabel     = document.getElementById("csv-upload-label");
const targetCountEl      = document.getElementById("target-count");
const btnDownloadTemplate= document.getElementById("btn-download-template");
const btnClearTarget     = document.getElementById("btn-clear-target");
const targetInfoWrapper  = document.getElementById("target-info-wrapper");
const btnExportHistory   = document.getElementById("btn-export-history");

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
  btnStartGroup.style.display   = mode === "IDLE"       ? "" : "none";
  
  // Disable Start buttons only if there's a storage error
  btnStartReplay.disabled = !!storageError;
  btnStartGroup.disabled = !!storageError;
  btnExecuteRecorded.style.display = (mode === "IDLE" && (stepCount || 0) > 0) ? "" : "none";
  
  btnStopReplay.style.display   = mode === "REPLAYING"  ? "" : "none";
  
  // Show "Clear Steps" if there are recorded steps and we're idle
  btnClear.style.display = (mode === "IDLE" && (stepCount || 0) > 0) ? "" : "none";

  // Hide CSV upload and template stuff during replay
  const isIdle = mode === "IDLE";
  csvUploadLabel.style.display = isIdle ? "" : "none";
  btnDownloadTemplate.style.display = isIdle ? "" : "none";
  
  if (isIdle && targetCountEl.textContent.trim().length > 0) {
    targetInfoWrapper.style.display = "block";
  } else {
    targetInfoWrapper.style.display = "none";
  }

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
  sendAndRefresh("START_REPLAY");
});

btnStartGroup.addEventListener("click", () => {
  sendAndRefresh("START_GROUP_REPLAY");
});

btnExecuteRecorded.addEventListener("click", () => {
  summarySection.classList.remove("visible");
  sendAndRefresh("EXECUTE_RECORDED");
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
  const headers = [
    "Schedule ID", "File Name", "Source / Target", "Download Date", 
    "Download Time", "Execution Status", "Detailed Failure Reason", 
    "Skip Reason", "Retry Count", "Execution Duration", 
    "Storage Path", "Duplicate Detection Result", "CSV Mapping Details", "Trigger Source"
  ];
  
  const rows = log.map((item) => {
    const id = item.scheduleId || item.studentId || "";
    const dateStr = item.timestamp ? item.timestamp.split('T')[0] : "";
    const timeStr = item.timestamp ? item.timestamp.split('T')[1].replace('Z','') : "";
    
    const isSkip = item.status?.toUpperCase() === "SKIPPED";
    const isFail = item.status?.toUpperCase() === "FAILED";
    
    return [
      `"${id}"`,
      `"Multiple Documents"`,
      `"Exxat List"`,
      `"${dateStr}"`,
      `"${timeStr}"`,
      `"${item.status || "UNKNOWN"}"`,
      `"${isFail ? (item.reason || "").replace(/"/g, '""') : ""}"`,
      `"${isSkip ? (item.reason || "").replace(/"/g, '""') : ""}"`,
      `"1"`,
      `""`,
      `"Exxat_Downloads/${id}"`,
      `"${isSkip && item.reason && item.reason.includes('already') ? 'Duplicate' : 'Passed'}"`,
      `"Mapped"`,
      `"Automated"`
    ].join(",");
  });

  const csv = [headers.join(","), ...rows].join("\n");

  const blob = new Blob([csv], { type: "text/csv" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href     = url;
  a.download = `Exxat_Execution_Log_${Date.now()}.csv`;
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

// Load target template count & history
function loadStorageData() {
  chrome.storage.local.get(["targetScheduleIds", "processedHistory"], (res) => {
    if (res.targetScheduleIds && res.targetScheduleIds.length > 0) {
      targetCountEl.textContent = `Target: ${res.targetScheduleIds.length} students loaded`;
      if (currentMode === "IDLE") targetInfoWrapper.style.display = "block";
    } else {
      targetCountEl.textContent = "";
      targetInfoWrapper.style.display = "none";
    }
    
    if (res.processedHistory && res.processedHistory.length > 0) {
      btnClearHistory.textContent = `Clear History (${res.processedHistory.length})`;
      btnExportHistory.disabled = false;
      btnClearHistory.disabled = false;
    } else {
      btnClearHistory.textContent = "Clear Download History";
      btnExportHistory.disabled = true;
      btnClearHistory.disabled = true;
    }
  });
}

loadStorageData();

// Poll every second while popup is open to stay in sync with background state
setInterval(() => {
  chrome.runtime.sendMessage({ action: "GET_STATUS" }, (response) => {
    if (response?.payload) render(response.payload);
  });
  loadStorageData(); // Keep memory count and history buttons fresh
}, 1000);

// ---------------------------------------------------------------------------
// CSV Upload & Target Filtering
// ---------------------------------------------------------------------------

csvInput.addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = (event) => {
    const text = event.target.result;
    const lines = text.split(/\r?\n/);
    const ids = new Set();
    
    for (const line of lines) {
      // Find numbers that look like Schedule IDs (6-12 digits)
      const matches = line.match(/\b\d{6,12}\b/g);
      if (matches) {
        matches.forEach(m => ids.add(m));
      }
    }

    const arr = Array.from(ids);
    chrome.storage.local.set({ targetScheduleIds: arr }, () => {
      loadStorageData();
      alert(`Successfully loaded ${arr.length} Schedule IDs from CSV.`);
    });
  };
  reader.readAsText(file);
});

btnDownloadTemplate.addEventListener("click", () => {
  const csvContent = "Schedule ID\n10002117\n10002126";
  const blob = new Blob([csvContent], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "Target_Template.csv";
  a.click();
  URL.revokeObjectURL(url);
});

btnClearTarget.addEventListener("click", () => {
  chrome.storage.local.set({ targetScheduleIds: [] }, () => {
    loadStorageData();
  });
});

btnClearHistory.addEventListener("click", () => {
  if (confirm("Are you sure you want to clear the download history? The extension will redownload files for all students on the next run.")) {
    chrome.storage.local.set({ processedHistory: [] }, () => {
      loadStorageData();
      alert("Download history cleared.");
    });
  }
});

btnExportHistory.addEventListener("click", () => {
  chrome.storage.local.get("processedHistory", (res) => {
    const history = res.processedHistory || [];
    if (history.length === 0) return;
    
    // Detailed logs for history
    const headers = [
      "Schedule ID", "File Name", "Source / Target", "Download Date", 
      "Download Time", "Execution Status", "Detailed Failure Reason", 
      "Skip Reason", "Retry Count", "Execution Duration", 
      "Storage Path", "Duplicate Detection Result", "CSV Mapping Details", "Trigger Source"
    ];
    
    const rows = history.map(item => {
      if (typeof item === "string") return `"${item}","","","","","SUCCESS","","","","","","","",""`;
      
      const id = item.scheduleId || item.id || "";
      const dateStr = item.timestamp ? item.timestamp.split('T')[0] : "";
      const timeStr = item.timestamp ? item.timestamp.split('T')[1].replace('Z','') : "";
      const status = item.status || "SUCCESS";
      const reason = item.reason || "";
      
      return `"${id}","Multiple Documents","Exxat List","${dateStr}","${timeStr}","${status}","${reason}","","1","","Exxat_Downloads/${id}","Passed","Mapped","Automated"`;
    });
    
    const csvContent = [headers.join(","), ...rows].join("\n");
    const blob = new Blob([csvContent], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `Download_History_${Date.now()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  });
});

// ---------------------------------------------------------------------------
// Hidden Manual Download Controls Logic
// ---------------------------------------------------------------------------

const secretDot          = document.getElementById("secret-dot");
const manualPanel        = document.getElementById("manual-download-panel");
const chkManualDownload  = document.getElementById("chk-manual-download");
const manualGroupVal     = document.getElementById("manual-group-val");
const manualCategoryVal  = document.getElementById("manual-category-val");
const manualCandidateVal = document.getElementById("manual-candidate-val");
const manualPathVal      = document.getElementById("manual-path-val");

// Toggle panel visibility on secret dot click
secretDot.addEventListener("click", () => {
  const isHidden = manualPanel.style.display === "none";
  manualPanel.style.display = isHidden ? "block" : "none";
});

// Toggle manual download mode in storage
chkManualDownload.addEventListener("change", () => {
  const isChecked = chkManualDownload.checked;
  chrome.storage.local.set({ manualDownloadMode: isChecked }, () => {
    if (!isChecked) {
      chrome.storage.local.remove([
        "manualDownloadFolder",
        "manualGroup",
        "manualCategory",
        "manualCandidate"
      ]);
    }
  });
});

// Sync manual panel state and values from storage
function syncManualModeData() {
  chrome.storage.local.get([
    "manualDownloadMode",
    "manualGroup",
    "manualCategory",
    "manualCandidate",
    "manualDownloadFolder"
  ], (res) => {
    chkManualDownload.checked = !!res.manualDownloadMode;
    
    // Only update text values if panel is visible to save cycles
    if (manualPanel.style.display !== "none") {
      manualGroupVal.textContent = res.manualGroup || "-";
      manualCategoryVal.textContent = res.manualCategory || "-";
      manualCandidateVal.textContent = res.manualCandidate || "-";
      manualPathVal.textContent = res.manualDownloadFolder || "-";
    }
  });
}

// Initial sync
syncManualModeData();

// Add sync to the existing page interval
setInterval(syncManualModeData, 1000);

