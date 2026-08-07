import { InvalidResponseError, WidgetNotFoundError } from '../errors.js';
import type { HttpSession } from '../http/session.js';
import type { HttpRequestOptions } from '../types.js';
import {
  DEFAULT_RELATED_SEARCHES_RANGE,
  GOOGLE_EXPLORE_PATH,
  GOOGLE_RELATED_SEARCHES_PATH,
  GOOGLE_WIDGET_IDS,
  MAX_EXPLORE_COMPARISON_ITEMS,
  type GoogleTrendsProperty,
  type GoogleWidgetId,
} from './constants.js';
import {
  fetchExploreWidgets,
  type ExploreComparisonItemInput,
  type ExploreWidget,
} from './explore.js';
import { parseGoogleResponse } from './parser.js';

export interface RelatedSearchesOptions {
  /** One keyword or up to five keywords. */
  keywords: string | readonly string[];
  /** Google Trends geo code, for example "US" or "PK". */
  geo?: string;
  /** Google Trends time expression, for example "today 12-m" or "now 7-d". */
  timeRange?: string;
  category?: number;
  property?: GoogleTrendsProperty;
  signal?: AbortSignal;
}

export interface RelatedQueryItem {
  query: string;
  value: number;
  formattedValue: string;
  link?: string;
}

export interface RelatedQueriesResult {
  keyword: string;
  top: RelatedQueryItem[];
  rising: RelatedQueryItem[];
}

export interface RelatedTopic {
  title: string;
  mid?: string;
  type?: string;
}

export interface RelatedTopicItem {
  topic: RelatedTopic;
  value: number;
  formattedValue: string;
  link?: string;
}

export interface RelatedTopicsResult {
  keyword: string;
  top: RelatedTopicItem[];
  rising: RelatedTopicItem[];
}

interface FetchRelatedSearchesOptions extends RelatedSearchesOptions {
  locale: string;
  timezone: number;
}

interface RankedLists<T> {
  top: T[];
  rising: T[];
}

interface WidgetKeywordPair {
  keyword: string;
  widget: ExploreWidget;
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

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function finiteNumber(value: unknown, fieldName: string, url: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new InvalidResponseError(url, new TypeError(`${fieldName} must be a finite number.`));
  }

  return value;
}

export function buildRelatedSearchComparisonItems(
  input: RelatedSearchesOptions,
): ExploreComparisonItemInput[] {
  const rawKeywords = Array.isArray(input.keywords) ? input.keywords : [input.keywords];

  if (rawKeywords.length === 0 || rawKeywords.length > MAX_EXPLORE_COMPARISON_ITEMS) {
    throw new RangeError(
      `keywords must contain between 1 and ${MAX_EXPLORE_COMPARISON_ITEMS} items.`,
    );
  }

  const timeRange = requireNonEmptyString(
    input.timeRange ?? DEFAULT_RELATED_SEARCHES_RANGE,
    'timeRange',
  );
  const geo = input.geo?.trim() ?? '';

  return rawKeywords.map((keyword, index) => ({
    keyword: requireNonEmptyString(keyword, `keywords[${index}]`),
    geo,
    time: timeRange,
  }));
}

function parseRankedList<T>(
  value: unknown,
  listName: string,
  url: string,
  parseItem: (value: unknown, fieldName: string, url: string) => T,
): T[] {
  if (value === undefined) {
    return [];
  }

  if (!isRecord(value)) {
    throw new InvalidResponseError(url, new TypeError(`${listName} is not an object.`));
  }

  const rankedKeywords = value.rankedKeyword;

  if (rankedKeywords === undefined) {
    return [];
  }

  if (!Array.isArray(rankedKeywords)) {
    throw new InvalidResponseError(
      url,
      new TypeError(`${listName}.rankedKeyword is not an array.`),
    );
  }

  return rankedKeywords.map((item, index) =>
    parseItem(item, `${listName}.rankedKeyword[${index}]`, url),
  );
}

