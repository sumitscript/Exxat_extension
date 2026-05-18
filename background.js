// Service Worker — Exxat One Downloader Extension
// Handles state machine, message routing, and storage coordination.
// Implements: Task 5.1 — Requirements 1.3, 1.4, 2.1

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/**
 * @typedef {"IDLE" | "RECORDING" | "REPLAYING"} Mode
 *
 * @typedef {{ processed: number, skipped: number, failed: number, total: number }} Progress
 *
 * @typedef {{
 *   mode: Mode,
 *   steps: object[],
 *   sessionLog: object[],
 *   progress: Progress,
 *   interrupted: boolean,
 *   storageError: string | null
 * }} ExtensionState
 */

/** @type {ExtensionState} */
const state = {
  mode: "IDLE",
  steps: [],
  sessionLog: [],
  progress: { processed: 0, skipped: 0, failed: 0, total: 0 },
  interrupted: false,
  storageError: null,
};

/**
 * The tab ID that is currently being used for recording or replay.
 * Used to scope tab-lifecycle events to the correct tab.
 * @type {number | null}
 */
let activeTabId = null;

/**
 * The current subfolder path for intercepted downloads.
 * @type {string | null}
 */
let currentDownloadFolder = null;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Broadcast the current state as a STATUS_UPDATE to all extension views
 * (popup, options page, etc.).
 */
function broadcastStatus() {
  chrome.runtime.sendMessage({
    type: "STATUS_UPDATE",
    payload: {
      mode: state.mode,
      stepCount: state.steps.length,
      progress: { ...state.progress },
      log: state.sessionLog,
      interrupted: state.interrupted,
      storageError: state.storageError,
    },
  }).catch(() => {
    // No popup open — ignore "Could not establish connection" errors
  });
}

/**
 * Get the currently active tab in the focused window.
 * @returns {Promise<chrome.tabs.Tab | null>}
 */
async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab ?? null;
}

/**
 * Inject selector.js and content.js into the given tab if not already present.
 * Uses chrome.scripting so the extension works on any URL (not just pre-declared matches).
 * @param {number} tabId
 * @returns {Promise<void>}
 */
async function ensureContentScriptInjected(tabId) {
  // Probe whether the content script is already running by sending a ping.
  try {
    await chrome.tabs.sendMessage(tabId, { action: "PING" });
    return; // already injected
  } catch (_) {
    // Not injected yet — fall through to inject
  }

  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["selector.js", "content.js"],
  });
}

/**
 * Forward a command message to the content script in the active tab.
 * Injects the content script first if it hasn't been loaded yet.
 * @param {object} message
 * @param {number} [tabId] - optional explicit tab id
 * @returns {Promise<object | null>}
 */
async function forwardToContent(message, tabId) {
  const tab = tabId ? { id: tabId } : await getActiveTab();
  if (!tab?.id) return null;
  try {
    await ensureContentScriptInjected(tab.id);
    return await chrome.tabs.sendMessage(tab.id, message);
  } catch (err) {
    console.warn("[background] forwardToContent failed:", err.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Storage helpers (inline wrappers — storage.js runs only in content context)
// ---------------------------------------------------------------------------

const STORAGE_KEYS = { STEPS: "exxat_steps", LOG: "exxat_log" };

/** @returns {Promise<void>} */
function persistSteps(steps) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set({ [STORAGE_KEYS.STEPS]: steps }, () => {
      chrome.runtime.lastError
        ? reject(new Error(chrome.runtime.lastError.message))
        : resolve();
    });
  });
}

/** @returns {Promise<object[]>} */
function loadSteps() {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(STORAGE_KEYS.STEPS, (result) => {
      chrome.runtime.lastError
        ? reject(new Error(chrome.runtime.lastError.message))
        : resolve(result[STORAGE_KEYS.STEPS] ?? []);
    });
  });
}

/** @returns {Promise<void>} */
function persistLog(log) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set({ [STORAGE_KEYS.LOG]: log }, () => {
      chrome.runtime.lastError
        ? reject(new Error(chrome.runtime.lastError.message))
        : resolve();
    });
  });
}

/** @returns {Promise<void>} */
function clearStorage() {
  return new Promise((resolve, reject) => {
    chrome.storage.local.remove([STORAGE_KEYS.STEPS, STORAGE_KEYS.LOG], () => {
      chrome.runtime.lastError
        ? reject(new Error(chrome.runtime.lastError.message))
        : resolve();
    });
  });
}

// ---------------------------------------------------------------------------
// Initialise state from storage on service worker startup
// ---------------------------------------------------------------------------

(async () => {
  try {
    state.steps = await loadSteps();
    state.storageError = null;
  } catch (err) {
    console.error("[background] Failed to load persisted steps:", err);
    state.storageError = "Failed to load saved steps: " + err.message;
  }
})();

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message, _sender)
    .then((result) => sendResponse(result ?? { ok: true }))
    .catch((err) => {
      console.error("[background] handleMessage error:", err);
      sendResponse({ ok: false, error: err.message });
    });

  // Return true to keep the message channel open for the async response
  return true;
});

