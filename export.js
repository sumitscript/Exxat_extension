// export.js — Exxat One Downloader Extension
// Converts the session log to CSV and triggers a browser download.
// Implements: Task 12.1 — Requirements 6.3

/**
 * CSV headers matching the LogEntry fields.
 * @type {string[]}
 */
const CSV_HEADERS = ["rowIndex", "studentId", "status", "reason", "timestamp"];

/**
 * Escape a single CSV field value.
 * Wraps the value in double-quotes and escapes any embedded double-quotes.
 * @param {*} value
 * @returns {string}
 */
function escapeCsvField(value) {
  const str = value == null ? "" : String(value);
  // Always quote fields to handle commas, newlines, and quotes safely
  return `"${str.replace(/"/g, '""')}"`;
}

/**
 * Convert an array of LogEntry objects to a CSV string.
 * The first row contains the headers: rowIndex, studentId, status, reason, timestamp.
 * Each subsequent row corresponds to one log entry.
 *
 * @param {Array<{rowIndex: number, studentId: string, status: string, reason?: string, timestamp: string}>} log
 * @returns {string} CSV-formatted string
 */
function logToCsv(log) {
  const headerRow = CSV_HEADERS.join(",");
  const dataRows = log.map((entry) =>
    CSV_HEADERS.map((field) => escapeCsvField(entry[field])).join(",")
  );
  return [headerRow, ...dataRows].join("\n");
}

/**
 * Export the session log as a CSV file download using chrome.downloads.download.
 * Creates a Blob URL from the CSV content and passes it to the Chrome Downloads API.
 *
 * @param {Array<{rowIndex: number, studentId: string, status: string, reason?: string, timestamp: string}>} log
 * @returns {Promise<number>} Resolves with the Chrome download ID
 */
function exportLog(log) {
  return new Promise((resolve, reject) => {
    if (!log || log.length === 0) {
      reject(new Error("exportLog: log is empty, nothing to export"));
      return;
    }

    const csv = logToCsv(log);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const filename = `exxat-log-${new Date().toISOString().replace(/[:.]/g, "-")}.csv`;

    chrome.downloads.download({ url, filename, saveAs: false }, (downloadId) => {
      URL.revokeObjectURL(url);
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(downloadId);
      }
    });
  });
}