function parseRankedLists<T>(
  payload: unknown,
  url: string,
  parseItem: (value: unknown, fieldName: string, url: string) => T,
): RankedLists<T> {
  if (!isRecord(payload) || !isRecord(payload.default)) {
    throw new InvalidResponseError(
      url,
      new TypeError('Related-searches response has no default object.'),
    );
  }

  const rankedList = payload.default.rankedList;

  if (rankedList === undefined) {
    return { top: [], rising: [] };
  }

  if (!Array.isArray(rankedList)) {
    throw new InvalidResponseError(url, new TypeError('default.rankedList is not an array.'));
  }

  return {
    top: parseRankedList(rankedList[0], 'default.rankedList[0]', url, parseItem),
    rising: parseRankedList(rankedList[1], 'default.rankedList[1]', url, parseItem),
  };
}

function parseQueryItem(value: unknown, fieldName: string, url: string): RelatedQueryItem {
  if (!isRecord(value) || typeof value.query !== 'string') {
    throw new InvalidResponseError(url, new TypeError(`${fieldName} has no valid query.`));
  }

  const query = value.query.trim();

  if (query.length === 0) {
    throw new InvalidResponseError(url, new TypeError(`${fieldName}.query cannot be empty.`));
  }

  const item: RelatedQueryItem = {
    query,
    value: finiteNumber(value.value, `${fieldName}.value`, url),
    formattedValue: optionalString(value.formattedValue) ?? String(value.value),
  };
  const link = optionalString(value.link);

  if (link !== undefined) {
    item.link = link;
  }

  return item;
}

function parseTopicItem(value: unknown, fieldName: string, url: string): RelatedTopicItem {
  if (!isRecord(value) || !isRecord(value.topic)) {
    throw new InvalidResponseError(url, new TypeError(`${fieldName} has no valid topic.`));
  }

  if (typeof value.topic.title !== 'string' || value.topic.title.trim().length === 0) {
    throw new InvalidResponseError(url, new TypeError(`${fieldName}.topic has no valid title.`));
  }

  const topic: RelatedTopic = {
    title: value.topic.title.trim(),
  };
  const mid = optionalString(value.topic.mid);
  const type = optionalString(value.topic.type);

  if (mid !== undefined) {
    topic.mid = mid;
  }

  if (type !== undefined) {
    topic.type = type;
  }

  const item: RelatedTopicItem = {
    topic,
    value: finiteNumber(value.value, `${fieldName}.value`, url),
    formattedValue: optionalString(value.formattedValue) ?? String(value.value),
  };
  const link = optionalString(value.link);

  if (link !== undefined) {
    item.link = link;
  }

  return item;
}

export function parseRelatedQueriesResponse(
  payload: unknown,
  url: string,
): RankedLists<RelatedQueryItem> {
  return parseRankedLists(payload, url, parseQueryItem);
}

export function parseRelatedTopicsResponse(
  payload: unknown,
  url: string,
): RankedLists<RelatedTopicItem> {
  return parseRankedLists(payload, url, parseTopicItem);
}

function extractWidgetKeyword(request: Record<string, unknown>): string | undefined {
  const restriction = request.restriction;

  if (!isRecord(restriction)) {
    return undefined;
  }

  const complexRestriction = restriction.complexKeywordsRestriction;

  if (!isRecord(complexRestriction) || !Array.isArray(complexRestriction.keyword)) {
    return undefined;
  }

  const firstKeyword = complexRestriction.keyword[0];

  if (!isRecord(firstKeyword)) {
    return undefined;
  }

  return optionalString(firstKeyword.value)?.trim();
}

function matchesWidgetId(widget: ExploreWidget, widgetId: GoogleWidgetId): boolean {
  return widget.id === widgetId || widget.id.startsWith(`${widgetId}_`);
}

function pairWidgetsWithKeywords(
  widgets: readonly ExploreWidget[],
  widgetId: GoogleWidgetId,
  keywords: readonly string[],
): WidgetKeywordPair[] {
  const candidates = widgets.filter((widget) => matchesWidgetId(widget, widgetId));

  if (candidates.length === 0) {
    throw new WidgetNotFoundError(
      widgetId,
      widgets.map((widget) => widget.id),
    );
  }

  if (candidates.length < keywords.length) {
    throw new InvalidResponseError(
      GOOGLE_EXPLORE_PATH,
      new TypeError(
        `Google Trends returned ${candidates.length} ${widgetId} widgets for ${keywords.length} keywords.`,
      ),
    );
  }

  const unusedWidgets = [...candidates];

  return keywords.map((keyword) => {
    const matchedIndex = unusedWidgets.findIndex(
      (widget) => extractWidgetKeyword(widget.request) === keyword,
    );
    const selectedIndex = matchedIndex >= 0 ? matchedIndex : 0;
    const widget = unusedWidgets.splice(selectedIndex, 1)[0];

    if (widget === undefined) {
      throw new InvalidResponseError(
        GOOGLE_EXPLORE_PATH,
        new TypeError(`No ${widgetId} widget is available for ${keyword}.`),
      );
    }

    return { keyword, widget };
  });
}

