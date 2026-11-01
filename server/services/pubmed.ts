import {
  ExternalSourceError, FetchLike, clampInt, decodeEntities, fetchJson, fetchText, plainText,
} from './external_http.js';

/**
 * PubMed through NCBI E-utilities.
 *
 * Search is two calls: esearch for the PMIDs, esummary for a line about each.
 * The abstract is not in esummary, so reading one is a third call (efetch,
 * XML) made only when asked — a search listing twenty abstracts would be
 * mostly text the model skims past.
 *
 * No key is needed. Without one NCBI allows 3 requests a second, with
 * `NCBI_API_KEY` 10. `NCBI_EMAIL` is sent as `email` only when set: NCBI asks
 * for a contact address, and the user's address is not IRIS's to hand out.
 */

const SOURCE = 'PubMed';
const EUTILS = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';
export const PUBMED_MAX_RESULTS = 50;
export const PUBMED_MAX_FETCH = 20;

export interface PubMedSummary {
  pmid: string;
  title: string;
  journal: string;
  pubDate: string;
  authors: string[];
  doi?: string;
  publicationTypes: string[];
  url: string;
}

export interface PubMedArticle {
  pmid: string;
  title: string;
  journal: string;
  pubDate: string;
  year?: string;
  authors: string[];
  /** Section by section, as PubMed structures it. Unlabelled text has no label. */
  abstract: Array<{ label?: string; text: string }>;
  doi?: string;
  pmcid?: string;
  publicationTypes: string[];
  meshTerms: string[];
  keywords: string[];
  url: string;
}

export interface PubMedSearchOptions {
  maxResults?: number;
  sort?: 'relevance' | 'pub_date';
  /** YYYY, YYYY/MM or YYYY/MM/DD. Both ends are needed; a missing one is filled. */
  minDate?: string;
  maxDate?: string;
}

export interface PubMedSearchResult {
  query: string;
  /** How PubMed read the query, e.g. with MeSH expansion. */
  queryTranslation?: string;
  totalCount: number;
  results: PubMedSummary[];
}

export interface PubMedClientOptions {
  fetch?: FetchLike;
  apiKey?: string;
  email?: string;
  baseUrl?: string;
}

export function pubmedUrl(pmid: string): string {
  return `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`;
}

const DATE = /^\d{4}(\/\d{1,2}(\/\d{1,2})?)?$/;

export class PubMedClient {
  private readonly fetchImpl: FetchLike;
  private readonly baseUrl: string;

  constructor(private readonly options: PubMedClientOptions = {}) {
    this.fetchImpl = options.fetch ?? ((url, init) => fetch(url, init));
    this.baseUrl = options.baseUrl ?? EUTILS;
  }

  private url(endpoint: string, params: Record<string, string>): string {
    const search = new URLSearchParams({ db: 'pubmed', ...params, tool: 'iris' });
    if (this.options.apiKey) search.set('api_key', this.options.apiKey);
    if (this.options.email) search.set('email', this.options.email);
    return `${this.baseUrl}/${endpoint}?${search.toString()}`;
  }

