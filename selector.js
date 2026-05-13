/**
 * selector.js — Stable DOM Selector Builder
 *
 * Produces the most stable CSS selector (or XPath) for a given DOM element,
 * prioritised for React apps where class names and IDs can be dynamic.
 *
 * Priority order:
 *   1. [data-testid="..."]
 *   2. [data-*="..."]  (first non-testid data attribute found)
 *   3. #id             (only if the ID does not look auto-generated)
 *   4. Short class-based CSS path (up to 3 ancestors)
 *   5. XPath           (last resort)
 */

/**
 * Returns true if an ID looks auto-generated (contains digits, random chars, etc.)
 * Heuristic: reject IDs that contain a colon, end with digits, or look like UUIDs.
 * @param {string} id
 * @returns {boolean}
 */
function isGeneratedId(id) {
  if (!id) return true;
  // Reject IDs with colons (React / framework patterns like "radix-:r0:")
  if (id.includes(':')) return true;
  // Reject IDs that are purely numeric
  if (/^\d+$/.test(id)) return true;
  // Reject UUID-like patterns
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return true;
  // Reject IDs ending with one or more digits preceded by a non-word boundary
  // e.g. "input123", "field_42" — likely generated
  if (/\d{2,}$/.test(id)) return true;
  return false;
}

/**
 * Builds a short class-based CSS path by walking up at most `maxDepth` ancestors.
 * Each segment is "tag.class1.class2" (only stable-looking class names are used).
 * @param {Element} element
 * @param {number} maxDepth
 * @returns {string}
 */
function buildClassPath(element, maxDepth = 3) {
  const segments = [];
  let current = element;

  while (current && current.nodeType === Node.ELEMENT_NODE && segments.length < maxDepth) {
    const tag = current.tagName.toLowerCase();
    // Filter out generated classes: jss*, sc-*, css-* (MUI/styled-components hashes)
    const stableClasses = Array.from(current.classList).filter(
      (cls) =>
        !/^jss\d+/i.test(cls) &&           // MUI JSS: jss12345
        !/^css-[a-z0-9]+$/i.test(cls) &&   // MUI emotion: css-abc123
        !/^sc-[a-z0-9]+$/i.test(cls) &&    // styled-components: sc-aXZVg
        !/^[a-z]+-[a-z0-9]{5,}$/i.test(cls) // generic hash pattern
    );

    let segment = tag;
    if (stableClasses.length > 0) {
      segment += '.' + stableClasses.slice(0, 2).join('.');
    }

    // Add :nth-of-type to disambiguate siblings when needed
    const parent = current.parentElement;
    if (parent) {
      const siblings = Array.from(parent.children).filter(
        (c) => c.tagName === current.tagName
      );
      if (siblings.length > 1) {
        const index = siblings.indexOf(current) + 1;
        segment += `:nth-of-type(${index})`;
      }
    }

    segments.unshift(segment);
    current = current.parentElement;
  }

  return segments.join(' > ');
}

/**
 * Builds an absolute XPath for an element as a last resort.
 * @param {Element} element
 * @returns {string}
 */
function buildXPath(element) {
  if (element.id && !isGeneratedId(element.id)) {
    return `//*[@id="${element.id}"]`;
  }

  const parts = [];
  let current = element;

  while (current && current.nodeType === Node.ELEMENT_NODE) {
    const tag = current.tagName.toLowerCase();
    const parent = current.parentElement;
    let index = 1;

    if (parent) {
      const siblings = Array.from(parent.children).filter(
        (c) => c.tagName === current.tagName
      );
      if (siblings.length > 1) {
        index = siblings.indexOf(current) + 1;
      }
    }

    const hasSiblings = parent && Array.from(parent.children).filter(c => c.tagName === current.tagName).length > 1;
    parts.unshift(hasSiblings ? `${tag}[${index}]` : tag);
    current = current.parentElement;
  }

  return '/' + parts.join('/');
}

/**
 * Builds the most stable selector for the given DOM element.
 *
 * @param {Element} element - The DOM element to build a selector for.
 * @returns {string} A CSS selector string, or an XPath string prefixed with "xpath:".
 */
function buildSelector(element) {
  if (!element || element.nodeType !== Node.ELEMENT_NODE) {
    throw new Error('buildSelector requires a valid DOM Element');
  }

  // 1. data-testid
  const testId = element.getAttribute('data-testid');
  if (testId) {
    return `[data-testid="${CSS.escape(testId)}"]`;
  }

  // 2. Other data-* attributes (first one found, excluding data-testid)
  for (const attr of element.attributes) {
    if (attr.name.startsWith('data-') && attr.name !== 'data-testid' && attr.value) {
      return `[${attr.name}="${CSS.escape(attr.value)}"]`;
    }
  }

  // 3. Non-generated ID
  const id = element.id;
  if (id && !isGeneratedId(id)) {
    return `#${CSS.escape(id)}`;
  }

  // 4. Short class-based CSS path
  if (element.classList && element.classList.length > 0) {
    const path = buildClassPath(element);
    if (path) return path;
  }

  // 5. XPath fallback
  const xpath = buildXPath(element);
  return `xpath:${xpath}`;
}

// Export for use in content.js and tests
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { buildSelector, isGeneratedId, buildClassPath, buildXPath };
}
