export interface GeoConsistencyInput {
  country?: string;
  timezone?: string;
  locale?: string;
}

export interface GeoConsistencyProfile {
  country?: string;
  timezone?: string;
  locale: string;
  acceptLanguage: string;
}

const COUNTRY_DEFAULTS: Record<string, Omit<GeoConsistencyProfile, 'country'>> = {
  JP: {
    timezone: 'Asia/Tokyo',
    locale: 'ja-JP',
    acceptLanguage: 'ja-JP,ja,en-US,en',
  },
  US: {
    timezone: 'America/New_York',
    locale: 'en-US',
    acceptLanguage: 'en-US,en',
  },
  CA: {
    timezone: 'America/Toronto',
    locale: 'en-CA',
    acceptLanguage: 'en-CA,en-US,en',
  },
  GB: {
    timezone: 'Europe/London',
    locale: 'en-GB',
    acceptLanguage: 'en-GB,en-US,en',
  },
  DE: {
    timezone: 'Europe/Berlin',
    locale: 'de-DE',
    acceptLanguage: 'de-DE,de,en-US,en',
  },
  FR: {
    timezone: 'Europe/Paris',
    locale: 'fr-FR',
    acceptLanguage: 'fr-FR,fr,en-US,en',
  },
  SG: {
    timezone: 'Asia/Singapore',
    locale: 'en-SG',
    acceptLanguage: 'en-SG,en-US,en,zh-CN,zh',
  },
  HK: {
    timezone: 'Asia/Hong_Kong',
    locale: 'zh-HK',
    acceptLanguage: 'zh-HK,zh-TW,zh-CN,zh,en-US,en',
  },
  TW: {
    timezone: 'Asia/Taipei',
    locale: 'zh-TW',
    acceptLanguage: 'zh-TW,zh,en-US,en',
  },
  CN: {
    timezone: 'Asia/Shanghai',
    locale: 'zh-CN',
    acceptLanguage: 'zh-CN,zh,en-US,en',
  },
  KR: {
    timezone: 'Asia/Seoul',
    locale: 'ko-KR',
    acceptLanguage: 'ko-KR,ko,en-US,en',
  },
  AU: {
    timezone: 'Australia/Sydney',
    locale: 'en-AU',
    acceptLanguage: 'en-AU,en-US,en',
  },
};

const DEFAULT_PROFILE: GeoConsistencyProfile = {
  locale: 'en-US',
  acceptLanguage: 'en-US,en',
};

export const resolveGeoConsistencyProfile = (
  input: GeoConsistencyInput,
): GeoConsistencyProfile => {
  const country = input.country?.toUpperCase();
  const countryDefaults = country ? COUNTRY_DEFAULTS[country] : undefined;
  const locale = input.locale || countryDefaults?.locale || DEFAULT_PROFILE.locale;
  const acceptLanguage = countryDefaults?.acceptLanguage || buildAcceptLanguage(locale);

  return {
    country,
    timezone: input.timezone || countryDefaults?.timezone,
    locale,
    acceptLanguage,
  };
};

const buildAcceptLanguage = (locale: string) => {
  const language = locale.split('-')[0];
  return language && language !== locale
    ? `${locale},${language},en-US,en`
    : `${locale},en-US,en`;
};