  async search(query: string, options: PubMedSearchOptions = {}, signal?: AbortSignal): Promise<PubMedSearchResult> {
    const term = String(query ?? '').trim();
    if (!term) throw new ExternalSourceError(SOURCE, '検索語が空です。');

    const params: Record<string, string> = {
      term,
      retmode: 'json',
      retmax: String(clampInt(options.maxResults, 10, 1, PUBMED_MAX_RESULTS)),
      sort: options.sort === 'pub_date' ? 'pub_date' : 'relevance',
    };
    if (options.minDate || options.maxDate) {
      for (const d of [options.minDate, options.maxDate]) {
        if (d && !DATE.test(d)) throw new ExternalSourceError(SOURCE, `日付の形式が不正です: ${d}（YYYY、YYYY/MM、YYYY/MM/DD）`);
      }
      // esearch ignores a date range with only one end.
      params.datetype = 'pdat';
      params.mindate = options.minDate || '1800';
      params.maxdate = options.maxDate || '3000';
    }

    const found = await fetchJson(this.fetchImpl, SOURCE, this.url('esearch.fcgi', params), {}, signal);
    const result = found?.esearchresult;
    if (!result) throw new ExternalSourceError(SOURCE, 'esearch の応答に esearchresult がありません。');
    if (result.ERROR) throw new ExternalSourceError(SOURCE, String(result.ERROR));

    const ids: string[] = Array.isArray(result.idlist) ? result.idlist.map(String) : [];
    const summaries = ids.length ? await this.summaries(ids, signal) : [];

    return {
      query: term,
      queryTranslation: result.querytranslation || undefined,
      totalCount: parseInt(result.count, 10) || 0,
      results: summaries,
    };
  }

  private async summaries(ids: string[], signal?: AbortSignal): Promise<PubMedSummary[]> {
    const body = await fetchJson(
      this.fetchImpl, SOURCE,
      this.url('esummary.fcgi', { id: ids.join(','), retmode: 'json' }),
      {}, signal
    );
    return parseSummaries(body, ids);
  }

  /** Abstracts and details for up to PUBMED_MAX_FETCH PMIDs. */
  async fetch(pmids: string[], signal?: AbortSignal): Promise<{ articles: PubMedArticle[]; notFound: string[] }> {
    const ids = normalisePmids(pmids);
    const xml = await fetchText(
      this.fetchImpl, SOURCE,
      this.url('efetch.fcgi', { id: ids.join(','), retmode: 'xml', rettype: 'abstract' }),
      {}, signal
    );
    const articles = parseArticles(xml);
    const seen = new Set(articles.map((a) => a.pmid));
    return { articles, notFound: ids.filter((id) => !seen.has(id)) };
  }
}

export function normalisePmids(pmids: unknown): string[] {
  const list = (Array.isArray(pmids) ? pmids : String(pmids ?? '').split(/[\s,]+/))
    .map((p) => String(p).trim().replace(/^PMID:?\s*/i, ''))
    .filter(Boolean);
  if (!list.length) throw new ExternalSourceError(SOURCE, 'PMID が指定されていません。');
  const invalid = list.filter((p) => !/^\d{1,9}$/.test(p));
  if (invalid.length) throw new ExternalSourceError(SOURCE, `PMID は数字です: ${invalid.join(', ')}`);
  const unique = [...new Set(list)];
  if (unique.length > PUBMED_MAX_FETCH) {
    throw new ExternalSourceError(SOURCE, `一度に取得できるのは ${PUBMED_MAX_FETCH} 件までです（${unique.length} 件指定）。`);
  }
  return unique;
}

export function parseSummaries(body: any, ids: string[]): PubMedSummary[] {
  const result = body?.result;
  if (!result) throw new ExternalSourceError(SOURCE, 'esummary の応答に result がありません。');
  const order: string[] = Array.isArray(result.uids) ? result.uids.map(String) : ids;

  const out: PubMedSummary[] = [];
  for (const uid of order) {
    const item = result[uid];
    if (!item || item.error) continue;
    const doi = (item.articleids || []).find((a: any) => a?.idtype === 'doi')?.value;
    out.push({
      pmid: String(item.uid ?? uid),
      title: decodeEntities(String(item.title ?? '')).trim(),
      journal: String(item.fulljournalname || item.source || ''),
      pubDate: String(item.pubdate || item.epubdate || ''),
      authors: (item.authors || []).map((a: any) => String(a?.name ?? '')).filter(Boolean),
      doi: doi || undefined,
      publicationTypes: Array.isArray(item.pubtype) ? item.pubtype.map(String) : [],
      url: pubmedUrl(String(item.uid ?? uid)),
    });
  }
  return out;
}

