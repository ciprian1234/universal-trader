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
export function safeStringify_old(obj: unknown, indent?: number): string {
  try {
    return JSON.stringify(obj, bigIntReplacer, indent);
  } catch {
    return String(obj);
  }
}

// ===============================================================
// 🔧 SAFE JSON STRINGIFY (Handles BigInt, Circular References, Errors)
// ===============================================================

/**
 * Safely stringify an object, handling BigInt, circular references, and errors
 */
export function safeStringify(obj: any, indent = 2): string {
  const seen = new WeakSet();

  return JSON.stringify(
    obj,
    (_key, value) => {
      // Handle BigInt
      if (typeof value === 'bigint') {
        return value.toString() + 'n'; // Add 'n' suffix to indicate BigInt
      }

      // Handle Error objects (they don't serialize well by default)
      if (value instanceof Error) {
        return {
          ...value, // Include any custom properties
          name: value.name,
          message: value.message,
          stack: value.stack,
        };
      }

      // Handle circular references
      if (typeof value === 'object' && value !== null) {
        if (seen.has(value)) {
          return '[Circular]';
        }
        seen.add(value);
      }

      // Handle undefined (JSON.stringify removes it by default)
      if (value === undefined) {
        return '[undefined]';
      }

      // Handle functions (usually removed by JSON.stringify)
      if (typeof value === 'function') {
        return `[Function: ${value.name || 'anonymous'}]`;
      }

      // Handle Symbols
      if (typeof value === 'symbol') {
        return value.toString();
      }

      return value;
    },
    indent,
  );
}

/**
 * Format metadata for logging (compact for small objects, pretty for large ones)
 */
export function formatMeta(meta: any): string {
  if (!meta || Object.keys(meta).length === 0) {
    return '';
  }

  try {
    // For small objects, keep on same line
    const compactStr = safeStringify(meta, 0);
    if (compactStr.length <= 100) {
      return compactStr;
    }

    // For large objects, pretty print with indentation
    return '\n' + safeStringify(meta, 2);
  } catch (error) {
    // Fallback if serialization still fails
    return `[Unable to serialize: ${error instanceof Error ? error.message : String(error)}]`;
  }
}
