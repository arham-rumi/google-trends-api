/**
 * Prefix used by Google endpoints to prevent JSON hijacking.
 */
export const GOOGLE_XSSI_PREFIX = ")]}'," as const;

/**
 * Internal Google Trends endpoint used to discover tokenized widgets.
 */
export const GOOGLE_EXPLORE_PATH = '/trends/api/explore' as const;

/**
 * Internal Google Trends endpoint used by the time-series widget.
 */
export const GOOGLE_INTEREST_OVER_TIME_PATH = '/trends/api/widgetdata/multiline' as const;

/**
 * Widget identifiers returned by the Explore endpoint.
 */
export const GOOGLE_WIDGET_IDS = {
  interestOverTime: 'TIMESERIES',
  interestByRegion: 'GEO_MAP',
  relatedTopics: 'RELATED_TOPICS',
  relatedQueries: 'RELATED_QUERIES',
} as const;

export type GoogleWidgetId = (typeof GOOGLE_WIDGET_IDS)[keyof typeof GOOGLE_WIDGET_IDS];

export const GOOGLE_TRENDS_PROPERTIES = ['', 'images', 'news', 'youtube', 'froogle'] as const;

export type GoogleTrendsProperty = (typeof GOOGLE_TRENDS_PROPERTIES)[number];

/**
 * Google Trends currently supports up to five comparison items in the web UI.
 */
export const MAX_EXPLORE_COMPARISON_ITEMS = 5 as const;

export const DEFAULT_INTEREST_OVER_TIME_RANGE = 'today 12-m' as const;
