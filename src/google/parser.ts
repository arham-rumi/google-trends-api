import { InvalidResponseError } from '../errors.js';
import { GOOGLE_XSSI_PREFIX } from './constants.js';

const UNKNOWN_RESPONSE_URL = 'unknown Google Trends endpoint';
const MAX_RESPONSE_SNIPPET_LENGTH = 500;

function createResponseSnippet(payload: string): string | undefined {
  const normalized = payload.replace(/^\uFEFF/, '').trim();

  if (normalized.length === 0) {
    return undefined;
  }

  return normalized.slice(0, MAX_RESPONSE_SNIPPET_LENGTH);
}

function looksLikeHtml(payload: string, contentType?: string): boolean {
  if (contentType?.toLowerCase().includes('text/html') === true) {
    return true;
  }

  return /^\s*(?:<!doctype\s+html|<html|<head|<body)\b/i.test(payload);
}

/**
 * Removes Google's anti-XSSI prefix while leaving valid JSON untouched.
 *
 * The Explore endpoint currently uses `)]}'`, while widget-data endpoints
 * commonly use `)]}',`. Both variants are valid and must be supported.
 */
export function stripGoogleXssiPrefix(payload: string): string {
  const normalizedPayload = payload.replace(/^\uFEFF/, '').trimStart();

  if (!normalizedPayload.startsWith(GOOGLE_XSSI_PREFIX)) {
    return normalizedPayload;
  }

  let jsonPayload = normalizedPayload.slice(GOOGLE_XSSI_PREFIX.length);

  if (jsonPayload.startsWith(',')) {
    jsonPayload = jsonPayload.slice(1);
  }

  return jsonPayload.trimStart();
}

/**
 * Parses JSON returned by Google Trends endpoints.
 */
export function parseGoogleJson<T>(payload: string, url: string, contentType?: string): T {
  const json = stripGoogleXssiPrefix(payload);
  const responseBody = createResponseSnippet(payload);

  if (json.trim().length === 0) {
    throw new InvalidResponseError(
      url,
      new SyntaxError('Google Trends returned an empty response body.'),
      responseBody,
      contentType,
    );
  }

  if (looksLikeHtml(json, contentType)) {
    throw new InvalidResponseError(
      url,
      new TypeError(
        'Google Trends returned HTML instead of JSON. This is commonly a consent, sign-in, or automated-traffic challenge page.',
      ),
      responseBody,
      contentType,
    );
  }

  try {
    return JSON.parse(json) as T;
  } catch (error) {
    throw new InvalidResponseError(url, error, responseBody, contentType);
  }
}

/**
 * Reads and parses a Fetch API response from a Google Trends endpoint.
 */
export async function parseGoogleResponse<T>(response: Response): Promise<T> {
  const url = response.url || UNKNOWN_RESPONSE_URL;
  const contentType = response.headers.get('content-type') ?? undefined;

  try {
    const payload = await response.text();
    return parseGoogleJson<T>(payload, url, contentType);
  } catch (error) {
    if (error instanceof InvalidResponseError) {
      throw error;
    }

    throw new InvalidResponseError(url, error, undefined, contentType);
  }
}
