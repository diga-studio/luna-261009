import type { Name } from "../src/index";

export function nameOf(...labels: string[]): Name {
  return labels.map((label) => Uint8Array.from([...label].map((ch) => ch.charCodeAt(0))));
}

export function findSubsequence(haystack: Uint8Array, needle: number[], from = 0): number {
  outer: for (let i = from; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}
