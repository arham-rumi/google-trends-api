import { InvalidResponseError } from '../errors.js';
import type { HttpSession } from '../http/session.js';
import type { HttpRequestOptions } from '../types.js';
import {
  DEFAULT_INTEREST_BY_REGION_RANGE,
  GOOGLE_INTEREST_BY_REGION_PATH,
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

export const INTEREST_BY_REGION_RESOLUTIONS = ['COUNTRY', 'REGION', 'CITY', 'DMA'] as const;

export type InterestByRegionResolution = (typeof INTEREST_BY_REGION_RESOLUTIONS)[number];

export interface InterestByRegionOptions {
  /** One keyword or up to five keywords to compare. */
  keywords: string | readonly string[];
  /** Google Trends geo code, for example "US", "PK", or "US-CA". */
  geo?: string;
  /** Google Trends time expression, for example "today 12-m" or "now 7-d". */
  timeRange?: string;
  /** Optional geographic granularity override. */
  resolution?: InterestByRegionResolution;
  /** Include locations with low search volume when Google supports it. */
  includeLowSearchVolumeGeos?: boolean;
  category?: number;
  property?: GoogleTrendsProperty;
  signal?: AbortSignal;
}

export interface InterestByRegionCoordinates {
  lat: number;
  lng: number;
}

export interface InterestByRegionValue {
  keyword: string;
  value: number;
  formattedValue: string;
}

export interface InterestByRegionPoint {
  geoName: string;
  geoCode?: string;
  coordinates?: InterestByRegionCoordinates;
  values: InterestByRegionValue[];
  maxValueIndex?: number;
}

export interface InterestByRegionResult {
  regions: InterestByRegionPoint[];
}

export interface FetchInterestByRegionOptions extends InterestByRegionOptions {
  locale: string;
  timezone: number;
}

interface GeoApiResponse {
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
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
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

function parseGeoCode(value: unknown, fieldName: string, url: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value === 'string' && value.trim().length > 0) {
    return value.trim();
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }

  throw new InvalidResponseError(
    url,
    new TypeError(`${fieldName} must be a non-empty string or number.`),
  );
}

function parseCoordinates(
  value: unknown,
  fieldName: string,
  url: string,
): InterestByRegionCoordinates | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (
    !isRecord(value) ||
    typeof value.lat !== 'number' ||
    !Number.isFinite(value.lat) ||
    typeof value.lng !== 'number' ||
    !Number.isFinite(value.lng)
  ) {
    throw new InvalidResponseError(
      url,
      new TypeError(`${fieldName} must contain finite lat and lng values.`),
    );
  }

  return {
    lat: value.lat,
    lng: value.lng,
  };
}

function parseMaxValueIndex(
  value: unknown,
  keywordCount: number,
  fieldName: string,
  url: string,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) >= keywordCount) {
    throw new InvalidResponseError(
      url,
      new TypeError(`${fieldName} is outside the keyword value range.`),
    );
  }

  return value as number;
}

function parseRegionPoint(
  value: unknown,
  keywords: readonly string[],
  url: string,
  index: number,
): InterestByRegionPoint {
  const fieldName = `geoMapData[${index}]`;

  if (!isRecord(value)) {
    throw new InvalidResponseError(url, new TypeError(`${fieldName} is not an object.`));
  }

  const geoName = parseOptionalString(value.geoName);

  if (geoName === undefined) {
    throw new InvalidResponseError(url, new TypeError(`${fieldName}.geoName is invalid.`));
  }

  const numericValues = parseNumberArray(value.value, `${fieldName}.value`, url);

  if (numericValues.length !== keywords.length) {
    throw new InvalidResponseError(
      url,
      new TypeError(`${fieldName}.value does not match the keyword count.`),
    );
  }

  const formattedValues = parseFormattedValues(
    value.formattedValue,
    numericValues,
    `${fieldName}.formattedValue`,
    url,
  );
  const geoCode = parseGeoCode(value.geoCode, `${fieldName}.geoCode`, url);
  const coordinates = parseCoordinates(value.coordinates, `${fieldName}.coordinates`, url);
  const maxValueIndex = parseMaxValueIndex(
    value.maxValueIndex,
    keywords.length,
    `${fieldName}.maxValueIndex`,
    url,
  );

  const point: InterestByRegionPoint = {
    geoName,
    values: keywords.map((keyword, keywordIndex) => ({
      keyword,
      value: numericValues[keywordIndex] as number,
      formattedValue: formattedValues[keywordIndex] as string,
    })),
  };

  if (geoCode !== undefined) {
    point.geoCode = geoCode;
  }

  if (coordinates !== undefined) {
    point.coordinates = coordinates;
  }

  if (maxValueIndex !== undefined) {
    point.maxValueIndex = maxValueIndex;
  }

  return point;
}

