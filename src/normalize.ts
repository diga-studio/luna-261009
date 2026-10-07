/**
 * Normalization pipeline, applied to both titles and addresses:
 * 1. Unicode NFKC normalization (may change string length).
 * 2. toLowerCase().
 * 3. Fold every run of consecutive ASCII spaces (U+0020) into one.
 * 4. Strip leading/trailing ASCII spaces.
 *
 * Only U+0020 is treated as a space here; other whitespace characters
 * are left untouched (NFKC already maps e.g. U+00A0 to U+0020).
 */
export function normalizeText(input: string): string {
  const lowered = input.normalize("NFKC").toLowerCase();
  let out = "";
  let pendingSpace = false;
  for (const ch of lowered) {
    if (ch === " ") {
      // Defer the space: it is emitted only if a non-space follows,
      // which both folds runs and trims the ends.
      pendingSpace = out.length > 0;
    } else {
      if (pendingSpace) {
        out += " ";
        pendingSpace = false;
      }
      out += ch;
    }
  }
  return out;
}
