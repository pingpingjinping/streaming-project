const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript');
const assert=require('node:assert/strict'),{test}=require('node:test');
const source=fs.readFileSync(path.join(__dirname,'../src/components/ErulaboDownloadButton.tsx'),'utf8');
const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const flush=async()=>{await new Promise(r=>setImmediate(r));await new Promise(r=>setImmediate(r));};
const response=data=>({ok:true,json:async()=>({success:true,...data})});
const nodes=tree=>Array.isArray(tree)?tree.flatMap(nodes):tree&&typeof tree==='object'?[tree,...nodes(tree.props?.children)]:[];
const text=tree=>Array.isArray(tree)?tree.map(text).join(''):tree&&typeof tree==='object'?text(tree.props?.children):tree==null?'':String(tree);
function harness(){
 const slots=[],effects=[],requests=[],timers=new Map();let index=0,timerId=0,tree,applied=0;
 let props={request:{animeId:'ani_10',title:'작품',episodeNumber:3,creatorEpisode:'3화',website:'https://erulabo.com/867'},onApply:async()=>{applied++;}};
 const react={
  useState(initial){const i=index++;if(!slots[i])slots[i]={value:initial};return [slots[i].value,v=>slots[i].value=typeof v==='function'?v(slots[i].value):v];},
  useRef(initial){const i=index++;return slots[i]||=( {current:initial} );},
  useEffect(fn,deps){const i=index++;if(!slots[i]||deps.some((v,j)=>v!==slots[i].deps[j]))effects.push(()=>{slots[i]?.cleanup?.();slots[i]={deps,cleanup:fn()};});},
 };
 const exports={};vm.runInNewContext(compiled,{exports,require:id=>{
  if(id==='react')return react;if(id==='lucide-react')return {Download:'i',Loader2:'i'};
  if(id==='react/jsx-runtime')return {jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props})};
  throw Error('Unexpected import '+id);
 },URLSearchParams,AbortController,setTimeout:fn=>{timers.set(++timerId,fn);return timerId;},clearTimeout:id=>timers.delete(id),
 fetch:(url,options={})=>{const task=deferred();requests.push({url,options,...task});return task.promise;}});
 return {
  render(next){if(next)props={...props,...next};index=0;tree=exports.default(props);effects.splice(0).forEach(fn=>fn());return tree;},
  button(){return nodes(this.render()).find(node=>node.type==='button');},
  label(){return text(this.render());},requests,timers,
  tick(){const [id,fn]=timers.entries().next().value;timers.delete(id);void fn();},
  unmount(){slots.forEach(slot=>slot?.cleanup?.());},
  get applied(){return applied;},get props(){return props;},
 };
}

test('opening the picker only checks status; an explicit click creates the durable job',async()=>{
 const h=harness();h.render();assert.equal(h.requests.length,1);assert.equal(h.requests[0].options.method,undefined);
 h.requests[0].resolve(response({status:'idle',available:true}));await flush();
 assert.match(h.label(),/자막 받아오기/);assert.equal(h.button().props.disabled,false);
 const click=h.button().props.onClick();assert.equal(h.requests[1].options.method,'POST');
 h.requests[1].resolve(response({status:'queued',available:true}));await click;
 assert.equal(h.button().props.disabled,true);assert.match(h.label(),/페이지를 나가도 계속/);
 h.tick();h.requests[2].resolve(response({status:'downloading',available:true}));await flush();assert.equal(h.applied,0);
 h.tick();h.requests[3].resolve(response({status:'ready',available:true}));await flush();assert.equal(h.applied,1);
 h.tick();h.requests[4].resolve(response({status:'ready',available:true}));await flush();assert.equal(h.applied,1);
 h.unmount();assert.equal(h.timers.size,0);
});
test('returning to a completed job shows immediate apply without another download',async()=>{
 const h=harness();h.render();h.requests[0].resolve(response({status:'ready',available:false}));await flush();
 assert.equal(h.applied,0);assert.match(h.label(),/자막 적용/);assert.equal(h.button().props.disabled,false);
 await h.button().props.onClick();assert.equal(h.applied,1);assert.equal(h.requests.length,1);h.unmount();
});
test('leaving during a start request cancels polling but does not send a server cancellation',async()=>{
 const h=harness();h.render();h.requests[0].resolve(response({status:'idle',available:true}));await flush();
 const started=h.button().props.onClick();h.unmount();h.requests[1].resolve(response({status:'queued',available:true}));await started;
 assert.equal(h.applied,0);assert.equal(h.requests.length,2);assert.equal(h.timers.size,0);
});
test('a late completion from another episode cannot apply to the new episode',async()=>{
 const h=harness();h.render();h.requests[0].resolve(response({status:'idle',available:true}));await flush();
 const start=h.button().props.onClick();h.requests[1].resolve(response({status:'queued',available:true}));await start;
 h.tick();const old=h.requests[2];h.render({request:{...h.props.request,episodeNumber:4}});
 old.resolve(response({status:'ready',available:true}));await flush();assert.equal(h.applied,0);
 h.requests[3].resolve(response({status:'idle',available:true}));await flush();assert.match(h.label(),/자막 받아오기/);h.unmount();
});
test('failed and unconfigured workers expose retry and availability without automatic starts',async()=>{
 for(const status of [{status:'failed',available:true},{status:'idle',available:false}]){
  const h=harness();h.render();h.requests[0].resolve(response(status));await flush();
  assert.equal(h.requests.length,1);assert.equal(h.button().props.disabled,!status.available);
  assert.match(h.label(),status.available?/다시 시도/:/준비하고 있어요/);h.unmount();
 }
});
