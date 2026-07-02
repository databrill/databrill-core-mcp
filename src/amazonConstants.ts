export type AmazonRegion = "EU" | "FE" | "NA";

export interface AmazonMarketplaceInfo {
	readonly marketplaceId: string;
	readonly countryCode: string;
	readonly countryName: string;
	readonly timeZone: string;
	readonly defaultCurrencyCode: string;
	readonly defaultLanguageCode: string;
	readonly domainName: string;
	readonly region: AmazonRegion;
}

export const MARKETPLACE_ID_AE = "A2VIGQ35RCS4UG";
export const MARKETPLACE_ID_AU = "A39IBJ37TRP1C6";
export const MARKETPLACE_ID_BE = "AMEN7PMS3EDWL";
export const MARKETPLACE_ID_BR = "A2Q3Y263D00KWC";
export const MARKETPLACE_ID_CA = "A2EUQ1WTGCTBG2";
export const MARKETPLACE_ID_DE = "A1PA6795UKMFR9";
export const MARKETPLACE_ID_ES = "A1RKKUPIHCS9HS";
export const MARKETPLACE_ID_FR = "A13V1IB3VIYZZH";
export const MARKETPLACE_ID_GB = "A1F83G8C2ARO7P";
export const MARKETPLACE_ID_IE = "A28R8C7NBKEWEA";
export const MARKETPLACE_ID_IT = "APJ6JRA9NG5V4";
export const MARKETPLACE_ID_JP = "A1VC38T7YXB528";
export const MARKETPLACE_ID_MX = "A1AM78C64UM0Y8";
export const MARKETPLACE_ID_NL = "A1805IZSGTT6HS";
export const MARKETPLACE_ID_PL = "A1C3SOZRARQ6R3";
export const MARKETPLACE_ID_SA = "A17E79C6D8DWNP";
export const MARKETPLACE_ID_SE = "A2NODRKZP88ZB9";
export const MARKETPLACE_ID_TR = "A33AVAJ2PDY3EV";
export const MARKETPLACE_ID_US = "ATVPDKIKX0DER";

