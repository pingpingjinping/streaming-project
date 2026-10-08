const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript');
const assert=require('node:assert/strict'),{test}=require('node:test');
const code=ts.transpileModule(fs.readFileSync(path.join(__dirname,'../src/lib/provisionalWorkMatches.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
function load(sql=null,manual=[]) {
 const exports={};vm.runInNewContext(code,{exports,require:n=>n==='./db'?{getDb:()=>sql}:{getWorkMatchOverrides:async()=>manual,importedLinkIsOverridden:(rows,rid,aid)=>rows.some(x=>x.reanimeId===rid||x.anissiaNo===aid)}});return exports;
}
const api=load();
const edge=(aid,rid,score=80,conflicts=[],group)=>({anissiaNo:aid,reanimeId:rid,score,reason:'season_missing',evidence:{conflicts,missing:[],work_identity:group}});
const pairs=rows=>Array.from(rows,x=>`${x.anissiaNo}:${x.reanimeId}`).sort();
test('confirmed season 2 leaves unlabelled work its free season 1 candidate',()=>{
 assert.deepEqual(pairs(api.allocateCandidateLinks([edge(1,'season-2',95),edge(1,'season-1',80)], [{anissiaNo:2,reanimeId:'season-2'}])),['1:season-1']);
});
test('global residual reassignment connects both works where greedy matching strands one',()=>{
 assert.deepEqual(pairs(api.allocateCandidateLinks([edge(1,'a',90),edge(1,'b',80),edge(2,'a',85)],[])),['1:b','2:a']);
});
test('equal coverage maximizes total evidence instead of source or database order',()=>{
 const graph=[edge(1,'a',90),edge(1,'b',89),edge(2,'a',88),edge(2,'b',70)];
 assert.deepEqual(pairs(api.allocateCandidateLinks(graph,[])),['1:b','2:a']);
 assert.deepEqual(pairs(api.allocateCandidateLinks(graph.reverse(),[])),['1:b','2:a']);
});
test('explicit season, part, type, episode count and protected review conflicts never allocate',()=>{
 for(const conflict of ['season_conflict','season_inconsistent','part_conflict','part_inconsistent','format_conflict','episode_count_conflict','reviewed_work_reserved'])
  assert.equal(api.allocateCandidateLinks([edge(1,'wrong',100,[conflict])],[]).length,0);
 assert.equal(api.allocateCandidateLinks([edge(1,'weak',69)],[]).length,0);
 assert.equal(api.allocateCandidateLinks([{...edge(1,'legacy'),evidence:{}}],[]).length,0);
});
test('year disagreement remains provisional and ranks below corroborated evidence',()=>{
 assert.deepEqual(pairs(api.allocateCandidateLinks([edge(1,'old',90,['year_conflict']),edge(1,'same',80)],[])),['1:same']);
 assert.equal(api.allocateCandidateLinks([edge(1,'old',90,['year_conflict'])],[]).length,1);
});
test('duplicate URLs of a validated work have one capacity and confirmed aliases reserve it',()=>{
 const graph=[edge(1,'a',90,[],'AniList:1'),edge(2,'b',80,[],'AniList:1')];
 assert.equal(api.allocateCandidateLinks(graph,[]).length,1);
 assert.equal(api.allocateCandidateLinks(graph,[{anissiaNo:3,reanimeId:'a'}]).length,0);
});
test('maximum cardinality and weight agree with exhaustive small graphs',()=>{
 let seed=42;const random=()=>{seed=(seed*1664525+1013904223)>>>0;return seed/4294967296;};
 for(let sample=0;sample<80;sample++) {
  const graph=[];for(let aid=1;aid<=4;aid++)for(let rid=1;rid<=4;rid++)if(random()<.45)graph.push(edge(aid,String(rid),70+Math.floor(random()*31)));
  let best=[0,0];function visit(aid,used,count,score){if(aid===5){if(count>best[0]||count===best[0]&&score>best[1])best=[count,score];return;}
   visit(aid+1,used,count,score);for(const c of graph.filter(c=>c.anissiaNo===aid&&!used.has(c.reanimeId))){used.add(c.reanimeId);visit(aid+1,used,count+1,score+c.score);used.delete(c.reanimeId);}}
  visit(1,new Set(),0,0);const actual=api.allocateCandidateLinks(graph,[]);
  assert.deepEqual([actual.length,actual.reduce((sum,c)=>sum+c.score,0)],best);
 }
});
test('current manual pins displace imported pairs before remaining candidates allocate',async()=>{
 const rows=[{anissia_no:1,reanime_id:'a',score:80,reason:'season_missing',evidence:{conflicts:[]}},
  {anissia_no:2,reanime_id:'b',score:80,reason:'season_missing',evidence:{conflicts:[]}}];
 const sql=async(strings)=>strings.join('').includes('anime_monthly_match_candidates')?rows:[{anissia_no:1,reanime_id:'b'}];
 const result=await load(sql,[{anissiaNo:1,reanimeId:'a'}]).getProvisionalWorkMatches();
 assert.deepEqual(pairs(result),['2:b']);
});

test('numbered sequel cannot provisionally use an unnumbered original without complete same-year native evidence',()=>{
 const c=edge(1,'original');c.evidence={conflicts:[],missing:['season_missing'],source_seasons:[4],target_seasons:[],year:2023,anissia_year:null,full_native_exact:true};
 assert.equal(api.allocateCandidateLinks([c],[]).length,0);
 c.evidence={...c.evidence,year:2025,anissia_year:2025};assert.equal(api.allocateCandidateLinks([c],[]).length,1);
 c.evidence.full_native_exact=false;assert.equal(api.allocateCandidateLinks([c],[]).length,0);
 const unknown=edge(1,'second');unknown.evidence={conflicts:[],missing:['season_missing'],source_seasons:[],target_seasons:[2]};
 assert.equal(api.allocateCandidateLinks([unknown],[]).length,1);
});
test('2025 frozen 50-work replay retains 46 confirmed targets and adds the four expected provisional links',()=>{
 const fixture=JSON.parse(fs.readFileSync(path.join(__dirname,'fixtures/provisional-2025-50.json'),'utf8'));
 const result=api.allocateCandidateLinks(fixture.candidates,fixture.confirmed);
 assert.equal(fixture.confirmed.length,46);assert.equal(result.length,4);
 for(const row of result)assert.equal(row.reanimeId,fixture.expected[String(row.anissiaNo)]);
});
