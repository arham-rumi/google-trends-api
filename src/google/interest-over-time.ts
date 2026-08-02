import { InvalidResponseError } from '../errors.js';
import type { HttpSession } from '../http/session.js';
import type { HttpRequestOptions } from '../types.js';
import {
  DEFAULT_INTEREST_OVER_TIME_RANGE,
  GOOGLE_INTEREST_OVER_TIME_PATH,
  GOOGLE_WIDGET_IDS,
  MAX_EXPLORE_COMPARISON_ITEMS,
  type GoogleTrendsProperty,
} from './constants.js';
import {
  fetchExploreWidgets,
  findExploreWidget,
  type ExploreComparisonItemInput,
} from './explore.js';
import { parseGoogleResponse } from './parser.js';

export interface InterestOverTimeOptions {
  /** One keyword or up to five keywords to compare. */
  keywords: string | readonly string[];
  /** Google Trends geo code, for example "US" or "PK". */
  geo?: string;
  /** Google Trends time expression, for example "today 12-m" or "now 7-d". */
  timeRange?: string;
  category?: number;
  property?: GoogleTrendsProperty;
  signal?: AbortSignal;
}

export interface InterestOverTimeValue {
  keyword: string;
  value: number;
  hasData: boolean;
  formattedValue: string;
}

export interface InterestOverTimePoint {
  /** Unix timestamp in seconds, as returned by Google Trends. */
  timestamp: number;
  date: Date;
  formattedTime: string;
  formattedAxisTime?: string;
  isPartial: boolean;
  values: InterestOverTimeValue[];
}

export interface InterestOverTimeAverage {
  keyword: string;
  value: number;
}

export interface InterestOverTimeResult {
  timeline: InterestOverTimePoint[];
  averages: InterestOverTimeAverage[];
}

export interface FetchInterestOverTimeOptions extends InterestOverTimeOptions {
  locale: string;
  timezone: number;
}

interface TimelineApiResponse {
  default: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireNonEmptyString(value: string, fieldName: string): string {
  const normalized = value.trim();

  if (normalized.length === 0) {
    throw new RangeError(`${fieldName} cannot be empty.`);
  }

  return normalized;
}

function parseOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function parseNumberArray(value: unknown, fieldName: string, url: string): number[] {
  if (
    !Array.isArray(value) ||
    !value.every((item) => typeof item === 'number' && Number.isFinite(item))
  ) {
    throw new InvalidResponseError(
      url,
      new TypeError(`${fieldName} must be an array of finite numbers.`),
    );
  }

  return value;
}

function parseBooleanArray(
  value: unknown,
  expectedLength: number,
  fieldName: string,
  url: string,
): boolean[] {
  if (value === undefined) {
    return Array.from({ length: expectedLength }, () => true);
  }

  if (!Array.isArray(value) || !value.every((item) => typeof item === 'boolean')) {
    throw new InvalidResponseError(
      url,
      new TypeError(`${fieldName} must be an array of booleans.`),
    );
  }

  if (value.length !== expectedLength) {
    throw new InvalidResponseError(
      url,
      new TypeError(`${fieldName} does not match the keyword count.`),
    );
  }

  return value;
}

function parseFormattedValues(
  value: unknown,
  numericValues: readonly number[],
  fieldName: string,
  url: string,
): string[] {
  if (value === undefined) {
    return numericValues.map(String);
  }

  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new InvalidResponseError(url, new TypeError(`${fieldName} must be an array of strings.`));
  }

  if (value.length !== numericValues.length) {
    throw new InvalidResponseError(
      url,
      new TypeError(`${fieldName} does not match the keyword count.`),
    );
  }

  return value;
}

function parseTimelinePoint(
  value: unknown,
  keywords: readonly string[],
  url: string,
  index: number,
): InterestOverTimePoint {
  if (!isRecord(value)) {
    throw new InvalidResponseError(url, new TypeError(`timelineData[${index}] is not an object.`));
  }

  const timestamp = Number(value.time);

  if (!Number.isFinite(timestamp) || timestamp < 0) {
    throw new InvalidResponseError(url, new TypeError(`timelineData[${index}].time is invalid.`));
  }

  const numericValues = parseNumberArray(value.value, `timelineData[${index}].value`, url);

  if (numericValues.length !== keywords.length) {
    throw new InvalidResponseError(
      url,
      new TypeError(`timelineData[${index}].value does not match the keyword count.`),
    );
  }

  const hasData = parseBooleanArray(
    value.hasData,
    keywords.length,
    `timelineData[${index}].hasData`,
    url,
  );
  const formattedValues = parseFormattedValues(
    value.formattedValue,
    numericValues,
    `timelineData[${index}].formattedValue`,
    url,
  );

  const formattedTime = parseOptionalString(value.formattedTime) ?? String(timestamp);
  const formattedAxisTime = parseOptionalString(value.formattedAxisTime);

  const point: InterestOverTimePoint = {
    timestamp,
    date: new Date(timestamp * 1_000),
    formattedTime,
    isPartial: value.isPartial === true,
    values: keywords.map((keyword, keywordIndex) => ({
      keyword,
      value: numericValues[keywordIndex] as number,
      hasData: hasData[keywordIndex] as boolean,
      formattedValue: formattedValues[keywordIndex] as string,
    })),
  };

  if (formattedAxisTime !== undefined) {
    point.formattedAxisTime = formattedAxisTime;
  }

  return point;
}

