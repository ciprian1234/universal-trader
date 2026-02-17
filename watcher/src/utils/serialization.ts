// ================================================================================================
// SERIALIZATION HELPERS
// ================================================================================================

/** JSON replacer that handles BigInt */
export function bigIntReplacer(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
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

/** Convert a serialized bigint string back to bigint, with default */
export function toBigInt(value: string | undefined | null, defaultValue = 0n): bigint {
  if (!value) return defaultValue;
  try {
    return BigInt(value);
  } catch {
    return defaultValue;
  }
}
