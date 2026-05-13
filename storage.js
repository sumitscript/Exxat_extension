// storage.js — Exxat One Downloader Extension
// Promise-based wrapper around chrome.storage.local for persisting steps and session logs.
// Implements: Task 3.1 — Requirements 1.3

const KEYS = {
  STEPS: "exxat_steps",
  LOG: "exxat_log",
};

/**
 * Persist the recorded step sequence to chrome.storage.local.
 * @param {import('./content.js').Step[]} steps
 * @returns {Promise<void>}
 */
function saveSteps(steps) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set({ [KEYS.STEPS]: steps }, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve();
      }
    });
  });
}

/**
 * Load the persisted step sequence from chrome.storage.local.
 * Returns an empty array if no steps have been saved yet.
 * @returns {Promise<import('./content.js').Step[]>}
 */
function loadSteps() {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(KEYS.STEPS, (result) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(result[KEYS.STEPS] ?? []);
      }
    });
  });
}

/**
 * Persist the session log to chrome.storage.local.
 * @param {import('./content.js').LogEntry[]} log
 * @returns {Promise<void>}
 */
function saveLog(log) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set({ [KEYS.LOG]: log }, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve();
      }
    });
  });
}

/**
 * Load the persisted session log from chrome.storage.local.
 * Returns an empty array if no log has been saved yet.
 * @returns {Promise<import('./content.js').LogEntry[]>}
 */
function loadLog() {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(KEYS.LOG, (result) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(result[KEYS.LOG] ?? []);
      }
    });
  });
}

/**
 * Clear all extension data (steps and log) from chrome.storage.local.
 * @returns {Promise<void>}
 */
function clearAll() {
  return new Promise((resolve, reject) => {
    chrome.storage.local.remove([KEYS.STEPS, KEYS.LOG], () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve();
      }
    });
  });
}
