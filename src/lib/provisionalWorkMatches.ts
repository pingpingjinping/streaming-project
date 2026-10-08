import { getDb } from './db';
import { getWorkMatchOverrides, importedLinkIsOverridden } from './workMatchOverrides';

export type CandidateLink = {
  anissiaNo: number; reanimeId: string; score: number; reason: string;
  evidence: { conflicts?: string[]; missing?: string[]; work_identity?: string; evidence?: string[]; source_seasons?:number[];target_seasons?:number[];source_parts?:number[];target_parts?:number[];
    full_native_exact?:boolean;year?:number|null;anissia_year?:number|null };
};
export function candidateIsUsable(c: CandidateLink) {
  // A numbered sequel must not fall back to the original series merely
  // because the original omits its first-season marker. Complete same-year
  // native evidence can still support named chapters as provisional links.
  for(const kind of ['season','part'] as const) {
    if(c.evidence?.missing?.includes(`${kind}_missing`)) {
      const source=kind==='season'?c.evidence.source_seasons:c.evidence.source_parts;
      const target=kind==='season'?c.evidence.target_seasons:c.evidence.target_parts;
      if(!source || !target)return false; // Reimport V4 evidence for old ambiguous rows.
      if(source.length && !target.length && !(c.evidence.full_native_exact
        && c.evidence.year && c.evidence.year===c.evidence.anissia_year))return false;
    }
  }
  return c.score >= 70 && !!c.reanimeId && Number.isSafeInteger(c.anissiaNo) && c.anissiaNo > 0
    && Array.isArray(c.evidence?.conflicts) && !c.evidence.conflicts.some(x => x!=='year_conflict');
}

/** Maximum cardinality, then maximum evidence weight. Residual paths can move an
 * earlier choice instead of letting a greedy choice strand a different work.
 * A validated work group (including duplicate provider URLs) has capacity one.
 */
export function allocateCandidateLinks(candidates: CandidateLink[], confirmed: {anissiaNo:number;reanimeId:string}[]): CandidateLink[] {
  const group = (c:CandidateLink) => c.evidence?.work_identity || `ReAnime:${c.reanimeId}`;
  const usedSources = new Set(confirmed.map(c=>c.anissiaNo));
  const usedTargets = new Set(confirmed.map(c=>c.reanimeId));
  const usedGroups = new Set(candidates.filter(c=>usedTargets.has(c.reanimeId)).map(group));
  const edges = candidates.filter(c=>candidateIsUsable(c) && !usedSources.has(c.anissiaNo)
    && !usedTargets.has(c.reanimeId) && !usedGroups.has(group(c)))
    .sort((a,b)=>a.anissiaNo-b.anissiaNo || a.reanimeId.localeCompare(b.reanimeId));
  // Solve disconnected franchises separately to bound catalog-sized work.
  const parents=new Map<string,string>();
  const find=(x:string):string=>{if(!parents.has(x))parents.set(x,x);const p=parents.get(x)!;if(p!==x)parents.set(x,find(p));return parents.get(x)!;};
  for(const c of edges)parents.set(find(`A:${c.anissiaNo}`),find(`G:${group(c)}`));
  const components=new Map<string,CandidateLink[]>();
  for(const c of edges){const key=find(`A:${c.anissiaNo}`);const component=components.get(key)||[];component.push(c);components.set(key,component);}
  if(components.size>1)return [...components.values()].flatMap(component=>allocateCandidateLinks(component,[]));
  const sources = [...new Set(edges.map(c=>c.anissiaNo))];
  const targets = [...new Set(edges.map(group))].sort();
  const sourceNodes = new Map(sources.map((x,i)=>[x,i+1]));
  const targetNodes = new Map(targets.map((x,i)=>[x,sources.length+i+1]));
  const sink = sources.length+targets.length+1;
  type Edge = {to:number;rev:number;cap:number;cost:number;candidate?:CandidateLink};
  const graph:Edge[][] = Array.from({length:sink+1},()=>[]);
  const add = (from:number,to:number,cost:number,candidate?:CandidateLink) => {
    graph[from].push({to,rev:graph[to].length,cap:1,cost,candidate});
    graph[to].push({to:from,rev:graph[from].length-1,cap:0,cost:-cost});
  };
  sources.forEach(x=>add(0,sourceNodes.get(x)!,0));
  targets.forEach(x=>add(targetNodes.get(x)!,sink,0));
  for(const c of edges) {
    const weight = c.score - (c.evidence.conflicts?.includes('year_conflict')?15:0)
      - 2*(c.evidence.missing?.length || 0);
    add(sourceNodes.get(c.anissiaNo)!,targetNodes.get(group(c))!,-weight,c);
  }
  while(true) {
    const dist=Array(graph.length).fill(Infinity),prevNode=Array(graph.length).fill(-1),prevEdge=Array(graph.length).fill(-1);
    const queued=Array(graph.length).fill(false),queue=[0];dist[0]=0;queued[0]=true;
    for(let cursor=0;cursor<queue.length;cursor++) {
      const node=queue[cursor];queued[node]=false;
      graph[node].forEach((e,i)=>{
        if(e.cap && dist[e.to]>dist[node]+e.cost) {
          dist[e.to]=dist[node]+e.cost;prevNode[e.to]=node;prevEdge[e.to]=i;
          if(!queued[e.to]){queue.push(e.to);queued[e.to]=true;}
        }
      });
    }
    if(prevNode[sink]<0)break;
    for(let node=sink;node!==0;node=prevNode[node]) {
      const e=graph[prevNode[node]][prevEdge[node]];e.cap--;graph[node][e.rev].cap++;
    }
  }
  return sources.flatMap(x=>graph[sourceNodes.get(x)!].filter(e=>e.candidate && e.cap===0).map(e=>e.candidate!));
}

