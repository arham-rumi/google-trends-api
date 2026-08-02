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

  it('supports a Unicode BOM and whitespace before the anti-XSSI prefix', () => {
    expect(stripGoogleXssiPrefix(`\uFEFF  \n\t)]}',\n[1,2,3]`)).toBe('[1,2,3]');
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

  it('reports HTML consent or challenge pages clearly', () => {
    try {
      parseGoogleJson(
        '<!doctype html><html><body>Before you continue</body></html>',
        'https://trends.google.com/trends/api/explore?token=secret',
        'text/html; charset=utf-8',
      );

      throw new Error('Expected parseGoogleJson to throw.');
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidResponseError);

      const invalidResponse = error as InvalidResponseError;
      expect(invalidResponse.message).toContain('returned HTML instead of JSON');
      expect(invalidResponse.message).not.toContain('token=secret');
      expect(invalidResponse.contentType).toBe('text/html; charset=utf-8');
      expect(invalidResponse.responseBody).toContain('Before you continue');
    }
  });

  it('keeps a short response snippet for malformed JSON', () => {
    try {
      parseGoogleJson(`)]}',\n{"broken":`, 'https://example.test');
      throw new Error('Expected parseGoogleJson to throw.');
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidResponseError);
      expect((error as InvalidResponseError).responseBody).toContain('{"broken":');
    }
  });

  it('reads content type and parses a Fetch API response', async () => {
    const response = new Response(`)]}'\n{"ok":true}`, {
      headers: {
        'content-type': 'application/json; charset=utf-8',
      },
    });

    await expect(parseGoogleResponse<{ ok: boolean }>(response)).resolves.toEqual({
      ok: true,
    });
  });
});