/**
 * Central async message handler.
 * @param {object} message
 * @param {chrome.runtime.MessageSender} sender
 * @returns {Promise<object>}
 */
async function handleMessage(message, sender) {
  switch (message.action) {

    // -----------------------------------------------------------------------
    case "START_RECORD": {
      console.log("[Exxat:BG] START_RECORD received, tabId from message:", message.tabId);
      if (state.mode !== "IDLE") {
        console.warn("[Exxat:BG] START_RECORD rejected — mode is", state.mode);
        return { ok: false, error: `Cannot start recording in mode: ${state.mode}` };
      }
      const recordTabId = message.tabId || (await getActiveTab())?.id;
      console.log("[Exxat:BG] Recording on tabId:", recordTabId);
      if (!recordTabId) {
        return { ok: false, error: "No active tab found." };
      }
      activeTabId = recordTabId;
      state.mode = "RECORDING";
      state.interrupted = false;
      state.storageError = null;
      const recResult = await forwardToContent({ action: "START_RECORD" }, activeTabId);
      console.log("[Exxat:BG] START_RECORD forwarded to content, result:", recResult);
      broadcastStatus();
      return { ok: true };
    }

    // -----------------------------------------------------------------------
    case "STOP_RECORD": {
      if (state.mode !== "RECORDING") {
        return { ok: false, error: `Cannot stop recording in mode: ${state.mode}` };
      }
      state.mode = "IDLE";
      await forwardToContent({ action: "STOP_RECORD" });
      // Persist the accumulated steps (Requirement 1.3)
      try {
        await persistSteps(state.steps);
        state.storageError = null;
      } catch (err) {
        console.error("[background] Failed to persist steps:", err);
        state.storageError = "Failed to save steps: " + err.message;
        broadcastStatus();
        return { ok: false, error: state.storageError };
      }
      broadcastStatus();
      return { ok: true, stepCount: state.steps.length };
    }



    // -----------------------------------------------------------------------
    case "EXECUTE_RECORDED": {
      console.log("[Exxat:BG] EXECUTE_RECORDED received, tabId:", message.tabId);
      if (state.mode !== "IDLE") {
        return { ok: false, error: `Cannot execute in mode: ${state.mode}` };
      }
      const replayTabId = message.tabId || (await getActiveTab())?.id;
      if (!replayTabId) return { ok: false, error: "No active tab found." };
      activeTabId = replayTabId;
      state.mode = "REPLAYING"; // Uses the same mode UI
      state.sessionLog = [];
      state.progress = { processed: 0, skipped: 0, failed: 0, total: 0 };
      state.interrupted = false;
      currentDownloadFolder = null;
      chrome.storage.local.set({ extensionMode: "REPLAYING", currentDownloadFolder: null });

      // Pass the recorded steps to the macro runner
      await forwardToContent({ action: "EXECUTE_RECORDED", steps: state.steps }, activeTabId);
      console.log("[Exxat:BG] EXECUTE_RECORDED forwarded");
      broadcastStatus();
      return { ok: true };
    }

    // -----------------------------------------------------------------------
    case "START_REPLAY": {
      console.log("[Exxat:BG] START_REPLAY received, tabId:", message.tabId);
      if (state.mode !== "IDLE") {
        console.warn("[Exxat:BG] START_REPLAY rejected — mode is", state.mode);
        return { ok: false, error: `Cannot start replay in mode: ${state.mode}` };
      }

      const replayTabId = message.tabId || (await getActiveTab())?.id;
      if (!replayTabId) {
        return { ok: false, error: "No active tab found." };
      }
      activeTabId = replayTabId;
      state.mode = "REPLAYING";
      state.sessionLog = [];
      state.progress = { processed: 0, skipped: 0, failed: 0, total: 0 };
      state.interrupted = false;
      currentDownloadFolder = null;
      
      // Save to storage for service worker restarts
      chrome.storage.local.set({ extensionMode: "REPLAYING", currentDownloadFolder: null });

      // Always pass empty steps — content script uses built-in engine
      await forwardToContent({ action: "START_REPLAY", steps: [] }, activeTabId);
      console.log("[Exxat:BG] START_REPLAY forwarded to content script");
      broadcastStatus();
      return { ok: true };
    }

    // -----------------------------------------------------------------------
    case "STOP_REPLAY": {
      if (state.mode !== "REPLAYING") {
        return { ok: false, error: `Cannot stop replay in mode: ${state.mode}` };
      }
      state.mode = "IDLE";
      activeTabId = null;
      currentDownloadFolder = null;
      chrome.storage.local.set({ extensionMode: "IDLE", currentDownloadFolder: null });
      
      await forwardToContent({ action: "STOP_REPLAY" });
      broadcastStatus();
      return { ok: true };
    }

    // -----------------------------------------------------------------------
    case "CLEAR_STEPS": {
      state.steps = [];
      state.sessionLog = [];
      state.progress = { processed: 0, skipped: 0, failed: 0, total: 0 };
      state.interrupted = false;
      state.storageError = null;
      try {
        await clearStorage();
      } catch (err) {
        console.error("[background] Failed to clear storage:", err);
        state.storageError = "Failed to clear storage: " + err.message;
      }
      broadcastStatus();
      return { ok: true };
    }

    // -----------------------------------------------------------------------
    case "EXPORT_LOG": {
      // Trigger CSV export — content script / popup handles the actual download.
      // Background forwards the current log so the popup can build the file.
      return { ok: true, log: state.sessionLog };
    }

    // -----------------------------------------------------------------------
    case "GET_STATUS": {
      // Reload steps from storage in case the service worker restarted
      try {
        const persisted = await loadSteps();
        if (persisted.length > 0) state.steps = persisted;
      } catch (_) {}
      return {
        ok: true,
        payload: {
          mode: state.mode,
          stepCount: state.steps.length,
          progress: { ...state.progress },
          log: state.sessionLog,
          interrupted: state.interrupted,
          storageError: state.storageError,
        },
      };
    }

    // -----------------------------------------------------------------------
    // Messages originating from the content script
    // -----------------------------------------------------------------------

    case "STEP_CAPTURED": {
      if (state.mode !== "RECORDING") {
        console.warn("[Exxat:BG] STEP_CAPTURED ignored — mode is", state.mode);
        break;
      }
      if (message.step) {
        state.steps.push(message.step);
        console.log(`[Exxat:BG] ✅ Step #${state.steps.length} captured:`, message.step.type, message.step.selector);
        broadcastStatus();
      }
      return { ok: true };
    }

    case "PROGRESS_UPDATE": {
      if (message.progress) {
        state.progress = { ...state.progress, ...message.progress };
        broadcastStatus();
      }
      return { ok: true };
    }

    case "LOG_ENTRY": {
      if (message.entry) {
        state.sessionLog.push(message.entry);
        try {
          await persistLog(state.sessionLog);
          state.storageError = null;
        } catch (err) {
          console.error("[background] Failed to persist log entry:", err);
          state.storageError = "Failed to save log: " + err.message;
        }
        broadcastStatus();
      }
      return { ok: true };
    }

    case "REPLAY_COMPLETE": {
      state.mode = "IDLE";
      activeTabId = null;
      currentDownloadFolder = null;
      chrome.storage.local.set({ extensionMode: "IDLE", currentDownloadFolder: null });
      broadcastStatus();
      return { ok: true };
    }

    case "SET_DOWNLOAD_FOLDER": {
      currentDownloadFolder = message.folder;
      chrome.storage.local.set({ currentDownloadFolder: message.folder });
      return { ok: true };
    }

    case "SESSION_INTERRUPTED": {
      // Tab closed, navigated away, or started from wrong page (Requirement 6.4)
      state.mode = "IDLE";
      state.interrupted = true;
      if (message.reason) {
        state.storageError = message.reason;
      }
      activeTabId = null;
      broadcastStatus();
      return { ok: true };
    }

    case "PING":
      return { ok: true };

    default:
      break;
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Open side panel when toolbar icon is clicked
// ---------------------------------------------------------------------------

chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ tabId: tab.id });
});

