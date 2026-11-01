/**
 * The research tools: PubMed, jRCT / ClinicalTrials.gov, web search.
 *
 * No network. Each service is handed a fake `fetch` that returns the shape the
 * real one documents, and the tests pin what IRIS makes of it: the fields the
 * model reads, the address the query is sent to, and — the part that matters
 * most — that a page IRIS could not read is reported as a failure and never
 * as "nothing found". Those are different answers, and only one of them means
 * the thing does not exist.
 *
 * The registry is exercised too: a 503 from a source is retried once, a 400
 * is not, and all four tools are READ so none of them waits for approval.
 *
 * Run: npx tsx scripts/test-research.ts
 */
import { PubMedClient, parseArticles, normalisePmids } from '../server/services/pubmed.js';
import {
  ClinicalTrialsClient, parseJrctSearch, parseJrctDetail, JRCT_DEFAULT_SEARCH_URL,
} from '../server/services/clinical_trials.js';
import { WebSearchClient, chooseProvider, parseDuckDuckGo } from '../server/services/web_search.js';
import { FetchLike } from '../server/services/external_http.js';
import { createResearchTools, EXTERNAL_NOTICE } from '../server/tools/research.js';
import { ToolRegistry } from '../server/tools/registry.js';
import { RiskLevel } from '../server/core/types.js';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, condition: boolean, detail?: string) {
  if (condition) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; failures.push(name); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}
function eq(name: string, actual: any, expected: any) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  check(name, ok, ok ? undefined : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
async function rejects(name: string, run: () => Promise<unknown>, pattern: RegExp) {
  try {
    await run();
    check(name, false, 'did not throw');
  } catch (err: any) {
    check(name, pattern.test(err?.message ?? ''), err?.message);
  }
}
function section(t: string) { console.log(`\n▸ ${t}`); }

interface Call { url: string; init?: RequestInit }

/** A fetch that answers from a list of routes, and records what it was asked. */
function fakeFetch(routes: Array<[RegExp, () => { status?: number; body: string }]>) {
  const calls: Call[] = [];
  const impl: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const route = routes.find(([re]) => re.test(url));
    if (!route) return new Response('not routed', { status: 404 });
    const { status = 200, body } = route[1]();
    return new Response(body, { status });
  };
  return { impl, calls };
}

const json = (value: unknown) => () => ({ body: JSON.stringify(value) });

// --- fixtures ---------------------------------------------------------------

const ESEARCH = {
  header: { type: 'esearch', version: '0.3' },
  esearchresult: {
    count: '1234', retmax: '2', retstart: '0',
    idlist: ['31978945', '32015507'],
    querytranslation: '"salbutamol"[MeSH Terms] AND "asthma"[MeSH Terms]',
  },
};

const ESUMMARY = {
  result: {
    uids: ['31978945', '32015507'],
    '31978945': {
      uid: '31978945', pubdate: '2020 Feb 20', source: 'N Engl J Med',
      fulljournalname: 'The New England journal of medicine',
      title: 'A Novel Coronavirus from Patients with Pneumonia in China, 2019.',
      authors: [{ name: 'Zhu N', authtype: 'Author' }, { name: 'Zhang D', authtype: 'Author' }],
      articleids: [{ idtype: 'pubmed', value: '31978945' }, { idtype: 'doi', value: '10.1056/NEJMoa2001017' }],
      pubtype: ['Journal Article'],
    },
    '32015507': { uid: '32015507', error: 'cannot get document summary' },
  },
};