export const marketplaceInfos: readonly AmazonMarketplaceInfo[] = [
	{
		countryCode: "AE",
		marketplaceId: MARKETPLACE_ID_AE,
		countryName: "United Arab Emirates",
		timeZone: "Asia/Dubai",
		defaultCurrencyCode: "AED",
		defaultLanguageCode: "ar_AE",
		domainName: "www.amazon.ae",
		region: "EU",
	},
	{
		countryCode: "AU",
		marketplaceId: MARKETPLACE_ID_AU,
		countryName: "Australia",
		timeZone: "Australia/Sydney",
		defaultCurrencyCode: "AUD",
		defaultLanguageCode: "en_AU",
		domainName: "www.amazon.com.au",
		region: "FE",
	},
	{
		countryCode: "BE",
		marketplaceId: MARKETPLACE_ID_BE,
		countryName: "Belgium",
		timeZone: "Europe/Brussels",
		defaultCurrencyCode: "EUR",
		defaultLanguageCode: "fr_BE",
		domainName: "www.amazon.com.be",
		region: "EU",
	},
	{
		countryCode: "BR",
		marketplaceId: MARKETPLACE_ID_BR,
		countryName: "Brazil",
		timeZone: "America/Sao_Paulo",
		defaultCurrencyCode: "BRL",
		defaultLanguageCode: "pt_BR",
		domainName: "www.amazon.com.br",
		region: "NA",
	},
	{
		countryCode: "CA",
		marketplaceId: MARKETPLACE_ID_CA,
		countryName: "Canada",
		timeZone: "America/Los_Angeles",
		defaultCurrencyCode: "CAD",
		defaultLanguageCode: "en_CA",
		domainName: "www.amazon.ca",
		region: "NA",
	},
	{
		countryCode: "DE",
		marketplaceId: MARKETPLACE_ID_DE,
		countryName: "Germany",
		timeZone: "Europe/Paris",
		defaultCurrencyCode: "EUR",
		defaultLanguageCode: "de_DE",
		domainName: "www.amazon.de",
		region: "EU",
	},
	{
		countryCode: "ES",
		marketplaceId: MARKETPLACE_ID_ES,
		countryName: "Spain",
		timeZone: "Europe/Paris",
		defaultCurrencyCode: "EUR",
		defaultLanguageCode: "es_ES",
		domainName: "www.amazon.es",
		region: "EU",
	},
	{
		countryCode: "FR",
		marketplaceId: MARKETPLACE_ID_FR,
		countryName: "France",
		timeZone: "Europe/Paris",
		defaultCurrencyCode: "EUR",
		defaultLanguageCode: "fr_FR",
		domainName: "www.amazon.fr",
		region: "EU",
	},
	{
		countryCode: "GB",
		marketplaceId: MARKETPLACE_ID_GB,
		countryName: "United Kingdom",
		timeZone: "Europe/London",
		defaultCurrencyCode: "GBP",
		defaultLanguageCode: "en_GB",
		domainName: "www.amazon.co.uk",
		region: "EU",
	},
	{
		countryCode: "IE",
		marketplaceId: MARKETPLACE_ID_IE,
		countryName: "Ireland",
		timeZone: "Europe/London",
		defaultCurrencyCode: "EUR",
		defaultLanguageCode: "en_IE",
		domainName: "www.amazon.ie",
		region: "EU",
	},
	{
		countryCode: "IT",
		marketplaceId: MARKETPLACE_ID_IT,
		countryName: "Italy",
		timeZone: "Europe/Paris",
		defaultCurrencyCode: "EUR",
		defaultLanguageCode: "it_IT",
		domainName: "www.amazon.it",
		region: "EU",
	},
	{
		countryCode: "JP",
		marketplaceId: MARKETPLACE_ID_JP,
		countryName: "Japan",
		timeZone: "Asia/Tokyo",
		defaultCurrencyCode: "JPY",
		defaultLanguageCode: "ja_JP",
		domainName: "www.amazon.co.jp",
		region: "FE",
	},
	{
		countryCode: "MX",
		marketplaceId: MARKETPLACE_ID_MX,
		countryName: "Mexico",
		timeZone: "America/Los_Angeles",
		defaultCurrencyCode: "MXN",
		defaultLanguageCode: "es_MX",
		domainName: "www.amazon.com.mx",
		region: "NA",
	},
	{
		countryCode: "NL",
		marketplaceId: MARKETPLACE_ID_NL,
		countryName: "Netherlands",
		timeZone: "Europe/Paris",
		defaultCurrencyCode: "EUR",
		defaultLanguageCode: "nl_NL",
		domainName: "www.amazon.nl",
		region: "EU",
	},
	{
		countryCode: "PL",
		marketplaceId: MARKETPLACE_ID_PL,
		countryName: "Poland",
		timeZone: "Europe/Paris",
		defaultCurrencyCode: "PLN",
		defaultLanguageCode: "pl_PL",
		domainName: "www.amazon.pl",
		region: "EU",
	},
	{
		countryCode: "SA",
		marketplaceId: MARKETPLACE_ID_SA,
		countryName: "Saudi Arabia",
		timeZone: "Asia/Riyadh",
		defaultCurrencyCode: "SAR",
		defaultLanguageCode: "ar_SA",
		domainName: "www.amazon.sa",
		region: "EU",
	},
	{
		countryCode: "SE",
		marketplaceId: MARKETPLACE_ID_SE,
		countryName: "Sweden",
		timeZone: "Europe/Stockholm",
		defaultCurrencyCode: "SEK",
		defaultLanguageCode: "sv_SE",
		domainName: "www.amazon.se",
		region: "EU",
	},
	{
		countryCode: "TR",
		marketplaceId: MARKETPLACE_ID_TR,
		countryName: "Turkey",
		timeZone: "Europe/Istanbul",
		defaultCurrencyCode: "TRY",
		defaultLanguageCode: "tr_TR",
		domainName: "www.amazon.com.tr",
		region: "EU",
	},
	{
		countryCode: "US",
		marketplaceId: MARKETPLACE_ID_US,
		countryName: "United States",
		timeZone: "America/Los_Angeles",
		defaultCurrencyCode: "USD",
		defaultLanguageCode: "en_US",
		domainName: "www.amazon.com",
		region: "NA",
	},
];

export const countryCodeToMarketplaceInfo: {
	readonly [countryCode: string]: AmazonMarketplaceInfo;
} = Object.fromEntries(
	marketplaceInfos.map((info) => [info.countryCode, info]),
);

export const marketplaceIdToMarketplaceInfo: {
	readonly [marketplaceId: string]: AmazonMarketplaceInfo;
} = Object.fromEntries(
	marketplaceInfos.map((info) => [info.marketplaceId, info]),
);

// Region -> country codes
export const regionCountryCodes: { readonly [region in AmazonRegion]: readonly string[] } = {
	NA: ["US", "CA", "MX", "BR"],
	EU: ["AE", "BE", "DE", "ES", "FR", "GB", "IE", "IT", "NL", "PL", "SA", "SE", "TR"],
	FE: ["AU", "JP"],
};
