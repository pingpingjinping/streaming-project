/** Verified source identities only: never merge works solely from title similarity. */
export type Source = "Anissia" | "ReAnime" | "AniList" | "Onnada" | "Anikoto";
export type WorkRef = { source: Source; id: string };
export type KoreanLink = WorkRef & { status: string; anilistId?: string; reanimeId?: string };
export type ReanimeLink = { reanimeId: string; anissiaNo: number; reviewStatus: string };
export type ManualLink = { reanimeId: string; anissiaNo: number };
export type CrossLink = { reanimeId: string; anilistId: string; compatible: boolean };
export type AnikotoLink = { anikotoId: string; target: WorkRef; status: string; mappingKind: string };
export type ReleasedGroup = { members: string[] };
export type SourceWork = WorkRef & { animeId: string; title: string; year: string; format?: string };
export type WorkGroup = { animeId: string; title: string; year: string; members: SourceWork[]; multiAnikotoIds: string[] };

const canonical = (source: Source, id: string) =>
  source === "Anissia" ? "ani_" + id : source === "ReAnime" ? "re_" + id
    : source === "Anikoto" ? "ak_" + id : "db_" + source + "_" + id;
const sourcePriority = (source: Source) =>
  ({ Anissia: 0, ReAnime: 1, AniList: 2, Onnada: 3, Anikoto: 4 })[source];
const idOf = (ref: WorkRef) => ref.source + ":" + ref.id;
const accepted = (value: string) => ["검토된 사항", "자동확정"].includes(value);
const verifiedAnikoto = (value: string) => ["reviewed", "automatic", "multi_reviewed"].includes(value);

/** Finds connected core DB components. Anikoto is deliberately NOT a union edge:
 * one Anikoto URL may cover several separately reviewed seasons. */