// --- efetch XML -----------------------------------------------------------
// PubMed's XML is regular and machine-generated, so a handful of patterns
// read it without adding a parser dependency. What they must not do is pick
// up the DOIs of an article's references, which carry the same element names;
// the reference list is removed before anything else is read.

function first(xml: string, tag: string): string | undefined {
  const m = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`));
  return m ? m[1] : undefined;
}

function all(xml: string, tag: string): Array<{ attrs: string; inner: string }> {
  const re = new RegExp(`<${tag}(\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'g');
  const out: Array<{ attrs: string; inner: string }> = [];
  for (const m of xml.matchAll(re)) out.push({ attrs: m[1] ?? '', inner: m[2] });
  return out;
}

function attr(attrs: string, name: string): string | undefined {
  const m = attrs.match(new RegExp(`${name}="([^"]*)"`));
  return m ? decodeEntities(m[1]) : undefined;
}

export function parseArticles(xml: string): PubMedArticle[] {
  const blocks = all(xml, 'PubmedArticle').map((b) => b.inner);
  return blocks.map(parseArticle).filter((a): a is PubMedArticle => a !== null);
}

function parseArticle(raw: string): PubMedArticle | null {
  const xml = raw.replace(/<ReferenceList>[\s\S]*?<\/ReferenceList>/g, '');
  const citation = first(xml, 'MedlineCitation') ?? xml;
  const pmid = first(citation, 'PMID')?.trim();
  if (!pmid) return null;

  const article = first(citation, 'Article') ?? citation;
  const journal = first(article, 'Journal') ?? '';
  const pubDateXml = first(journal, 'PubDate') ?? '';
  const year = first(pubDateXml, 'Year')?.trim();
  const medlineDate = first(pubDateXml, 'MedlineDate')?.trim();
  const pubDate = medlineDate
    || [year, first(pubDateXml, 'Month')?.trim(), first(pubDateXml, 'Day')?.trim()].filter(Boolean).join(' ');

  const authors = all(first(article, 'AuthorList') ?? '', 'Author').map(({ inner }) => {
    const collective = first(inner, 'CollectiveName');
    if (collective) return plainText(collective);
    const last = first(inner, 'LastName');
    const given = first(inner, 'ForeName') ?? first(inner, 'Initials');
    return plainText([given, last].filter(Boolean).join(' '));
  }).filter(Boolean);

  const abstract = all(first(article, 'Abstract') ?? '', 'AbstractText').map(({ attrs, inner }) => ({
    label: attr(attrs, 'Label'),
    text: plainText(inner),
  })).filter((s) => s.text);

  const pubmedData = first(xml, 'PubmedData') ?? '';
  const articleIds = all(pubmedData, 'ArticleId');
  const idOf = (type: string) => {
    const hit = articleIds.find((a) => attr(a.attrs, 'IdType') === type);
    return hit ? plainText(hit.inner) : undefined;
  };
  const elocationDoi = all(article, 'ELocationID').find((e) => attr(e.attrs, 'EIdType') === 'doi');

  return {
    pmid,
    title: plainText(first(article, 'ArticleTitle') ?? first(article, 'VernacularTitle') ?? ''),
    journal: plainText(first(journal, 'Title') ?? ''),
    pubDate,
    year: year || medlineDate?.match(/\d{4}/)?.[0],
    authors,
    abstract,
    doi: idOf('doi') ?? (elocationDoi ? plainText(elocationDoi.inner) : undefined),
    pmcid: idOf('pmc'),
    publicationTypes: all(article, 'PublicationType').map((p) => plainText(p.inner)),
    meshTerms: all(first(citation, 'MeshHeadingList') ?? '', 'DescriptorName').map((d) => plainText(d.inner)),
    keywords: all(first(citation, 'KeywordList') ?? '', 'Keyword').map((k) => plainText(k.inner)),
    url: pubmedUrl(pmid),
  };
}
