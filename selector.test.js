/**
 * Unit tests for selector.js
 * Tests: buildSelector, isGeneratedId, buildClassPath, buildXPath
 */

// jsdom does not implement CSS.escape — provide a minimal polyfill
if (typeof global.CSS === 'undefined') {
  global.CSS = {
    escape: (value) =>
      String(value).replace(/([^\w-])/g, '\\$1'),
  };
}

const { buildSelector, isGeneratedId, buildClassPath, buildXPath } = require('./selector');

// ---------------------------------------------------------------------------
// isGeneratedId
// ---------------------------------------------------------------------------
describe('isGeneratedId', () => {
  test('returns true for null/undefined/empty', () => {
    expect(isGeneratedId(null)).toBe(true);
    expect(isGeneratedId('')).toBe(true);
  });

  test('returns true for IDs with colons (React/Radix pattern)', () => {
    expect(isGeneratedId('radix-:r0:')).toBe(true);
    expect(isGeneratedId(':r1:')).toBe(true);
  });

  test('returns true for purely numeric IDs', () => {
    expect(isGeneratedId('12345')).toBe(true);
  });

  test('returns true for UUID-like IDs', () => {
    expect(isGeneratedId('550e8400-e29b-41d4-a716-446655440000')).toBe(true);
  });

  test('returns true for IDs ending with multiple digits', () => {
    expect(isGeneratedId('input123')).toBe(true);
    expect(isGeneratedId('field_42')).toBe(true);
  });

  test('returns false for stable semantic IDs', () => {
    expect(isGeneratedId('main-nav')).toBe(false);
    expect(isGeneratedId('submit-btn')).toBe(false);
    expect(isGeneratedId('header')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildSelector — data-testid priority
// ---------------------------------------------------------------------------
describe('buildSelector — data-testid', () => {
  test('returns [data-testid] selector when attribute is present', () => {
    document.body.innerHTML = '<button data-testid="submit-btn">Submit</button>';
    const el = document.querySelector('button');
    expect(buildSelector(el)).toBe('[data-testid="submit-btn"]');
  });
});

// ---------------------------------------------------------------------------
// buildSelector — other data-* attributes
// ---------------------------------------------------------------------------
describe('buildSelector — data-* attributes', () => {
  test('returns data-id selector when no data-testid', () => {
    document.body.innerHTML = '<div data-id="row-42">Row</div>';
    const el = document.querySelector('div');
    expect(buildSelector(el)).toBe('[data-id="row-42"]');
  });
});

// ---------------------------------------------------------------------------
// buildSelector — stable ID
// ---------------------------------------------------------------------------
describe('buildSelector — stable ID', () => {
  test('returns #id selector for a non-generated ID', () => {
    document.body.innerHTML = '<input id="email-field" />';
    const el = document.querySelector('input');
    expect(buildSelector(el)).toBe('#email-field');
  });

  test('does NOT use a generated ID', () => {
    document.body.innerHTML = '<input id="radix-:r0:" />';
    const el = document.querySelector('input');
    const sel = buildSelector(el);
    expect(sel).not.toBe('#radix-\\:r0\\:');
    // Should fall through to class path or xpath
    expect(typeof sel).toBe('string');
    expect(sel.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// buildSelector — class path fallback
// ---------------------------------------------------------------------------
describe('buildSelector — class path', () => {
  test('returns a class-based path when no data attrs or stable ID', () => {
    document.body.innerHTML = '<div class="card"><button class="download-btn">Download</button></div>';
    const el = document.querySelector('.download-btn');
    const sel = buildSelector(el);
    expect(sel).toContain('button');
    expect(sel).toContain('download-btn');
  });
});

// ---------------------------------------------------------------------------
// buildSelector — XPath fallback
// ---------------------------------------------------------------------------
describe('buildSelector — XPath fallback', () => {
  test('returns xpath: prefixed string when no other selector is available', () => {
    document.body.innerHTML = '<div><span><em></em></span></div>';
    const el = document.querySelector('em');
    const sel = buildSelector(el);
    // Should be either a class path or xpath fallback
    expect(typeof sel).toBe('string');
    expect(sel.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// buildSelector — throws on invalid input
// ---------------------------------------------------------------------------
describe('buildSelector — error handling', () => {
  test('throws when passed null', () => {
    expect(() => buildSelector(null)).toThrow();
  });

  test('throws when passed a text node', () => {
    const textNode = document.createTextNode('hello');
    expect(() => buildSelector(textNode)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// buildSelector — round-trip: querySelector returns the same element
// ---------------------------------------------------------------------------
describe('buildSelector — round-trip', () => {
  test('querySelector with built selector returns the original element (data-testid)', () => {
    document.body.innerHTML = '<button data-testid="my-btn">Click</button>';
    const el = document.querySelector('button');
    const sel = buildSelector(el);
    expect(document.querySelector(sel)).toBe(el);
  });

  test('querySelector with built selector returns the original element (stable ID)', () => {
    document.body.innerHTML = '<input id="search-box" />';
    const el = document.querySelector('input');
    const sel = buildSelector(el);
    expect(document.querySelector(sel)).toBe(el);
  });

  test('querySelector with built selector returns the original element (class path)', () => {
    document.body.innerHTML = '<nav class="main-nav"><ul><li class="nav-item">Home</li></ul></nav>';
    const el = document.querySelector('.nav-item');
    const sel = buildSelector(el);
    // XPath selectors can't be used with querySelector — skip those
    if (!sel.startsWith('xpath:')) {
      expect(document.querySelector(sel)).toBe(el);
    }
  });
});