const EFETCH = `<?xml version="1.0" ?>
<!DOCTYPE PubmedArticleSet PUBLIC "-//NLM//DTD PubMedArticle, 1st January 2024//EN" "https://dtd.nlm.nih.gov/ncbi/pubmed/out/pubmed_240101.dtd">
<PubmedArticleSet>
<PubmedArticle>
  <MedlineCitation Status="MEDLINE" Owner="NLM">
    <PMID Version="1">31978945</PMID>
    <Article PubModel="Print-Electronic">
      <Journal>
        <ISSN IssnType="Electronic">1533-4406</ISSN>
        <JournalIssue CitedMedium="Internet">
          <Volume>382</Volume><Issue>8</Issue>
          <PubDate><Year>2020</Year><Month>Feb</Month><Day>20</Day></PubDate>
        </JournalIssue>
        <Title>The New England journal of medicine</Title>
        <ISOAbbreviation>N Engl J Med</ISOAbbreviation>
      </Journal>
      <ArticleTitle>A Novel Coronavirus from Patients with Pneumonia in China, 2019.</ArticleTitle>
      <ELocationID EIdType="doi" ValidYN="Y">10.1056/NEJMoa2001017</ELocationID>
      <Abstract>
        <AbstractText Label="BACKGROUND" NlmCategory="BACKGROUND">In December 2019, a cluster of patients with pneumonia of unknown cause was linked to a seafood market in Wuhan.</AbstractText>
        <AbstractText Label="METHODS" NlmCategory="METHODS">Bronchoalveolar-lavage samples were collected &amp; analysed with <i>unbiased</i> sequencing.</AbstractText>
      </Abstract>
      <AuthorList CompleteYN="Y">
        <Author ValidYN="Y"><LastName>Zhu</LastName><ForeName>Na</ForeName><Initials>N</Initials></Author>
        <Author ValidYN="Y"><LastName>Zhang</LastName><ForeName>Dingyu</ForeName><Initials>D</Initials></Author>
        <Author ValidYN="Y"><CollectiveName>China Novel Coronavirus Investigating and Research Team</CollectiveName></Author>
      </AuthorList>
      <PublicationTypeList>
        <PublicationType UI="D016428">Journal Article</PublicationType>
      </PublicationTypeList>
    </Article>
    <MeshHeadingList>
      <MeshHeading><DescriptorName UI="D000073640" MajorTopicYN="N">Betacoronavirus</DescriptorName></MeshHeading>
      <MeshHeading><DescriptorName UI="D011024" MajorTopicYN="Y">Pneumonia, Viral</DescriptorName></MeshHeading>
    </MeshHeadingList>
  </MedlineCitation>
  <PubmedData>
    <ArticleIdList>
      <ArticleId IdType="pubmed">31978945</ArticleId>
      <ArticleId IdType="doi">10.1056/NEJMoa2001017</ArticleId>
      <ArticleId IdType="pmc">PMC7092803</ArticleId>
    </ArticleIdList>
    <ReferenceList>
      <Reference><Citation>Some earlier work.</Citation>
        <ArticleIdList><ArticleId IdType="doi">10.9999/not-this-one</ArticleId><ArticleId IdType="pmc">PMC0000000</ArticleId></ArticleIdList>
      </Reference>
    </ReferenceList>
  </PubmedData>
</PubmedArticle>
<PubmedArticle>
  <MedlineCitation Status="PubMed-not-MEDLINE" Owner="NLM">
    <PMID Version="1">11111111</PMID>
    <Article PubModel="Print">
      <Journal><JournalIssue><PubDate><MedlineDate>1998 Jan-Feb</MedlineDate></PubDate></JournalIssue><Title>Old Journal</Title></Journal>
      <ArticleTitle>An article without an abstract.</ArticleTitle>
      <AuthorList><Author><LastName>Sato</LastName><Initials>T</Initials></Author></AuthorList>
    </Article>
  </MedlineCitation>
  <PubmedData><ArticleIdList><ArticleId IdType="pubmed">11111111</ArticleId></ArticleIdList></PubmedData>
</PubmedArticle>
</PubmedArticleSet>`;

const JRCT_RESULTS = `<html><body>
<table class="table">
  <thead><tr><th>研究番号</th><th>研究名称</th><th>対象疾患名</th><th>研究の種別</th><th>進捗状況</th></tr></thead>
  <tbody>
    <tr><td>jRCT2031210001</td><td><a href="/latest-detail/jRCT2031210001">気管支喘息患者を対象とした吸入薬の第III相試験</a></td><td>気管支喘息</td><td>企業治験</td><td>募集中</td></tr>
    <tr><td>jRCTs031180001</td><td><a href="/latest-detail/jRCTs031180001">jRCTs031180001</a></td><td>小児喘息における長期管理の観察研究</td><td>特定臨床研究</td><td>募集終了</td></tr>
    <tr><td>jRCT2031210001</td><td>重複した行</td></tr>
  </tbody>
</table></body></html>`;

