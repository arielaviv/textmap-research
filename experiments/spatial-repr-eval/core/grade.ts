/** Deterministic comparison helpers for grading structured answers. */

export function setEqual(a: string[], b: string[]): boolean {
  const sa = new Set(a.map((s) => s.trim()));
  const sb = new Set(b.map((s) => s.trim()));
  if (sa.size !== sb.size) return false;
  for (const x of sa) if (!sb.has(x)) return false;
  return true;
}

export function orderedEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((x, i) => x.trim() === b[i].trim());
}
