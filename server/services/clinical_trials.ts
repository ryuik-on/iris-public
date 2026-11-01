import {
  ExternalSourceError, FetchLike, clampInt, fetchJson, fetchText, plainText,
} from './external_http.js';

/**
 * Clinical study registries: jRCT, and ClinicalTrials.gov beside it.
 *
 * jRCT publishes no search API. What it has is the search page and a detail
 * page per study, so both are read as HTML. The markup is not a contract, and
 * the reading is written to fail loudly rather than quietly: a result page in
 * which no study ID can be found, and which does not say it found nothing, is
 * reported as unreadable — not as "no studies". Those are different answers,
 * and only one of them means the studies do not exist.
 *
 * The search address is `JRCT_SEARCH_URL` when set (with `{query}` where the
 * words go), so a change on jRCT's side is a configuration edit rather than a
 * code change. See `JRCT_DEFAULT_SEARCH_URL` for how the default was checked.
 *
 * ClinicalTrials.gov has a documented JSON API (v2) and lists many studies run
 * in Japan, some with their jRCT number as a secondary ID. It is the fallback
 * when jRCT's page cannot be read, and the source for anything international.
 */

const JRCT = 'jRCT';
const CTGOV = 'ClinicalTrials.gov';

export const JRCT_ORIGIN = 'https://jrct.mhlw.go.jp';
/**
 * `/search?keyword=` alone returns the empty search form. The form posts with a
 * CSRF token and then redirects to `/search?searched=1&page=1&…`, and that
 * address answers a plain GET with results (checked 2026-09-30: 42 study ids
 * for 喘息). `searched=1` is what makes it a search.
 */
export const JRCT_DEFAULT_SEARCH_URL = `${JRCT_ORIGIN}/search?searched=1&page=1&keyword={query}`;
const CTGOV_API = 'https://clinicaltrials.gov/api/v2/studies';
export const TRIALS_MAX_RESULTS = 50;

/** jRCT1031230123, jRCTs031180001, jRCT2031210001 … */
export const JRCT_ID = /jRCT[a-z]?\d{9,10}/g;

export function jrctDetailUrl(id: string): string {
  return `${JRCT_ORIGIN}/latest-detail/${id}`;
}

export interface TrialSummary {
  source: 'jrct' | 'clinicaltrials_gov';
  id: string;
  title: string;
  status?: string;
  conditions?: string[];
  phase?: string;
  sponsor?: string;
  startDate?: string;
  /** Other registrations of the same study (e.g. a jRCT number on ClinicalTrials.gov). */
  otherIds?: string[];
  /** For jRCT rows: the row's cells as shown, since their meaning is not fixed. */
  cells?: string[];
  url: string;
}

export interface TrialSearchResult {
  source: 'jrct' | 'clinicaltrials_gov';
  query: string;
  totalCount?: number;
  results: TrialSummary[];
  searchUrl: string;
}

export interface TrialDetail {
  source: 'jrct';
  id: string;
  title: string;
  /** Label → value, in page order, as jRCT lays the record out. */
  fields: Array<{ label: string; value: string }>;
  url: string;
}

export interface ClinicalTrialsClientOptions {
  fetch?: FetchLike;
  jrctSearchUrl?: string;
  ctgovBaseUrl?: string;
}

const NO_RESULTS = /該当する(?:データ|臨床研究|研究|試験)?[^。<]{0,10}(?:ありません|見つかりません)|検索結果[はが]?\s*0\s*件|0\s*件(?:です|が該当)|No (?:results|records) found/;

export class ClinicalTrialsClient {
  private readonly fetchImpl: FetchLike;

  constructor(private readonly options: ClinicalTrialsClientOptions = {}) {
    this.fetchImpl = options.fetch ?? ((url, init) => fetch(url, init));
  }

  async searchJrct(query: string, maxResults = 10, signal?: AbortSignal): Promise<TrialSearchResult> {
    const term = requireQuery(query, JRCT);
    const template = this.options.jrctSearchUrl || JRCT_DEFAULT_SEARCH_URL;
    if (!template.includes('{query}')) {
      throw new ExternalSourceError(JRCT, 'JRCT_SEARCH_URL に {query} が含まれていません。');
    }
    const searchUrl = template.replace('{query}', encodeURIComponent(term));
    const html = await fetchText(this.fetchImpl, JRCT, searchUrl, { headers: { Accept: 'text/html' } }, signal);
    const results = parseJrctSearch(html).slice(0, clampInt(maxResults, 10, 1, TRIALS_MAX_RESULTS));

    if (!results.length && !NO_RESULTS.test(plainText(html))) {
      throw new ExternalSourceError(
        JRCT,
        '検索結果のページを読み取れませんでした（研究番号が見つからず、「該当なし」の表示もありません）。' +
          'jRCT の画面の構成が変わった可能性があります。「該当なし」とは扱わないでください。' +
          `source=clinicaltrials_gov で探すか、JRCT_SEARCH_URL を確認してください。取得先: ${searchUrl}`
      );
    }
    return { source: 'jrct', query: term, results, searchUrl };
  }