const JRCT_EMPTY = '<html><body><p class="alert">該当するデータがありません。</p></body></html>';
const JRCT_FORM_ONLY = '<html><body><form action="/search" method="post"><input name="_token" type="hidden"></form></body></html>';

const JRCT_DETAIL = `<html><head><title>jRCT2031210001 | jRCT</title></head><body>
<h1>臨床研究の概要</h1>
<table>
  <tr><th>研究名称</th><td>気管支喘息患者を対象とした吸入薬の第III相試験</td></tr>
  <tr><th>平易な研究名称</th><td>喘息の吸入薬の試験</td></tr>
  <tr><th>対象疾患名</th><td>気管支喘息</td></tr>
  <tr><th>主たる評価項目</th><td>12週時点の FEV<sub>1</sub> 変化量</td></tr>
</table>
<dl><dt>研究の進捗状況</dt><dd>募集中</dd></dl>
</body></html>`;

const CTGOV = {
  totalCount: 42,
  studies: [{
    protocolSection: {
      identificationModule: {
        nctId: 'NCT05000000', briefTitle: 'Inhaled Therapy in Asthma',
        secondaryIdInfos: [{ id: 'jRCT2031210001', type: 'REGISTRY', domain: 'jRCT' }],
      },
      statusModule: { overallStatus: 'RECRUITING', startDateStruct: { date: '2021-04' } },
      conditionsModule: { conditions: ['Asthma'] },
      designModule: { phases: ['PHASE3'] },
      sponsorCollaboratorsModule: { leadSponsor: { name: 'Example Pharma' } },
    },
  }, { protocolSection: {} }],
};

const DDG = `<html><body>
<div class="result results_links results_links_deep result--ad">
  <div class="links_main result__body"><h2 class="result__title">
    <a rel="nofollow" class="result__a" href="https://duckduckgo.com/y.js?ad_domain=example.com&amp;ad_provider=bing">An advert</a></h2>
    <a class="result__snippet" href="#">Buy now</a></div></div>
<div class="result results_links results_links_deep web-result ">
  <div class="links_main links_deep result__body">
    <h2 class="result__title"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.mhlw.go.jp%2Fstf%2Fseisakunitsuite%2Fbunya%2F0000.html&amp;rut=abc">厚生労働省 &amp; <b>臨床研究</b></a></h2>
    <a class="result__snippet" href="//duckduckgo.com/l/?uddg=x">臨床研究法の<b>概要</b>について</a>
  </div></div>
</body></html>`;

// --- tests ------------------------------------------------------------------

