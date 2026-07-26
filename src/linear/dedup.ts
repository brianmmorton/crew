/**
 * Pure title-dedup helpers. No I/O — safe to unit test in isolation.
 */

/** Lowercase, strip punctuation, collapse whitespace. */
export function normalizeTitle(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Split a normalized title into a set of unique tokens. */
function tokenSet(s: string): Set<string> {
  const norm = normalizeTitle(s);
  if (norm === "") return new Set<string>();
  return new Set(norm.split(" "));
}

/**
 * Token-set Jaccard similarity over normalized titles, in [0, 1].
 * Two empty titles are considered identical (1). One empty, one not -> 0.
 */
export function similarity(a: string, b: string): number {
  const setA = tokenSet(a);
  const setB = tokenSet(b);
  if (setA.size === 0 && setB.size === 0) return 1;
  if (setA.size === 0 || setB.size === 0) return 0;

  let intersection = 0;
  for (const tok of setA) {
    if (setB.has(tok)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 1 : intersection / union;
}

/** True when the two titles are at least `threshold` similar. */
export function isDuplicate(a: string, b: string, threshold: number): boolean {
  return similarity(a, b) >= threshold;
}
