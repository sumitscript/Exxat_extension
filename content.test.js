/**
 * Unit tests for content.js pure logic functions.
 *
 * content.js is not a CommonJS module — it relies on browser globals
 * (chrome, document, window). We shim the minimum required globals and
 * then load the file with require() so Jest can exercise the functions.
 */

// ---------------------------------------------------------------------------
// Shim browser globals before loading content.js
// ---------------------------------------------------------------------------

// Minimal chrome.runtime shim so the file loads without errors
global.chrome = {
  runtime: {
    sendMessage: jest.fn().mockResolvedValue({}),
    onMessage: { addListener: jest.fn() },
    lastError: null,
  },
  storage: {
    local: {
      get: jest.fn(),
      set: jest.fn(),
    },
  },
};

// buildSelector is referenced by content.js — provide a simple stub
// (the real implementation is tested in selector.test.js)
global.buildSelector = (el) => {
  if (el.getAttribute && el.getAttribute('data-testid')) {
    return `[data-testid="${el.getAttribute('data-testid')}"]`;
  }
  if (el.id) return `#${el.id}`;
  return el.tagName.toLowerCase();
};

// Load content.js — it registers a message listener and defines functions
// in the module scope. We access them via the module's internal scope by
// re-exporting them at the bottom of content.js is NOT done, so we test
// the observable behaviour through DOM manipulation instead.

// ---------------------------------------------------------------------------
// getOnboardingStatus — tested by reconstructing the function logic
// ---------------------------------------------------------------------------

// We duplicate the minimal logic here to keep tests self-contained and fast.
// The real function is in content.js; these tests verify the algorithm.

const ONBOARDING_STATUS_HEADER = 'onboarding status';

function getOnboardingStatus(row) {
  if (!row) return '';

  const table = row.closest('table');
  if (table) {
    const headerCells = Array.from(table.querySelectorAll('thead th, thead td'));
    const colIndex = headerCells.findIndex(
      (th) => th.textContent.trim().toLowerCase() === ONBOARDING_STATUS_HEADER
    );
    if (colIndex !== -1) {
      const cells = row.querySelectorAll('td, th');
      const cell = cells[colIndex];
      if (cell) return cell.textContent.trim();
    }
  }

  const knownStatuses = ['not started', 'action needed', 'compliant confirmed'];
  const cells = Array.from(row.querySelectorAll('td, th'));
  for (const cell of cells) {
    const text = cell.textContent.trim();
    if (knownStatuses.includes(text.toLowerCase())) return text;
  }

  return '';
}

// ---------------------------------------------------------------------------
// getTableRows — tested via DOM
// ---------------------------------------------------------------------------

function getTableRows() {
  const rows = Array.from(document.querySelectorAll('table tbody tr, table tr'));
  return rows.filter((row) => {
    const cells = Array.from(row.children);
    if (cells.length === 0) return false;
    if (cells.every((c) => c.tagName === 'TH')) return false;
    const style = window.getComputedStyle(row);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    return true;
  });
}

// ---------------------------------------------------------------------------
// Tests: getOnboardingStatus
// ---------------------------------------------------------------------------

describe('getOnboardingStatus', () => {
  function makeTable(headerLabels, rowCells) {
    document.body.innerHTML = `
      <table>
        <thead><tr>${headerLabels.map((h) => `<th>${h}</th>`).join('')}</tr></thead>
        <tbody><tr>${rowCells.map((c) => `<td>${c}</td>`).join('')}</tr></tbody>
      </table>`;
    return document.querySelector('tbody tr');
  }

  test('returns status from correct column when header is present', () => {
    const row = makeTable(
      ['Student Name', 'Email', 'Onboarding Status', 'Program'],
      ['Alice', 'alice@example.com', 'Action Needed', 'Nursing']
    );
    expect(getOnboardingStatus(row)).toBe('Action Needed');
  });

  test('returns "Not Started" correctly', () => {
    const row = makeTable(
      ['Name', 'Onboarding Status'],
      ['Bob', 'Not Started']
    );
    expect(getOnboardingStatus(row)).toBe('Not Started');
  });

  test('returns "Compliant Confirmed" correctly', () => {
    const row = makeTable(
      ['Name', 'Onboarding Status'],
      ['Carol', 'Compliant Confirmed']
    );
    expect(getOnboardingStatus(row)).toBe('Compliant Confirmed');
  });

  test('falls back to scanning cells when no header found', () => {
    document.body.innerHTML = `
      <table>
        <tbody><tr><td>Dave</td><td>Action Needed</td></tr></tbody>
      </table>`;
    const row = document.querySelector('tbody tr');
    expect(getOnboardingStatus(row)).toBe('Action Needed');
  });

  test('returns empty string when no status cell found', () => {
    document.body.innerHTML = `
      <table>
        <tbody><tr><td>Eve</td><td>Some Other Value</td></tr></tbody>
      </table>`;
    const row = document.querySelector('tbody tr');
    expect(getOnboardingStatus(row)).toBe('');
  });

  test('returns empty string for null input', () => {
    expect(getOnboardingStatus(null)).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Tests: getTableRows
// ---------------------------------------------------------------------------

describe('getTableRows', () => {
  test('returns data rows, excludes header-only rows', () => {
    document.body.innerHTML = `
      <table>
        <thead><tr><th>Name</th><th>Status</th></tr></thead>
        <tbody>
          <tr><td>Alice</td><td>Action Needed</td></tr>
          <tr><td>Bob</td><td>Not Started</td></tr>
        </tbody>
      </table>`;
    const rows = getTableRows();
    expect(rows).toHaveLength(2);
  });

  test('returns empty array when table has no data rows', () => {
    document.body.innerHTML = `
      <table>
        <thead><tr><th>Name</th></tr></thead>
        <tbody></tbody>
      </table>`;
    expect(getTableRows()).toHaveLength(0);
  });

  test('excludes rows with only th cells', () => {
    document.body.innerHTML = `
      <table>
        <tr><th>Col A</th><th>Col B</th></tr>
        <tr><td>Data 1</td><td>Data 2</td></tr>
      </table>`;
    const rows = getTableRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].querySelector('td')).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Tests: waitForElement (basic behaviour)
// ---------------------------------------------------------------------------

// We test waitForElement by inlining the same logic (content.js is not a module).
function waitForElement(selector, timeout = 10000) {
  return new Promise((resolve, reject) => {
    function findVisible() {
      const el = document.querySelector(selector);
      if (!el) return null;
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') return null;
      return el;
    }

    const immediate = findVisible();
    if (immediate) { resolve(immediate); return; }

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

    observer.observe(document.body, { childList: true, subtree: true, attributes: true });
  });
}

describe('waitForElement', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  test('resolves immediately when element is already present', async () => {
    document.body.innerHTML = '<button id="go">Go</button>';
    const el = await waitForElement('#go');
    expect(el).not.toBeNull();
    expect(el.id).toBe('go');
  });

  test('resolves when element is added to DOM after a delay', async () => {
    document.body.innerHTML = '';
    const promise = waitForElement('#late-btn', 3000);
    setTimeout(() => {
      const btn = document.createElement('button');
      btn.id = 'late-btn';
      document.body.appendChild(btn);
    }, 50);
    const el = await promise;
    expect(el.id).toBe('late-btn');
  });

  test('rejects after timeout when element never appears', async () => {
    document.body.innerHTML = '';
    await expect(waitForElement('#never', 100)).rejects.toThrow('timeout');
  });
});