async function main() {
  section('PubMed search: esearch for the IDs, esummary for a line about each');
  {
    const { impl, calls } = fakeFetch([
      [/esearch\.fcgi/, json(ESEARCH)],
      [/esummary\.fcgi/, json(ESUMMARY)],
    ]);
    const pubmed = new PubMedClient({ fetch: impl, apiKey: 'k123' });
    const found = await pubmed.search('salbutamol asthma', { maxResults: 2, sort: 'pub_date', minDate: '2019' });

    eq('the total is PubMed\'s count, not the page size', found.totalCount, 1234);
    eq('how PubMed read the query is passed on', found.queryTranslation, ESEARCH.esearchresult.querytranslation);
    eq('a summary PubMed could not produce is left out rather than invented', found.results.map((r) => r.pmid), ['31978945']);
    const first = found.results[0];
    eq('the journal is the full name', first.journal, 'The New England journal of medicine');
    eq('authors come through', first.authors, ['Zhu N', 'Zhang D']);
    eq('the DOI is picked out of the article IDs', first.doi, '10.1056/NEJMoa2001017');
    eq('and every result links to PubMed', first.url, 'https://pubmed.ncbi.nlm.nih.gov/31978945/');

    const q = new URL(calls[0].url).searchParams;
    eq('the query is sent as the term', q.get('term'), 'salbutamol asthma');
    eq('sorting is passed', q.get('sort'), 'pub_date');
    eq('a one-ended date range is completed, since esearch ignores half of one', [q.get('mindate'), q.get('maxdate'), q.get('datetype')], ['2019', '3000', 'pdat']);
    eq('the API key is sent when there is one', q.get('api_key'), 'k123');
    check('no email is sent unless configured', !q.has('email'));
    eq('esummary is asked about exactly the IDs found', new URL(calls[1].url).searchParams.get('id'), '31978945,32015507');
  }

  {
    const { impl, calls } = fakeFetch([[/esearch\.fcgi/, json({ esearchresult: { count: '0', idlist: [] } })]]);
    const found = await new PubMedClient({ fetch: impl }).search('zzzznothing');
    eq('no hits is an empty list with a zero count', [found.totalCount, found.results.length], [0, 0]);
    eq('and no esummary call is made for nothing', calls.length, 1);
  }

  await rejects('an empty query is refused before anything is sent', () => new PubMedClient({ fetch: fakeFetch([]).impl }).search('  '), /検索語が空/);
  await rejects('a malformed date is refused', () => new PubMedClient({ fetch: fakeFetch([]).impl }).search('x', { minDate: '19-01' }), /日付の形式/);
  await rejects(
    'an esearch error is reported as one',
    () => new PubMedClient({ fetch: fakeFetch([[/esearch/, json({ esearchresult: { ERROR: 'Invalid query' } })]]).impl }).search('x'),
    /Invalid query/
  );

  section('PubMed fetch: the abstract, from efetch XML');
  {
    const articles = parseArticles(EFETCH);
    eq('both articles are read', articles.map((a) => a.pmid), ['31978945', '11111111']);
    const a = articles[0];
    eq('the title', a.title, 'A Novel Coronavirus from Patients with Pneumonia in China, 2019.');
    eq('structured abstract keeps its labels', a.abstract.map((s) => s.label), ['BACKGROUND', 'METHODS']);
    eq('markup and entities are cleaned out of the text', a.abstract[1].text, 'Bronchoalveolar-lavage samples were collected & analysed with unbiased sequencing.');
    eq('authors, including a collective one', a.authors, ['Na Zhu', 'Dingyu Zhang', 'China Novel Coronavirus Investigating and Research Team']);
    eq('the date and year', [a.pubDate, a.year], ['2020 Feb 20', '2020']);
    eq('the DOI is the article\'s, not a reference\'s', a.doi, '10.1056/NEJMoa2001017');
    eq('and so is the PMC ID', a.pmcid, 'PMC7092803');
    eq('MeSH terms', a.meshTerms, ['Betacoronavirus', 'Pneumonia, Viral']);

    const b = articles[1];
    eq('an article without an abstract has an empty one', b.abstract, []);
    eq('a MedlineDate is used as the date, and its year extracted', [b.pubDate, b.year], ['1998 Jan-Feb', '1998']);
    eq('initials stand in for a missing given name', b.authors, ['T Sato']);
  }
  {
    const { impl, calls } = fakeFetch([[/efetch\.fcgi/, () => ({ body: EFETCH })]]);
    const got = await new PubMedClient({ fetch: impl }).fetch(['31978945', 'PMID: 11111111', '22222222']);
    eq('a PMID PubMed did not return is named as not found', got.notFound, ['22222222']);
    eq('the "PMID:" prefix is tolerated', new URL(calls[0].url).searchParams.get('id'), '31978945,11111111,22222222');
    eq('abstracts are asked for as XML', new URL(calls[0].url).searchParams.get('retmode'), 'xml');
  }
  eq('PMIDs may arrive as one string', normalisePmids('1, 2 3'), ['1', '2', '3']);
  await rejects('a PMID that is not a number is refused', async () => normalisePmids(['10.1056/abc']), /PMID は数字/);
  await rejects('too many PMIDs at once is refused', async () => normalisePmids(Array.from({ length: 21 }, (_, i) => String(i + 1))), /20 件まで/);

  section('jRCT search: rows that carry a study number');
  {
    const rows = parseJrctSearch(JRCT_RESULTS);
    eq('each study once, in page order', rows.map((r) => r.id), ['jRCT2031210001', 'jRCTs031180001']);
    eq('the title is the link text', rows[0].title, '気管支喘息患者を対象とした吸入薬の第III相試験');
    eq('when the link is only the number, the longest other cell stands in', rows[1].title, '小児喘息における長期管理の観察研究');
    eq('the cells are kept as shown', rows[0].cells, ['jRCT2031210001', '気管支喘息患者を対象とした吸入薬の第III相試験', '気管支喘息', '企業治験', '募集中']);
    eq('and each links to its detail page', rows[0].url, 'https://jrct.mhlw.go.jp/latest-detail/jRCT2031210001');
  }
  {
    // The live site's shape: the only link in the row is a 「閲覧」 button.
    const live = '<table><tr><td>jRCT2032260549</td><td>Ｒｏｔａｒｅｘ使用成績調査</td><td>大腿膝窩動脈の血栓性病変（慢性閉塞性病変は除く）</td><td>募集前</td><td>令和8年9月30日</td><td><a href="/latest-detail/jRCT2032260549">閲覧</a></td></tr></table>';
    eq('a 「閲覧」 button is not taken for the title', parseJrctSearch(live)[0].title, 'Ｒｏｔａｒｅｘ使用成績調査');
  }
  {
    const { impl, calls } = fakeFetch([[/jrct/, () => ({ body: JRCT_RESULTS })]]);
    const found = await new ClinicalTrialsClient({ fetch: impl }).searchJrct('気管支喘息', 1);
    eq('maxResults is honoured', found.results.length, 1);
    eq('the query is URL-encoded into the default address', calls[0].url, JRCT_DEFAULT_SEARCH_URL.replace('{query}', encodeURIComponent('気管支喘息')));
  }
  {
    const { impl, calls } = fakeFetch([[/example\.test/, () => ({ body: JRCT_RESULTS })]]);
    await new ClinicalTrialsClient({ fetch: impl, jrctSearchUrl: 'https://example.test/s?q={query}&x=1' }).searchJrct('喘息');
    eq('JRCT_SEARCH_URL replaces the address', calls[0].url, `https://example.test/s?q=${encodeURIComponent('喘息')}&x=1`);
  }
  {
    const found = await new ClinicalTrialsClient({ fetch: fakeFetch([[/jrct/, () => ({ body: JRCT_EMPTY })]]).impl }).searchJrct('存在しない疾患');
    eq('a page that says it found nothing is an empty result', found.results, []);
  }
  await rejects(
    'a page with no studies that does not say "none" is unreadable, not empty',
    () => new ClinicalTrialsClient({ fetch: fakeFetch([[/jrct/, () => ({ body: JRCT_FORM_ONLY })]]).impl }).searchJrct('喘息'),
    /読み取れませんでした[\s\S]*該当なし」とは扱わないで/
  );
  await rejects(
    'a JRCT_SEARCH_URL without {query} is refused',
    () => new ClinicalTrialsClient({ fetch: fakeFetch([]).impl, jrctSearchUrl: 'https://example.test/s' }).searchJrct('x'),
    /\{query\}/
  );

  section('jRCT detail: the record as label/value pairs');
  {
    const d = parseJrctDetail(JRCT_DETAIL, 'jRCT2031210001', 'u');
    eq('the title is the registered study name', d.title, '気管支喘息患者を対象とした吸入薬の第III相試験');
    eq('table rows and definition lists are both read', d.fields.map((f) => f.label), ['研究名称', '平易な研究名称', '対象疾患名', '主たる評価項目', '研究の進捗状況']);
    eq('markup inside a value is flattened', d.fields[3].value, '12週時点の FEV 1 変化量');
  }
  {
    const { impl, calls } = fakeFetch([[/latest-detail/, () => ({ body: JRCT_DETAIL })]]);
    await new ClinicalTrialsClient({ fetch: impl }).fetchJrct(' jRCT2031210001 ');
    eq('the detail page is the latest-detail address', calls[0].url, 'https://jrct.mhlw.go.jp/latest-detail/jRCT2031210001');
  }
  await rejects('a string that is not a jRCT number is refused', () => new ClinicalTrialsClient({ fetch: fakeFetch([]).impl }).fetchJrct('NCT05000000'), /研究番号ではありません/);
  await rejects(
    'a detail page with nothing readable is an error',
    () => new ClinicalTrialsClient({ fetch: fakeFetch([[/latest-detail/, () => ({ body: '<html></html>' })]]).impl }).fetchJrct('jRCT2031210001'),
    /読み取れませんでした/
  );

  section('ClinicalTrials.gov: the documented v2 API');
  {
    const { impl, calls } = fakeFetch([[/clinicaltrials\.gov/, json(CTGOV)]]);
    const found = await new ClinicalTrialsClient({ fetch: impl }).searchClinicalTrialsGov('asthma', { maxResults: 5, japanOnly: true });
    eq('the total count', found.totalCount, 42);
    eq('a study without an ID is dropped', found.results.length, 1);
    const s = found.results[0];
    eq('its fields', [s.id, s.title, s.status, s.phase, s.sponsor, s.startDate], ['NCT05000000', 'Inhaled Therapy in Asthma', 'RECRUITING', 'PHASE3', 'Example Pharma', '2021-04']);
    eq('a jRCT number registered alongside is surfaced', s.otherIds, ['jRCT2031210001']);
    const q = new URL(calls[0].url).searchParams;
    eq('japanOnly filters by location', q.get('query.locn'), 'Japan');
    eq('the page size is the requested count', q.get('pageSize'), '5');
  }

  section('Web search: which provider answers');
  eq('an explicit choice wins', chooseProvider({ provider: 'Brave', tavilyApiKey: 't' }), 'brave');
  eq('otherwise Tavily when it has a key', chooseProvider({ tavilyApiKey: 't', braveApiKey: 'b' }), 'tavily');
  eq('then Brave', chooseProvider({ braveApiKey: 'b' }), 'brave');
  eq('and DuckDuckGo needs no key', chooseProvider({}), 'duckduckgo');
  await rejects('an unknown provider name is an error, not a silent fallback', async () => chooseProvider({ provider: 'google' }), /WEB_SEARCH_PROVIDER が不明/);
  await rejects(
    'choosing a provider without its key says which key',
    () => new WebSearchClient({ provider: 'tavily', fetch: fakeFetch([]).impl }).search('x'),
    /TAVILY_API_KEY/
  );

  section('Web search: Tavily');
  {
    const { impl, calls } = fakeFetch([[/api\.tavily\.com/, json({
      query: 'q', answer: '要約です。',
      results: [{ title: 'T', url: 'https://a.example/', content: 'x'.repeat(800), score: 0.9, published_date: '2026-09-01' }],
    })]]);
    const found = await new WebSearchClient({ tavilyApiKey: 'tv-1', fetch: impl }).search('臨床研究法 改正', { maxResults: 3, recency: 'month' });
    eq('the provider is named', found.provider, 'tavily');
    eq('Tavily\'s answer is kept', found.answer, '要約です。');
    check('a long snippet is cut short', found.results[0].snippet.length <= 501 && found.results[0].snippet.endsWith('…'));
    eq('the publication date is kept', found.results[0].published, '2026-09-01');
    const sent = JSON.parse(String(calls[0].init?.body));
    eq('the request carries the query, count and time range', [sent.query, sent.max_results, sent.time_range], ['臨床研究法 改正', 3, 'month']);
    eq('the key goes in the Authorization header', (calls[0].init?.headers as any)?.Authorization, 'Bearer tv-1');
    check('and not in the body', !('api_key' in sent));
  }

  section('Web search: Brave');
  {
    const { impl, calls } = fakeFetch([[/api\.search\.brave\.com/, json({
      web: { results: [{ title: '<strong>IRIS</strong> docs', url: 'https://b.example/', description: 'The <strong>best</strong> page', age: '2 days ago' }] },
    })]]);
    const found = await new WebSearchClient({ braveApiKey: 'br-1', fetch: impl }).search('iris', { recency: 'week' });
    eq('markup is stripped from title and snippet', [found.results[0].title, found.results[0].snippet], ['IRIS docs', 'The best page']);
    eq('the key is the subscription token', (calls[0].init?.headers as any)?.['X-Subscription-Token'], 'br-1');
    eq('recency maps to Brave\'s freshness', new URL(calls[0].url).searchParams.get('freshness'), 'pw');
  }
  {
    const found = await new WebSearchClient({ braveApiKey: 'b', fetch: fakeFetch([[/brave/, json({ query: {} })]]).impl }).search('zzz');
    eq('a Brave answer with no web section is no results', found.results, []);
  }

  section('Web search: DuckDuckGo, read from HTML');
  {
    const hits = parseDuckDuckGo(DDG);
    eq('adverts are skipped', hits.length, 1);
    eq('the redirect is unwrapped to the real address', hits[0].url, 'https://www.mhlw.go.jp/stf/seisakunitsuite/bunya/0000.html');
    eq('title and snippet are plain text', [hits[0].title, hits[0].snippet], ['厚生労働省 & 臨床研究', '臨床研究法の 概要 について']);
  }
  {
    const found = await new WebSearchClient({ fetch: fakeFetch([[/duckduckgo/, () => ({ body: DDG })]]).impl }).search('臨床研究');
    eq('with no key, DuckDuckGo answers', [found.provider, found.results.length], ['duckduckgo', 1]);
  }
  {
    const found = await new WebSearchClient({ fetch: fakeFetch([[/duckduckgo/, () => ({ body: '<div class="no-results">No results.</div>' })]]).impl }).search('zzzz');
    eq('a page that says "no results" is an empty search', found.results, []);
  }
  await rejects(
    'a bot check or changed page is a failure, not an empty search',
    () => new WebSearchClient({ fetch: fakeFetch([[/duckduckgo/, () => ({ body: '<html><form id="challenge-form"></form></html>' })]]).impl }).search('x'),
    /読み取れませんでした/
  );

  section('The tools, through the registry');
  {
    let esearchCalls = 0;
    const { impl } = fakeFetch([
      [/esearch\.fcgi/, () => (++esearchCalls === 1 ? { status: 503, body: 'Service Unavailable' } : { body: JSON.stringify(ESEARCH) })],
      [/esummary\.fcgi/, json(ESUMMARY)],
      [/efetch\.fcgi/, () => ({ body: EFETCH })],
      [/jrct/, () => ({ status: 400, body: 'Bad Request' })],
      [/duckduckgo/, () => ({ body: DDG })],
    ]);
    const registry = new ToolRegistry();
    registry.registerAll(createResearchTools({
      pubmed: new PubMedClient({ fetch: impl }),
      trials: new ClinicalTrialsClient({ fetch: impl }),
      web: new WebSearchClient({ fetch: impl }),
    }));

    const described = registry.describe().filter((t) => ['pubmed_search', 'pubmed_fetch', 'jrct_search', 'web_search'].includes(t.name));
    eq('all four are registered', described.length, 4);
    check('all four are READ and need no approval', described.every((t) => t.riskLevel === RiskLevel.READ && !t.requiresApproval));
    check(
      'each search tool says its query leaves the machine',
      ['pubmed_search', 'jrct_search', 'web_search'].every((n) => registry.get(n)!.description.includes('外部サービスに送信'))
    );

    const search = await registry.executeTool('pubmed_search', { query: 'salbutamol' }, { timeoutMs: 5_000 });
    eq('a 503 from PubMed is retried once and then succeeds', [search.error, search.attempts], [undefined, 2]);
    eq('the result carries the notice about third-party text', search.result?.notice, EXTERNAL_NOTICE);
    eq('and says how many it returned', search.result?.returned, 1);

    const fetched = await registry.executeTool('pubmed_fetch', { pmids: ['11111111'] }, { timeoutMs: 5_000 });
    eq('an article without an abstract says so in words', fetched.result?.articles?.find((a: any) => a.pmid === '11111111')?.abstract, '（PubMed にアブストラクトがありません）');

    const bad = await registry.executeTool('jrct_search', { query: '喘息' }, { timeoutMs: 5_000 });
    eq('a 400 is not retried', bad.attempts, 1);
    check('and the error names the source and status', /jRCT: HTTP 400/.test(bad.error ?? ''), bad.error);

    const web = await registry.executeTool('web_search', { query: '臨床研究' }, { timeoutMs: 5_000 });
    eq('web_search answers through the configured provider', web.result?.provider, 'duckduckgo');
  }

  console.log('\n' + '─'.repeat(60));
  console.log(`Research tools: ${passed} passed, ${failed} failed`);
  if (failed) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log('All research tool tests passed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