export function buildReviewedWorkGroups(input: {
  seeds: WorkRef[]; catalog: SourceWork[];
  korean: KoreanLink[]; reanime: ReanimeLink[]; manual: ManualLink[];
  cross: CrossLink[]; anikoto: AnikotoLink[]; release?: ReleasedGroup[];
  limit?: number; hydrateMissing?: boolean;
}): WorkGroup[] {
  const parents = new Map<string,string>();
  const find = (key:string):string => {
    if(!parents.has(key)) parents.set(key,key);
    const p=parents.get(key)!;
    if(p!==key)parents.set(key,find(p));
    return parents.get(key)!;
  };
  const union=(a:WorkRef,b:WorkRef)=>{
    if(a.source==="Anikoto"||b.source==="Anikoto")return;
    const x=find(idOf(a)),y=find(idOf(b));if(x!==y)parents.set(y,x);
  };
  const manualRe=new Set(input.manual.map(x=>x.reanimeId));
  const manualAn=new Set(input.manual.map(x=>String(x.anissiaNo)));
  for(const row of input.korean) {
    if(!accepted(row.status))continue;
    if(row.anilistId)union(row,{source:"AniList",id:row.anilistId});
    // A manual ReAnime↔Anissia correction must not be undone by a stale
    // imported catalog edge.
    if(row.reanimeId) {
      const fromAnissia=row.source==="Anissia";
      const claimedByDifferentAnissia=fromAnissia && manualAn.has(row.id) &&
        !input.manual.some(m=>String(m.anissiaNo)===row.id && m.reanimeId===row.reanimeId);
      const claimedByDifferentReanime=fromAnissia && manualRe.has(row.reanimeId) &&
        !input.manual.some(m=>String(m.anissiaNo)===row.id && m.reanimeId===row.reanimeId);
      if(!claimedByDifferentAnissia&&!claimedByDifferentReanime)
        union(row,{source:"ReAnime",id:row.reanimeId});
    }
  }
  for(const r of input.reanime) {
    if(!accepted(r.reviewStatus) || !r.anissiaNo || manualRe.has(r.reanimeId) ||
      manualAn.has(String(r.anissiaNo)))continue;
    union({source:"Anissia",id:String(r.anissiaNo)},{source:"ReAnime",id:r.reanimeId});
  }
  for(const r of input.manual)
    union({source:"Anissia",id:String(r.anissiaNo)},{source:"ReAnime",id:r.reanimeId});
  for(const r of input.cross) {
    if(r.compatible)union({source:"ReAnime",id:r.reanimeId},{source:"AniList",id:r.anilistId});
  }

  // Month-end release groups persist reviewed cross-source identities across
  // Pi restoration. They are never inferred from matching titles.
  const decode=(key:string):WorkRef|null=>{
    if(/^ani_[1-9]\d*$/.test(key))return {source:"Anissia",id:key.slice(4)};
    if(/^re_[A-Za-z0-9_-]+$/.test(key))return {source:"ReAnime",id:key.slice(3)};
    if(/^ak_[A-Za-z0-9_-]+$/.test(key))return {source:"Anikoto",id:key.slice(3)};
    const m=/^db_(AniList|Onnada)_([A-Za-z0-9_-]+)$/.exec(key);
    return m?{source:m[1] as Source,id:m[2]}:null;
  };
  for(const group of input.release||[]) {
    const refs=group.members.map(decode).filter((x):x is WorkRef=>!!x);
    if(refs.length!==group.members.length)continue;
    const anissia=refs.find(x=>x.source==="Anissia");
    const reanime=refs.find(x=>x.source==="ReAnime");
    // If a newer administrator correction contradicts this older monthly
    // release group, keep the newer Pi correction rather than the stale edge.
    if(anissia&&reanime&&input.manual.some(m=>
      (String(m.anissiaNo)===anissia.id&&m.reanimeId!==reanime.id) ||
      (m.reanimeId===reanime.id&&String(m.anissiaNo)!==anissia.id)))continue;
    const core=refs.filter(x=>x.source!=="Anikoto");
    for(const ref of core.slice(1))union(core[0],ref);
  }

  // The import's lookup may include the same Anikoto ID in multiple work groups.
  // Keep that item visible in both cards but NEVER collapse the two core groups.
  const links=new Map<string,Set<string>>();
  for(const r of input.anikoto) {
    if(!verifiedAnikoto(r.status) || r.target.source==="Anikoto")continue;
    const root=find(idOf(r.target)),key="ak_"+r.anikotoId;
    if(!links.has(key))links.set(key,new Set());
    links.get(key)!.add(root);
  }
  for(const group of input.release||[]) {
    const refs=group.members.map(decode).filter((x):x is WorkRef=>!!x);
    const core=refs.find(ref=>ref.source!=="Anikoto");
    if(!core)continue;
    const root=find(idOf(core));
    for(const ref of refs)if(ref.source==="Anikoto") {
      const key="ak_"+ref.id;
      if(!links.has(key))links.set(key,new Set());
      links.get(key)!.add(root);
    }
  }
  const seeds=new Set<string>();
  for(const row of input.seeds) {
    if(row.source==="Anikoto") {
      const roots=links.get(canonical(row.source,row.id));
      if(roots?.size)for(const root of roots)seeds.add(root);
      else seeds.add("isolated:ak_"+row.id);
    } else seeds.add(find(idOf(row)));
  }
  const hydrated=new Map(input.catalog.map(row=>[idOf(row),row]));
  // Preserve known verified source IDs while initial search results are being
  // expanded; a second pass hydrates those IDs with real catalog titles.
  for(const key of (input.hydrateMissing?parents.keys():[]))if(!hydrated.has(key)) {
    const cut=key.indexOf(":");
    const source=key.slice(0,cut) as Source,id=key.slice(cut+1);
    if(source!=="Anikoto")hydrated.set(key,{source,id,animeId:canonical(source,id),title:id,year:""});
  }
  for(const key of (input.hydrateMissing?links.keys():[])) {
    const id=key.slice(3);
    if(!hydrated.has("Anikoto:"+id))hydrated.set("Anikoto:"+id,{
      source:"Anikoto",id,animeId:key,title:id,year:"",
    });
  }
  const grouped=new Map<string,SourceWork[]>();
  for(const row of hydrated.values()) {
    const group=row.source==="Anikoto" ? "isolated:ak_"+row.id : find(idOf(row));
    if(!grouped.has(group))grouped.set(group,[]);
    grouped.get(group)!.push(row);
  }
  const selected: WorkGroup[]=[];
  for(const root of seeds) {
    const members=[...(grouped.get(root)||[])];
    const multiAnikotoIds:string[]=[];
    for(const [id,targets] of links)if(targets.has(root)) {
      const work=hydrated.get("Anikoto:"+id.slice(3));
      if(work && !members.some(row=>row.animeId===id))members.push(work);
      if(targets.size>1)multiAnikotoIds.push(id);
    }
    if(!members.length)continue;
    members.sort((a,b)=>sourcePriority(a.source)-sourcePriority(b.source)
      || a.id.localeCompare(b.id,"en"));
    const primary=members.find(x=>x.source!=="Anikoto")||members[0];
    const display=members.find(x=>/[가-힣]/.test(x.title))||primary;
    selected.push({animeId:primary.animeId,title:display.title,year:display.year||primary.year,
      members,multiAnikotoIds});
  }
  return selected.slice(0,input.limit??60);
}
