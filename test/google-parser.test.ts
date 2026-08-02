import { describe, expect, it } from 'vitest';

import { InvalidResponseError } from '../src/errors.js';
import {
  parseGoogleJson,
  parseGoogleResponse,
  stripGoogleXssiPrefix,
} from '../src/google/parser.js';

describe('Google response parser', () => {
  it('removes the four-character Explore anti-XSSI prefix', () => {
    expect(stripGoogleXssiPrefix(`)]}'\n{"value":42}`)).toBe('{"value":42}');
  });

  it('removes the five-character widget-data anti-XSSI prefix', () => {
    expect(stripGoogleXssiPrefix(`)]}',\n{"value":42}`)).toBe('{"value":42}');
  });

  it('supports whitespace before the anti-XSSI prefix', () => {
    expect(stripGoogleXssiPrefix(`  \n\t)]}',\n[1,2,3]`)).toBe('[1,2,3]');
  });

  it('leaves ordinary JSON ready for parsing', () => {
    expect(parseGoogleJson<{ value: number }>(' {"value":42} ', 'https://example.test')).toEqual({
      value: 42,
    });
  });

  it('parses Explore JSON with the four-character prefix', () => {
    const result = parseGoogleJson<{ widgets: unknown[] }>(
      `)]}'\n{"widgets":[]}`,
      'https://trends.google.com/trends/api/explore',
    );

    expect(result).toEqual({ widgets: [] });
  });

  it('parses widget-data JSON with the comma prefix', () => {
    const result = parseGoogleJson<{ default: object }>(
      `)]}',\n{"default":{}}`,
      'https://trends.google.com/trends/api/widgetdata/multiline',
    );

    expect(result).toEqual({ default: {} });
  });

  it('rejects empty responses with a library error', () => {
    expect(() => parseGoogleJson('   ', 'https://example.test')).toThrow(InvalidResponseError);
  });

  it('rejects malformed JSON with a library error', () => {
    expect(() => parseGoogleJson(`)]}',\n{"broken":`, 'https://example.test')).toThrow(
      InvalidResponseError,
    );
  });

  it('reads and parses a Fetch API response', async () => {
    const response = new Response(`)]}'\n{"ok":true}`);

    await expect(parseGoogleResponse<{ ok: boolean }>(response)).resolves.toEqual({
      ok: true,
    });
  });
});