/** Recalculate against current manual pins, so confirming/changing one work
 * immediately frees or reserves its peers. Never persist a candidate as confirmed.
 */
export async function getProvisionalWorkMatches(): Promise<CandidateLink[]> {
  const sql=getDb();if(!sql)return [];
  const overrides=await getWorkMatchOverrides();
  try {
    const [rows,confirmedRows]=await Promise.all([
      sql`SELECT anissia_no,reanime_id,score,reason,evidence FROM anime_monthly_match_candidates WHERE score>=70`,
      sql`SELECT anissia_no,reanime_id FROM anime_reanime_matches
        WHERE anissia_no IS NOT NULL AND review_status IN ('검토된 사항','자동확정')`,
    ]);
    const confirmed=confirmedRows.filter(r=>!importedLinkIsOverridden(overrides,String(r.reanime_id),Number(r.anissia_no)))
      .map(r=>({anissiaNo:Number(r.anissia_no),reanimeId:String(r.reanime_id)}));
    confirmed.push(...overrides);
    return allocateCandidateLinks(rows.map(r=>({anissiaNo:Number(r.anissia_no),reanimeId:String(r.reanime_id),
      score:Number(r.score),reason:String(r.reason),evidence:r.evidence})),confirmed);
  }catch(error:any) {
    if(error?.code==='42P01')return []; // Older catalog import.
    throw error;
  }
}
/** A catalog decision to withhold candidates must not be bypassed by the
 * older title heuristic or its cache (for example S4 falling back to S1). */
export async function hasWorkMatchCandidates(anissiaNo:number|null):Promise<boolean> {
  const sql=getDb();if(!sql || anissiaNo===null)return false;
  try {return (await sql`SELECT 1 FROM anime_monthly_match_candidates
    WHERE anissia_no=${anissiaNo} AND score>=70 LIMIT 1`).length>0;
  }catch(error:any){if(error?.code==='42P01')return false;throw error;}
}
/** Also protect other works from legacy title-search and playback caches. */
export async function getReservedReanimeIdsForOtherWorks(anissiaNo:number|null):Promise<Set<string>> {
  const sql=getDb();if(!sql)return new Set();
  const manual=await getWorkMatchOverrides();
  let rows:Record<string,unknown>[]=[];
  try {rows=await sql`SELECT anissia_no,reanime_id FROM anime_reanime_matches
    WHERE anissia_no IS NOT NULL AND review_status IN ('검토된 사항','자동확정')`;
  }catch(error:any){if(error?.code==='42P01')rows=[];else throw error;}
  const pairs=rows.filter(r=>!importedLinkIsOverridden(manual,String(r.reanime_id),Number(r.anissia_no)))
    .map(r=>({anissiaNo:Number(r.anissia_no),reanimeId:String(r.reanime_id)}));
  pairs.push(...manual,...await getProvisionalWorkMatches());
  return new Set(pairs.filter(c=>c.anissiaNo!==anissiaNo).map(c=>c.reanimeId));
}
export function candidateReason(reason:string):string {
  const labels:Record<string,string>={season_conflict:'시즌 번호 충돌 · 자동 연결 제외',part_conflict:'파트 번호 충돌 · 자동 연결 제외',format_conflict:'작품 형식 충돌 · 자동 연결 제외',episode_count_conflict:'화수 정보 충돌 · 자동 연결 제외',reviewed_work_reserved:'기존 검토에서 예약된 작품',year_conflict:'출시 연도가 다름',year_missing:'연도 정보 부족',
    season_missing:'시즌 표기 확인 필요',part_missing:'파트 표기 확인 필요',native_alias_needed:'원제 별칭 확인 필요',
    title_alias_needed:'제목 별칭 확인 필요',multiple_urls:'동일 작품의 여러 영상 주소',
    multiple_work_candidates:'여러 작품 후보 중 배정',external_id_unverified:'외부 작품 ID 확인 필요',
    format_missing:'작품 형식 정보 부족',metadata_missing:'작품 정보 확인 필요'};
  return labels[reason] || '작품 연결 확인 필요';
}
