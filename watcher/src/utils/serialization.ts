// ================================================================================================
// SERIALIZATION HELPERS
// ================================================================================================

/** JSON replacer that handles BigInt */
export function bigIntReplacer(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') return `${value.toString()}n`;
  if (value instanceof Map) return Object.fromEntries(value);
  if (value instanceof Set) return [...value];
  return value;
}

/** Safe JSON.stringify for logging */
export function safeStringify(obj: unknown, indent?: number): string {
  try {
    return JSON.stringify(obj, bigIntReplacer, indent);
  } catch {
    return String(obj);
  }
}
