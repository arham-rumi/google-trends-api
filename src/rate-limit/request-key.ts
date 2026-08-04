function normalizeForKey(value: unknown): unknown {
  if (value instanceof Date) {
    return value.toISOString();
  }

  if (Array.isArray(value)) {
    return value.map(normalizeForKey);
  }

  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, normalizeForKey(item)]),
    );
  }

  return value;
}

export function createRequestKey(method: string, input: unknown): string {
  return `${method}:${JSON.stringify(normalizeForKey(input))}`;
}