// ---------------------------------------------------------------------------
// Service worker keepalive — prevents Chrome from killing the SW during
// active recording or replay sessions (MV3 SWs go idle after ~30s)
// ---------------------------------------------------------------------------

// Create a repeating alarm every 20 seconds. Alarms wake the service worker.
chrome.alarms.create("keepalive", { periodInMinutes: 0.33 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "keepalive") {
    // Just waking up — no-op. The act of handling the alarm keeps the SW alive.
  }
});



chrome.tabs.onRemoved.addListener((tabId, _removeInfo) => {
  // Only react if the removed tab is the one running the session
  if (tabId !== activeTabId) return;
  if (state.mode === "REPLAYING" || state.mode === "RECORDING") {
    state.mode = "IDLE";
    state.interrupted = true;
    activeTabId = null;
    broadcastStatus();
  }
});

// Navigation within the same tab during replay is expected (e.g. opening a
// student detail page). We only interrupt if the tab is closed entirely,
// which is handled by chrome.tabs.onRemoved above.

// ---------------------------------------------------------------------------
// Downloads Interceptor (Subfolders)
// ---------------------------------------------------------------------------

chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  // Use async lookup to survive Service Worker restarts
  chrome.storage.local.get(["extensionMode", "currentDownloadFolder"], (res) => {
    if (res.extensionMode === "REPLAYING" && res.currentDownloadFolder) {
      // Clean filename of any weird characters
      const safeFilename = item.filename.replace(/[<>:"/\\|?*]+/g, '_');
      suggest({ filename: `${res.currentDownloadFolder}/${safeFilename}` });
    } else {
      suggest({ filename: item.filename });
    }
  });
  return true; // Indicates asynchronous suggestion
});