  async fetchJrct(id: string, signal?: AbortSignal): Promise<TrialDetail> {
    const trimmed = String(id ?? '').trim();
    if (!new RegExp(`^${JRCT_ID.source}$`).test(trimmed)) {
      throw new ExternalSourceError(JRCT, `jRCT の研究番号ではありません: ${trimmed || '(空)'}（例: jRCT2031210001）`);
    }
    const url = jrctDetailUrl(trimmed);
    const html = await fetchText(this.fetchImpl, JRCT, url, { headers: { Accept: 'text/html' } }, signal);
    const detail = parseJrctDetail(html, trimmed, url);
    if (!detail.fields.length) {
      throw new ExternalSourceError(JRCT, `詳細ページから項目を読み取れませんでした: ${url}`);
    }
    return detail;
  }

  async searchClinicalTrialsGov(
    query: string,
    options: { maxResults?: number; japanOnly?: boolean } = {},
    signal?: AbortSignal
  ): Promise<TrialSearchResult> {
    const term = requireQuery(query, CTGOV);
    const params = new URLSearchParams({
      'query.term': term,
      pageSize: String(clampInt(options.maxResults, 10, 1, TRIALS_MAX_RESULTS)),
      countTotal: 'true',
      format: 'json',
    });
    if (options.japanOnly) params.set('query.locn', 'Japan');
    const searchUrl = `${this.options.ctgovBaseUrl ?? CTGOV_API}?${params.toString()}`;
    const body = await fetchJson(this.fetchImpl, CTGOV, searchUrl, { headers: { Accept: 'application/json' } }, signal);
    if (!Array.isArray(body?.studies)) {
      throw new ExternalSourceError(CTGOV, '応答に studies がありません。');
    }
    return {
      source: 'clinicaltrials_gov',
      query: term,
      totalCount: typeof body.totalCount === 'number' ? body.totalCount : undefined,
      results: body.studies.map(parseCtgovStudy).filter((s: TrialSummary | null): s is TrialSummary => s !== null),
      searchUrl,
    };
  }
}

function requireQuery(query: unknown, source: string): string {
  const term = String(query ?? '').trim();
  if (!term) throw new ExternalSourceError(source, '検索語が空です。');
  return term;
}

/**
 * Every table row that carries a jRCT number is a study.
 *
 * Deliberately structural rather than tied to class names: a row, its cells,
 * and the ID in it. The title is the text of the link to the study when there
 * is one, and the longest cell otherwise.
 */
export function parseJrctSearch(html: string): TrialSummary[] {
  const seen = new Set<string>();
  const out: TrialSummary[] = [];

  for (const row of html.matchAll(/<tr[\s>][\s\S]*?<\/tr>/gi)) {
    const markup = row[0];
    const id = markup.match(JRCT_ID)?.[0];
    if (!id || seen.has(id)) continue;
    seen.add(id);

    const cells = [...markup.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)]
      .map((c) => plainText(c[1]))
      .filter(Boolean);
    // The link on jRCT's result rows is a button reading 「閲覧」, not the title.
    // The title is the cell after the study number (checked 2026-09-30).
    const generic = /^(閲覧|詳細|表示|view|details?)$/i;
    const link = [...markup.matchAll(/<a\s[^>]*>([\s\S]*?)<\/a>/gi)]
      .map((a) => plainText(a[1]))
      .find((text) => text && !generic.test(text) && !new RegExp(`^${JRCT_ID.source}$`).test(text));
    const title = link || cells.find((c) => !c.includes(id) && !generic.test(c)) || '';

    out.push({ source: 'jrct', id, title, cells, url: jrctDetailUrl(id) });
  }
  return out;
}

/** The record is a sequence of label/value pairs, in tables or definition lists. */
export function parseJrctDetail(html: string, id: string, url: string): TrialDetail {
  const fields: Array<{ label: string; value: string }> = [];
  const push = (label: string, value: string) => {
    const l = plainText(label);
    const v = plainText(value);
    if (l && v && l !== v) fields.push({ label: l, value: v });
  };

  for (const row of html.matchAll(/<tr[\s>][\s\S]*?<\/tr>/gi)) {
    const th = row[0].match(/<th[^>]*>([\s\S]*?)<\/th>/i);
    const tds = [...row[0].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => m[1]);
    if (th && tds.length) push(th[1], tds.join(' / '));
  }
  for (const pair of html.matchAll(/<dt[^>]*>([\s\S]*?)<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/gi)) {
    push(pair[1], pair[2]);
  }

  const titleField = fields.find((f) => /研究名称|試験名称|^Scientific Title|^Public Title/i.test(f.label));
  const pageTitle = plainText(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ?? html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '');
  return { source: 'jrct', id, title: titleField?.value || pageTitle, fields, url };
}

function parseCtgovStudy(study: any): TrialSummary | null {
  const p = study?.protocolSection;
  const ident = p?.identificationModule;
  if (!ident?.nctId) return null;
  const otherIds: string[] = (ident.secondaryIdInfos || []).map((s: any) => String(s?.id ?? '')).filter(Boolean);
  const phases: string[] = p?.designModule?.phases || [];
  return {
    source: 'clinicaltrials_gov',
    id: ident.nctId,
    title: ident.briefTitle || ident.officialTitle || '',
    status: p?.statusModule?.overallStatus,
    conditions: p?.conditionsModule?.conditions,
    phase: phases.length ? phases.join(', ') : undefined,
    sponsor: p?.sponsorCollaboratorsModule?.leadSponsor?.name,
    startDate: p?.statusModule?.startDateStruct?.date,
    otherIds: otherIds.length ? otherIds : undefined,
    url: `https://clinicaltrials.gov/study/${ident.nctId}`,
  };
}