export function buildInterestByRegionComparisonItems(
  input: InterestByRegionOptions,
): ExploreComparisonItemInput[] {
  const rawKeywords = Array.isArray(input.keywords) ? input.keywords : [input.keywords];

  if (rawKeywords.length === 0 || rawKeywords.length > MAX_EXPLORE_COMPARISON_ITEMS) {
    throw new RangeError(
      `keywords must contain between 1 and ${MAX_EXPLORE_COMPARISON_ITEMS} items.`,
    );
  }

  const timeRange = requireNonEmptyString(
    input.timeRange ?? DEFAULT_INTEREST_BY_REGION_RANGE,
    'timeRange',
  );
  const geo = input.geo?.trim() ?? '';

  return rawKeywords.map((keyword, index) => ({
    keyword: requireNonEmptyString(keyword, `keywords[${index}]`),
    geo,
    time: timeRange,
  }));
}

export function parseInterestByRegionResponse(
  payload: unknown,
  keywords: readonly string[],
  url: string,
): InterestByRegionResult {
  if (!isRecord(payload)) {
    throw new InvalidResponseError(
      url,
      new TypeError('Interest-by-region response is not an object.'),
    );
  }

  const response = payload as unknown as GeoApiResponse;

  if (!isRecord(response.default)) {
    throw new InvalidResponseError(
      url,
      new TypeError('Interest-by-region response has no default object.'),
    );
  }

  const geoMapData = response.default.geoMapData;

  if (!Array.isArray(geoMapData)) {
    throw new InvalidResponseError(
      url,
      new TypeError('Interest-by-region response has no geoMapData array.'),
    );
  }

  return {
    regions: geoMapData.map((point, index) => parseRegionPoint(point, keywords, url, index)),
  };
}

function validateResolution(resolution: InterestByRegionResolution | undefined): void {
  if (resolution !== undefined && !INTEREST_BY_REGION_RESOLUTIONS.includes(resolution)) {
    throw new RangeError('resolution is not supported by Google Trends.');
  }
}

function createGeoRequest(
  request: Record<string, unknown>,
  input: FetchInterestByRegionOptions,
  category: number,
  property: GoogleTrendsProperty,
): Record<string, unknown> {
  const requestOptions = isRecord(request.requestOptions) ? request.requestOptions : {};

  return {
    ...request,
    ...(input.resolution === undefined ? {} : { resolution: input.resolution }),
    ...(input.includeLowSearchVolumeGeos === undefined
      ? {}
      : {
          includeLowSearchVolumeGeos: input.includeLowSearchVolumeGeos,
        }),
    requestOptions: {
      ...requestOptions,
      category,
      property,
    },
  };
}

export async function fetchInterestByRegion(
  session: HttpSession,
  input: FetchInterestByRegionOptions,
): Promise<InterestByRegionResult> {
  validateResolution(input.resolution);

  const comparisonItems = buildInterestByRegionComparisonItems(input);
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
  const widget = findExploreWidget(widgets, GOOGLE_WIDGET_IDS.interestByRegion);
  const request = createGeoRequest(widget.request, input, category, property);
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

  const response = await session.request(GOOGLE_INTEREST_BY_REGION_PATH, options);
  const payload = await parseGoogleResponse<unknown>(response);
  const keywords = comparisonItems.map((item) => item.keyword);

  return parseInterestByRegionResponse(
    payload,
    keywords,
    response.url || GOOGLE_INTEREST_BY_REGION_PATH,
  );
}
