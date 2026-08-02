import { InvalidResponseError, WidgetNotFoundError } from '../errors.js';
import type { HttpRequestOptions } from '../types.js';
import type { HttpSession } from '../http/session.js';
import {
  GOOGLE_EXPLORE_PATH,
  GOOGLE_TRENDS_PROPERTIES,
  MAX_EXPLORE_COMPARISON_ITEMS,
  type GoogleTrendsProperty,
  type GoogleWidgetId,
} from './constants.js';
import { parseGoogleResponse } from './parser.js';

export interface ExploreComparisonItemInput {
  keyword: string;
  geo?: string;
  time: string;
}

export interface ExploreRequestInput {
  comparisonItems: readonly ExploreComparisonItemInput[];
  locale: string;
  timezone: number;
  category?: number;
  property?: GoogleTrendsProperty;
  signal?: AbortSignal;
}

export interface ExploreComparisonItem {
  keyword: string;
  geo: string;
  time: string;
}

export interface ExploreApiRequest {
  comparisonItem: ExploreComparisonItem[];
  category: number;
  property: GoogleTrendsProperty;
}

export interface ExploreWidget {
  id: string;
  token: string;
  request: Record<string, unknown>;
  title?: string;
  type?: string;
}

interface ExploreApiResponse {
  widgets: unknown;
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

function parseExploreWidget(value: unknown, url: string, index: number): ExploreWidget {
  if (!isRecord(value)) {
    throw new InvalidResponseError(
      url,
      new TypeError(`Explore widget at index ${index} is not an object.`),
    );
  }

  if (typeof value.id !== 'string' || value.id.length === 0) {
    throw new InvalidResponseError(
      url,
      new TypeError(`Explore widget at index ${index} has no valid id.`),
    );
  }

  if (typeof value.token !== 'string' || value.token.length === 0) {
    throw new InvalidResponseError(
      url,
      new TypeError(`Explore widget ${value.id} has no valid token.`),
    );
  }

  if (!isRecord(value.request)) {
    throw new InvalidResponseError(
      url,
      new TypeError(`Explore widget ${value.id} has no valid request payload.`),
    );
  }

  const widget: ExploreWidget = {
    id: value.id,
    token: value.token,
    request: value.request,
  };

  const title = parseOptionalString(value.title);
  const type = parseOptionalString(value.type);

  if (title !== undefined) {
    widget.title = title;
  }

  if (type !== undefined) {
    widget.type = type;
  }

  return widget;
}

export function buildExploreRequest(input: ExploreRequestInput): ExploreApiRequest {
  if (
    input.comparisonItems.length === 0 ||
    input.comparisonItems.length > MAX_EXPLORE_COMPARISON_ITEMS
  ) {
    throw new RangeError(
      `comparisonItems must contain between 1 and ${MAX_EXPLORE_COMPARISON_ITEMS} items.`,
    );
  }

  requireNonEmptyString(input.locale, 'locale');

  if (!Number.isInteger(input.timezone) || input.timezone < -840 || input.timezone > 840) {
    throw new RangeError('timezone must be an integer between -840 and 840 minutes.');
  }

  const category = input.category ?? 0;

  if (!Number.isInteger(category) || category < 0) {
    throw new RangeError('category must be a non-negative integer.');
  }

  const property = input.property ?? '';

  if (!GOOGLE_TRENDS_PROPERTIES.includes(property)) {
    throw new RangeError('property is not supported by Google Trends.');
  }

  return {
    comparisonItem: input.comparisonItems.map((item, index) => ({
      keyword: requireNonEmptyString(item.keyword, `comparisonItems[${index}].keyword`),
      geo: item.geo?.trim() ?? '',
      time: requireNonEmptyString(item.time, `comparisonItems[${index}].time`),
    })),
    category,
    property,
  };
}

export function parseExploreWidgets(payload: unknown, url: string): ExploreWidget[] {
  if (!isRecord(payload)) {
    throw new InvalidResponseError(url, new TypeError('Explore response is not an object.'));
  }

  const response = payload as unknown as ExploreApiResponse;

  if (!Array.isArray(response.widgets)) {
    throw new InvalidResponseError(
      url,
      new TypeError('Explore response does not contain a widgets array.'),
    );
  }

  if (response.widgets.length === 0) {
    throw new InvalidResponseError(url, new TypeError('Explore response contains no widgets.'));
  }

  return response.widgets.map((widget, index) => parseExploreWidget(widget, url, index));
}

export async function fetchExploreWidgets(
  session: HttpSession,
  input: ExploreRequestInput,
): Promise<ExploreWidget[]> {
  const request = buildExploreRequest(input);
  const options: HttpRequestOptions = {
    method: 'GET',
    query: {
      hl: input.locale.trim(),
      tz: input.timezone,
      req: JSON.stringify(request),
    },
  };

  if (input.signal !== undefined) {
    options.signal = input.signal;
  }

  const response = await session.request(GOOGLE_EXPLORE_PATH, options);
  const payload = await parseGoogleResponse<unknown>(response);

  return parseExploreWidgets(payload, response.url || GOOGLE_EXPLORE_PATH);
}

export function findExploreWidget(
  widgets: readonly ExploreWidget[],
  widgetId: GoogleWidgetId,
): ExploreWidget {
  const widget = widgets.find(
    (candidate) => candidate.id === widgetId || candidate.id.startsWith(`${widgetId}_`),
  );

  if (widget === undefined) {
    throw new WidgetNotFoundError(
      widgetId,
      widgets.map((candidate) => candidate.id),
    );
  }

  return widget;
}
