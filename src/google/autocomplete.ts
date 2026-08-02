import { InvalidResponseError } from '../errors.js';
import type { HttpSession } from '../http/session.js';
import type { HttpRequestOptions } from '../types.js';
import { GOOGLE_AUTOCOMPLETE_PATH } from './constants.js';
import { parseGoogleResponse } from './parser.js';

export interface AutocompleteOptions {
  /** Search text to expand into Google Trends terms and topics. */
  keyword: string;
  /** Maximum number of suggestions to return. */
  limit?: number;
  signal?: AbortSignal;
}

export interface AutocompleteSuggestion {
  /** Value to pass to other Google Trends methods. Topic values are machine IDs. */
  keyword: string;
  title: string;
  type: string;
  kind: 'search-term' | 'topic';
  /** Google Knowledge Graph machine ID, present for topic suggestions. */
  mid?: string;
}

export interface AutocompleteResult {
  query: string;
  suggestions: AutocompleteSuggestion[];
}

interface FetchAutocompleteOptions extends AutocompleteOptions {
  locale: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireNonEmptyString(value: unknown, fieldName: string, url: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new InvalidResponseError(url, new TypeError(`${fieldName} must be a non-empty string.`));
  }

  return value.trim();
}

export function normalizeAutocompleteKeyword(keyword: string): string {
  const normalized = keyword.trim();

  if (normalized.length === 0) {
    throw new RangeError('keyword cannot be empty.');
  }

  return normalized;
}

function normalizeLimit(limit: number | undefined): number | undefined {
  if (limit === undefined) {
    return undefined;
  }

  if (!Number.isInteger(limit) || limit <= 0) {
    throw new RangeError('limit must be a positive integer.');
  }

  return limit;
}

function parseSearchTerm(value: unknown, index: number, url: string): AutocompleteSuggestion {
  if (!isRecord(value)) {
    throw new InvalidResponseError(
      url,
      new TypeError(`default.searchTerms[${index}] is not an object.`),
    );
  }

  const title = requireNonEmptyString(
    value.title ?? value.query ?? value.keyword,
    `default.searchTerms[${index}].title`,
    url,
  );
  const keyword =
    typeof value.query === 'string' && value.query.trim().length > 0
      ? value.query.trim()
      : typeof value.keyword === 'string' && value.keyword.trim().length > 0
        ? value.keyword.trim()
        : title;
  const type =
    typeof value.type === 'string' && value.type.trim().length > 0
      ? value.type.trim()
      : 'Search term';

  return {
    keyword,
    title,
    type,
    kind: 'search-term',
  };
}

function parseTopic(value: unknown, index: number, url: string): AutocompleteSuggestion {
  if (!isRecord(value)) {
    throw new InvalidResponseError(
      url,
      new TypeError(`default.topics[${index}] is not an object.`),
    );
  }

  const title = requireNonEmptyString(value.title, `default.topics[${index}].title`, url);
  const type = requireNonEmptyString(value.type, `default.topics[${index}].type`, url);

  if (typeof value.mid !== 'string' || value.mid.trim().length === 0) {
    return {
      keyword: title,
      title,
      type,
      kind: 'search-term',
    };
  }

  const mid = value.mid.trim();

  return {
    keyword: mid,
    title,
    type,
    kind: 'topic',
    mid,
  };
}

export function parseAutocompleteResponse(
  payload: unknown,
  query: string,
  url: string,
  limit?: number,
): AutocompleteResult {
  const normalizedQuery = normalizeAutocompleteKeyword(query);
  const normalizedLimit = normalizeLimit(limit);

  if (!isRecord(payload) || !isRecord(payload.default)) {
    throw new InvalidResponseError(
      url,
      new TypeError('Autocomplete response has no valid default object.'),
    );
  }

  const searchTermsValue = payload.default.searchTerms;
  const topicsValue = payload.default.topics;

  if (searchTermsValue !== undefined && !Array.isArray(searchTermsValue)) {
    throw new InvalidResponseError(
      url,
      new TypeError('default.searchTerms must be an array when present.'),
    );
  }

  if (topicsValue !== undefined && !Array.isArray(topicsValue)) {
    throw new InvalidResponseError(
      url,
      new TypeError('default.topics must be an array when present.'),
    );
  }

  if (searchTermsValue === undefined && topicsValue === undefined) {
    throw new InvalidResponseError(
      url,
      new TypeError('Autocomplete response contains no suggestion arrays.'),
    );
  }

  const suggestions = [
    ...(searchTermsValue ?? []).map((value, index) => parseSearchTerm(value, index, url)),
    ...(topicsValue ?? []).map((value, index) => parseTopic(value, index, url)),
  ];

  const uniqueSuggestions = Array.from(
    new Map(
      suggestions.map((suggestion) => [
        `${suggestion.kind}\u0000${suggestion.keyword}\u0000${suggestion.title}\u0000${suggestion.type}`,
        suggestion,
      ]),
    ).values(),
  );

  return {
    query: normalizedQuery,
    suggestions:
      normalizedLimit === undefined
        ? uniqueSuggestions
        : uniqueSuggestions.slice(0, normalizedLimit),
  };
}

export async function fetchAutocomplete(
  session: HttpSession,
  input: FetchAutocompleteOptions,
): Promise<AutocompleteResult> {
  const keyword = normalizeAutocompleteKeyword(input.keyword);
  const limit = normalizeLimit(input.limit);
  const requestOptions: HttpRequestOptions = {
    headers: {
      accept: 'application/json,text/plain,*/*',
    },
    query: {
      hl: input.locale,
    },
  };

  if (input.signal !== undefined) {
    requestOptions.signal = input.signal;
  }

  const path = `${GOOGLE_AUTOCOMPLETE_PATH}${encodeURIComponent(keyword)}`;
  const response = await session.request(path, requestOptions);
  const payload = await parseGoogleResponse<unknown>(response);

  return parseAutocompleteResponse(payload, keyword, response.url, limit);
}
