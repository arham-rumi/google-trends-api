import { InvalidResponseError } from '../errors.js';
import { GOOGLE_XSSI_PREFIX } from './constants.js';

const UNKNOWN_RESPONSE_URL = 'unknown Google Trends endpoint';

/**
 * Removes Google's anti-XSSI prefix while leaving valid JSON untouched.
 *
 * The Explore endpoint currently uses `)]}'`, while widget-data endpoints
 * commonly use `)]}',`. Both variants are valid and must be supported.
 */
export function stripGoogleXssiPrefix(payload: string): string {
  const normalizedPayload = payload.trimStart();

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
export function parseGoogleJson<T>(payload: string, url: string): T {
  const json = stripGoogleXssiPrefix(payload);

  if (json.trim().length === 0) {
    throw new InvalidResponseError(url, new SyntaxError('Google Trends returned an empty body.'));
  }

  try {
    return JSON.parse(json) as T;
  } catch (error) {
    throw new InvalidResponseError(url, error);
  }
}

/**
 * Reads and parses a Fetch API response from a Google Trends endpoint.
 */
export async function parseGoogleResponse<T>(response: Response): Promise<T> {
  const url = response.url || UNKNOWN_RESPONSE_URL;

  try {
    const payload = await response.text();
    return parseGoogleJson<T>(payload, url);
  } catch (error) {
    if (error instanceof InvalidResponseError) {
      throw error;
    }

    throw new InvalidResponseError(url, error);
  }
}