async function requestRelatedPayload(
  session: HttpSession,
  pair: WidgetKeywordPair,
  input: FetchRelatedSearchesOptions,
): Promise<{ payload: unknown; url: string }> {
  const options: HttpRequestOptions = {
    method: 'GET',
    query: {
      hl: input.locale,
      tz: input.timezone,
      req: JSON.stringify(pair.widget.request),
      token: pair.widget.token,
    },
  };

  if (input.signal !== undefined) {
    options.signal = input.signal;
  }

  const response = await session.request(GOOGLE_RELATED_SEARCHES_PATH, options);

  return {
    payload: await parseGoogleResponse<unknown>(response),
    url: response.url || GOOGLE_RELATED_SEARCHES_PATH,
  };
}

async function fetchWidgetsForComparisonItems(
  session: HttpSession,
  input: FetchRelatedSearchesOptions,
  comparisonItems: readonly ExploreComparisonItemInput[],
): Promise<ExploreWidget[]> {
  return fetchExploreWidgets(session, {
    comparisonItems,
    locale: input.locale,
    timezone: input.timezone,
    category: input.category ?? 0,
    property: input.property ?? '',
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
}

async function fetchRelatedWidgets(
  session: HttpSession,
  input: FetchRelatedSearchesOptions,
  widgetId: GoogleWidgetId,
): Promise<WidgetKeywordPair[]> {
  const comparisonItems = buildRelatedSearchComparisonItems(input);
  const widgets = await fetchWidgetsForComparisonItems(session, input, comparisonItems);
  const candidateCount = widgets.filter((widget) => matchesWidgetId(widget, widgetId)).length;

  // Google can omit RELATED_TOPICS widgets from multi-keyword Explore responses even
  // though the same widgets are available when each keyword is explored on its own.
  // Preserve the public 1-5 keyword API by falling back to one Explore request per
  // keyword only when the comparison response cannot satisfy all requested topics.
  if (
    widgetId === GOOGLE_WIDGET_IDS.relatedTopics &&
    comparisonItems.length > 1 &&
    candidateCount < comparisonItems.length
  ) {
    const pairs: WidgetKeywordPair[] = [];

    for (const comparisonItem of comparisonItems) {
      input.signal?.throwIfAborted();
      const singleWidgets = await fetchWidgetsForComparisonItems(session, input, [comparisonItem]);
      pairs.push(...pairWidgetsWithKeywords(singleWidgets, widgetId, [comparisonItem.keyword]));
    }

    return pairs;
  }

  return pairWidgetsWithKeywords(
    widgets,
    widgetId,
    comparisonItems.map((item) => item.keyword),
  );
}

export async function fetchRelatedQueries(
  session: HttpSession,
  input: FetchRelatedSearchesOptions,
): Promise<RelatedQueriesResult[]> {
  const pairs = await fetchRelatedWidgets(session, input, GOOGLE_WIDGET_IDS.relatedQueries);
  const results: RelatedQueriesResult[] = [];

  for (const pair of pairs) {
    input.signal?.throwIfAborted();
    const response = await requestRelatedPayload(session, pair, input);
    const lists = parseRelatedQueriesResponse(response.payload, response.url);

    results.push({
      keyword: pair.keyword,
      top: lists.top,
      rising: lists.rising,
    });
  }

  return results;
}

export async function fetchRelatedTopics(
  session: HttpSession,
  input: FetchRelatedSearchesOptions,
): Promise<RelatedTopicsResult[]> {
  const pairs = await fetchRelatedWidgets(session, input, GOOGLE_WIDGET_IDS.relatedTopics);
  const results: RelatedTopicsResult[] = [];

  for (const pair of pairs) {
    input.signal?.throwIfAborted();
    const response = await requestRelatedPayload(session, pair, input);
    const lists = parseRelatedTopicsResponse(response.payload, response.url);

    results.push({
      keyword: pair.keyword,
      top: lists.top,
      rising: lists.rising,
    });
  }

  return results;
}