export function buildInterestOverTimeComparisonItems(
  input: InterestOverTimeOptions,
): ExploreComparisonItemInput[] {
  const rawKeywords = Array.isArray(input.keywords) ? input.keywords : [input.keywords];

  if (rawKeywords.length === 0 || rawKeywords.length > MAX_EXPLORE_COMPARISON_ITEMS) {
    throw new RangeError(
      `keywords must contain between 1 and ${MAX_EXPLORE_COMPARISON_ITEMS} items.`,
    );
  }

  const timeRange = requireNonEmptyString(
    input.timeRange ?? DEFAULT_INTEREST_OVER_TIME_RANGE,
    'timeRange',
  );
  const geo = input.geo?.trim() ?? '';

  return rawKeywords.map((keyword, index) => ({
    keyword: requireNonEmptyString(keyword, `keywords[${index}]`),
    geo,
    time: timeRange,
  }));
}

export function parseInterestOverTimeResponse(
  payload: unknown,
  keywords: readonly string[],
  url: string,
): InterestOverTimeResult {
  if (!isRecord(payload)) {
    throw new InvalidResponseError(
      url,
      new TypeError('Interest-over-time response is not an object.'),
    );
  }

  const response = payload as unknown as TimelineApiResponse;

  if (!isRecord(response.default)) {
    throw new InvalidResponseError(
      url,
      new TypeError('Interest-over-time response has no default object.'),
    );
  }

  const timelineData = response.default.timelineData;

  if (!Array.isArray(timelineData)) {
    throw new InvalidResponseError(
      url,
      new TypeError('Interest-over-time response has no timelineData array.'),
    );
  }

  const averagesValue = response.default.averages;
  const averages =
    averagesValue === undefined ? [] : parseNumberArray(averagesValue, 'default.averages', url);

  if (averages.length !== 0 && averages.length !== keywords.length) {
    throw new InvalidResponseError(
      url,
      new TypeError('default.averages does not match the keyword count.'),
    );
  }

  return {
    timeline: timelineData.map((point, index) => parseTimelinePoint(point, keywords, url, index)),
    averages: averages.map((value, index) => ({
      keyword: keywords[index] as string,
      value,
    })),
  };
}

function createTimelineRequest(
  request: Record<string, unknown>,
  category: number,
  property: GoogleTrendsProperty,
): Record<string, unknown> {
  const requestOptions = isRecord(request.requestOptions) ? request.requestOptions : {};

  return {
    ...request,
    requestOptions: {
      ...requestOptions,
      category,
      property,
    },
  };
}

export async function fetchInterestOverTime(
  session: HttpSession,
  input: FetchInterestOverTimeOptions,
): Promise<InterestOverTimeResult> {
  const comparisonItems = buildInterestOverTimeComparisonItems(input);
  const category = input.category ?? 0;
  const property = input.property ?? '';

  const widgets = await fetchExploreWidgets(session, {
    comparisonItems,
    locale: input.locale,
    timezone: input.timezone,
    category,
    property,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  const widget = findExploreWidget(widgets, GOOGLE_WIDGET_IDS.interestOverTime);
  const request = createTimelineRequest(widget.request, category, property);
  const options: HttpRequestOptions = {
    method: 'GET',
    query: {
      hl: input.locale,
      tz: input.timezone,
      req: JSON.stringify(request),
      token: widget.token,
    },
  };

  if (input.signal !== undefined) {
    options.signal = input.signal;
  }

  const response = await session.request(GOOGLE_INTEREST_OVER_TIME_PATH, options);
  const payload = await parseGoogleResponse<unknown>(response);
  const keywords = comparisonItems.map((item) => item.keyword);

  return parseInterestOverTimeResponse(
    payload,
    keywords,
    response.url || GOOGLE_INTEREST_OVER_TIME_PATH,
  );
}
