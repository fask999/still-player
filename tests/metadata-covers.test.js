'use strict';
require('./helpers/test-effect-guard.cjs').installTestEffectGuard();
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {createHash} = require('node:crypto');
const vm = require('node:vm');
const {createMetadataCoverService, artworkForRelease, normalizeMusicBrainzContact, LIMITS} = require('../src/main/metadata-covers');
const {createPublicFetchService} = require('../src/main/public-fetch');
const tick = () => new Promise(resolve => setImmediate(resolve));
const uuid = name => {const h=createHash('sha256').update(name).digest('hex');return h.slice(0,8)+'-'+h.slice(8,12)+'-4'+h.slice(13,16)+'-8'+h.slice(17,20)+'-'+h.slice(20,32);};
const art = name => 'https://coverartarchive.org/release/'+uuid(name)+'/front-500';
const scheme = url => 'still-apple-art://art/'+createHash('sha256').update(url).digest('hex');
const track = (album='Album', artist='Artist') => ({id: album, artist, album, coverUrl: ''});
const row = (album='Album', artist='Artist', id=1) => ({id:uuid(album+id),title:album,'artist-credit':[{name:artist,artist:{name:artist}}]});
const response = (releases,count=releases.length) => new Response(JSON.stringify({releases,count}), {headers:{'content-type':'application/json'}});
const unexpectedFetch = async () => {throw new Error('Unexpected metadata fixture fetch.');};
async function setup(t, options={}) {
 const root=await fs.mkdtemp(path.join(__dirname,'.tmp-metadata-cover-'));
 const service=createMetadataCoverService({cacheDirectory:path.join(root,'cache'),artworkUrlFor:scheme,fetchImpl:unexpectedFetch,userAgent:'STILL/1.0.0 (https://fixture.invalid/contact)',...options});
 t.after(async()=>{
  await service.close();
  assert.equal(path.dirname(root),__dirname);assert.ok(path.basename(root).startsWith('.tmp-metadata-cover-'));
  await fs.rm(root,{recursive:true,force:true});
 });
 await service.initialize();return {service,root};
}
async function settled(service, value=track()) {
 for(let i=0;i<1200;i++){const x=service.decorateTrack(value);if(x.coverMetadataStatus!=='queued')return x;await new Promise(r=>setTimeout(r,2));}
 throw new Error('Job failed to settle');
}
test('synchronous immutable decorators preserve original cover and missing metadata',async t=>{
 let calls=0;const {service}=await setup(t,{fetchImpl:async()=>{calls++;return response([]);}});
 const covered={...track(),coverUrl:'still-cover://cover/original'};assert.equal(service.decorateTrack(covered),covered);
 assert.equal(service.decorateTrack({title:'filename only'}).coverMetadataStatus,'missing-metadata');
 assert.equal(calls,0);const input={tracks:[covered],playlists:[]};const out=service.decorateSnapshot(input);assert.equal(out.tracks[0],covered);assert.equal(input.tracks[0],covered);
});
test('exact normalized metadata only, bounded request, fixed CAA scheme and source',async t=>{
 let calls=0;let remote;
 const {service}=await setup(t,{artworkUrlFor:u=>{remote=u;return scheme(u);},fetchImpl:async(u,o)=>{
  calls++;const url=new URL(u);assert.equal(url.origin,'https://musicbrainz.org');assert.match(url.searchParams.get('query'),/release:/);assert.equal(o.headers['User-Agent'],'STILL/1.0.0 (https://fixture.invalid/contact)');assert.equal(o.credentials,'omit');assert.equal(o.redirect,'error');assert.equal(o.headers.Authorization,undefined);return response([row(' ALBUM ','ARTIST')]);
 }});
 const original=track();assert.equal(service.decorateTrack(original).coverMetadataStatus,'queued');
 const result=await settled(service);assert.equal(result.coverMetadataStatus,'matched');assert.match(result.coverUrl,/^still-apple-art:\/\/art\/[a-f0-9]{64}$/);assert.equal(remote,'https://coverartarchive.org/release/'+row(' ALBUM ','ARTIST').id+'/front-500');
 assert.equal(result.coverMetadataSource.provider,'Cover Art Archive');assert.equal(result.coverMetadataSource.sourceUrl,'https://musicbrainz.org/release/'+row(' ALBUM ','ARTIST').id);assert.equal(original.coverUrl,'');assert.equal(calls,1);
});
test('offline restart reuses persisted positive cache without fetch',async t=>{
 const {service,root}=await setup(t,{fetchImpl:async()=>response([row()])});await settled(service);await service.close();
 const second=createMetadataCoverService({cacheDirectory:path.join(root,'cache'),artworkUrlFor:scheme,fetchImpl:async()=>{throw new Error('Offline fetch must never occur');}});t.after(()=>second.close());await second.initialize();
 assert.equal(second.decorateTrack(track()).coverMetadataStatus,'matched');assert.match(second.decorateTrack(track()).coverUrl,/still-apple-art:/);
});
test('edition differences, no result, ambiguous IDs or images never bind',async t=>{
 for(const results of [[row('Album (Live)')],[],[row(),row('Album','Artist',2)]] ){
  const {service}=await setup(t,{fetchImpl:async()=>response(results)});const result=await settled(service);assert.equal(result.coverUrl,'');assert.ok(['no-match','ambiguous'].includes(result.coverMetadataStatus));
 }
});
test('negative result and failure are cached and cooled down',async t=>{
 for(const failure of [false,true]){let calls=0;const {service}=await setup(t,{fetchImpl:async()=>{calls++;if(failure)throw new Error('offline');return response([]);}});const x=await settled(service);assert.equal(x.coverMetadataStatus,failure?'failed':'no-match');for(let i=0;i<100;i++)service.decorateTrack(track());assert.equal(calls,1);}
});
test('rapid track changes share canonical keys without overwriting new track metadata',async t=>{
 const time=pacingClock(),resolvers=new Map(),started=[deferred(),deferred()],starts=[];
 const {service}=await setup(t,{clock:time,fetchImpl:u=>new Promise(resolve=>{
  resolvers.set(new URL(u).searchParams.get('query'),resolve);starts.push(time.now());started[starts.length-1].resolve();
 })});
 try {
  const a=track('A'),b=track('B');service.decorateTrack(a);service.decorateTrack(b);service.decorateTrack({...a,id:'same-album-other-track'});
  await started[0].promise;assert.equal(resolvers.size,1);
  resolvers.get('release:"a" AND artist:"artist"')(response([row('A')]));time.advance(999);await tick();assert.equal(resolvers.size,1);
  time.advance(1);await started[1].promise;assert.deepEqual(starts,[0,1000]);
  resolvers.get('release:"b" AND artist:"artist"')(response([row('B')]));
  const result=await settled(service,b);assert.equal(result.album,'B');assert.equal(result.coverUrl,scheme('https://coverartarchive.org/release/'+row('B').id+'/front-500'));assert.equal((await settled(service,a)).album,'A');
 } finally {for(const resolve of resolvers.values())resolve(response([]));await service.close();}
});
test('concurrency and queue limits; close aborts uncooperative fetch with no late notification',async t=>{
 const time=pacingClock(),signals=[],gates=[],started=[deferred(),deferred()];let active=0,peak=0,changes=0;
 const {service}=await setup(t,{clock:time,onChange:()=>{changes++;},fetchImpl:async(u,o)=>{
  active++;peak=Math.max(peak,active);signals.push(o.signal);const gate=deferred();gates.push(gate);started[gates.length-1].resolve();
  try{return await gate.promise;}finally{active--;}
 }});
 try {
  const statuses=[];for(let i=0;i<40;i++)statuses.push(service.decorateTrack(track('Album'+i)).coverMetadataStatus);
  await started[0].promise;time.advance(999);await tick();assert.equal(peak,1);
  time.advance(1);await started[1].promise;assert.equal(peak,2);
  assert.equal(statuses.filter(x=>x==='queued').length,33);assert.equal(statuses.filter(x=>x==='queue-full').length,7);
  const before=changes;await service.close();assert.ok(signals.every(x=>x.aborted));
  for(const gate of gates)gate.resolve(response([]));await flush();assert.equal(changes,before);assert.equal(peak,2);
 } finally {for(const gate of gates)gate.resolve(response([]));await service.close();}
});
test('only strict release UUIDs construct fixed CAA front URLs; unsafe registrar never reaches renderer',async t=>{
 for(const id of ['../evil','00000000-0000-0000-0000-000000000000',uuid('x').toUpperCase(),uuid('x')+'?x'])assert.equal(artworkForRelease(id),'');
 assert.equal(artworkForRelease(uuid('x')),art('x'));
 const {service}=await setup(t,{artworkUrlFor:()=>art('unsafe'),fetchImpl:async()=>response([row()])});assert.equal((await settled(service)).coverUrl,'');
});
test('response status/type/size/JSON failures become failed without retry loops',async t=>{
 for(const make of [()=>new Response('{}',{status:302}),()=>new Response('{}'),()=>new Response('not json',{headers:{'content-type':'application/json'}}),()=>new Response('x',{headers:{'content-type':'application/json','content-length':String(LIMITS.maxResponseBytes+1)}}),()=>new Response('x'.repeat(LIMITS.maxResponseBytes+1),{headers:{'content-type':'application/json'}})]){
  const {service}=await setup(t,{fetchImpl:async()=>make()});assert.equal((await settled(service)).coverMetadataStatus,'failed');
 }
});
test('oversized/invalid and symlink cache index fail closed',async t=>{
 const {service,root}=await setup(t);await service.close();await fs.writeFile(path.join(root,'cache/index.json'),'x'.repeat(LIMITS.maxIndexBytes+1));
 const second=createMetadataCoverService({cacheDirectory:path.join(root,'cache'),artworkUrlFor:scheme,fetchImpl:unexpectedFetch});t.after(()=>second.close());await second.initialize();assert.equal(second.decorateTrack(track()).coverMetadataStatus,'cache-unavailable');
 const link=path.join(root,'linked');await fs.symlink(path.join(root,'cache'),link,'junction');
 const third=createMetadataCoverService({cacheDirectory:link,artworkUrlFor:scheme,fetchImpl:unexpectedFetch});t.after(()=>third.close());await third.initialize();assert.equal(third.decorateTrack(track()).coverMetadataStatus,'cache-unavailable');
});

test('MusicBrainz starts are separated by at least one second',async()=>{
 const time=pacingClock(),starts=[];
 const env=await syntheticMetadata(async()=>{starts.push(time.now());return response([]);},{clock:time,wallNow:time.wallNow});
 try {
  env.service.decorateTrack(track('One'));env.service.decorateTrack(track('Two'));await flush();
  assert.deepEqual(starts,[0]);time.advance(999);await flush();assert.deepEqual(starts,[0]);
  time.wakeEarly();await flush();assert.deepEqual(starts,[0]);
  time.advance(1);await flush();assert.deepEqual(starts,[0,1000]);
  assert.ok(starts[1]-starts[0]>=1000,JSON.stringify({actualDispatches:starts,gap:starts[1]-starts[0]}));
 } finally {await env.service.close();}
});

test('MusicBrainz actual public-session handoffs remain paced after delayed work and synchronous adapter preparation',async t=>{
 const time=pacingClock(),invocations=[],handoffs=[];let first=true;
 const publicFetch=createPublicFetchService({session:{fromPartition:()=>({
  fetch(input,options){handoffs.push(time.now());assert.equal(new URL(input).hostname,'musicbrainz.org');assert.equal(options.credentials,'omit');return Promise.resolve(response([]));},
  closeAllConnections:async()=>{}
 })}});
 const env=await syntheticMetadata((input,options)=>{
  invocations.push(time.now());if(first){first=false;time.advance(200);}return publicFetch.fetch(input,options);
 },{clock:time,wallNow:time.wallNow});
 try {
  env.service.decorateTrack(track('One'));env.service.decorateTrack(track('Two'));
  time.advance(500);await flush();assert.deepEqual(invocations,[500]);assert.deepEqual(handoffs,[700]);
  time.advance(300);await flush();assert.deepEqual(handoffs,[700]);
  time.advance(699);time.wakeEarly();await flush();assert.deepEqual(handoffs,[700]);
  time.advance(1);await flush();assert.deepEqual(invocations,[500,1700]);assert.deepEqual(handoffs,[700,1700]);
  assert.ok(handoffs[1]-handoffs[0]>=1000);
  t.diagnostic(JSON.stringify({fetchImplInvocations:invocations,publicSessionHandoffs:handoffs,handoffGap:handoffs[1]-handoffs[0]}));
 } finally {await env.service.close();await publicFetch.close();}
});

for(const wallAdjustment of [-5000,5000])test(`MusicBrainz dispatch pacing ignores wall adjustment ${wallAdjustment} while stored timestamps retain wall time`,async t=>{
 const time=pacingClock(),starts=[];
 const env=await syntheticMetadata(async()=>{starts.push(time.now());return response([]);},{clock:time,wallNow:time.wallNow});
 try {
  env.service.decorateTrack(track('One'));await flush();assert.deepEqual(starts,[0]);
  time.advance(0,wallAdjustment);env.service.decorateTrack(track('Two'));await flush();assert.deepEqual(starts,[0]);
  time.advance(999);time.wakeEarly();await flush();assert.deepEqual(starts,[0]);
  time.advance(1);await flush();assert.deepEqual(starts,[0,1000]);
  const saved=env.stored.flatMap(index=>index.entries).find(entry=>entry.album==='two');
  assert.equal(saved.checkedAt,time.wallNow());
  t.diagnostic(JSON.stringify({wallAdjustment,actualDispatches:starts,monotonicGap:starts[1]-starts[0],storedCheckedAt:saved.checkedAt}));
 } finally {await env.service.close();}
});
test('positive index eviction keeps at most 512 canonical mappings',async t=>{
 const {service,root}=await setup(t);await service.close();
 const entries=Array.from({length:512},(_,i)=>{const artist='artist',album='cached '+i;return {key:createHash('sha256').update(JSON.stringify([artist,album])).digest('hex'),artist,album,status:'no-match',checkedAt:Date.now()};});
 await fs.writeFile(path.join(root,'cache/index.json'),JSON.stringify({version:2,entries}));
 const second=createMetadataCoverService({cacheDirectory:path.join(root,'cache'),artworkUrlFor:scheme,userAgent:'STILL/1.0.0 (https://fixture.invalid/contact)',fetchImpl:async()=>response([row()])});t.after(()=>second.close());await second.initialize();assert.equal((await settled(second)).coverMetadataStatus,'matched');await second.close();
 const stored=JSON.parse(await fs.readFile(path.join(root,'cache/index.json'),'utf8'));assert.equal(stored.entries.length,512);assert.ok(stored.entries.some(e=>e.status==='matched'));assert.ok(!stored.entries.some(e=>e.album==='cached 0'));
});
test('request timeout bounds an uncooperative response body to eight seconds',async t=>{
 const {service}=await setup(t,{fetchImpl:async()=>new Response(new ReadableStream({start(){}}),{headers:{'content-type':'application/json'}})});
 const start=Date.now();service.decorateTrack(track());await new Promise(r=>setTimeout(r,8150));assert.equal(service.decorateTrack(track()).coverMetadataStatus,'failed');assert.ok(Date.now()-start<9000);
});

test('NFC and albumArtist preference preserve edition and artist identity',async t=>{
 const {service}=await setup(t,{fetchImpl:async()=>response([row('Café','Album Artist')])});
 const input={...track('Cafe\u0301','Guest Artist'),albumArtist:'Album Artist'};assert.equal((await settled(service,input)).coverMetadataStatus,'matched');
 const stale={...track('Missing'),coverMetadataSource:{provider:'stale'}};assert.equal(service.decorateTrack(stale).coverMetadataSource,undefined);
});
test('truncated, disambiguated or invalid releases never fabricate a front cover',async t=>{
 for(const make of [()=>response([row()],51),()=>response([{...row(),disambiguation:'Deluxe edition'}]),()=>response([{...row(),id:'not-a-uuid'}])]){
  const {service}=await setup(t,{fetchImpl:async()=>make()});assert.equal((await settled(service)).coverMetadataStatus,'low-confidence');
 }
});
test('missing real maintainer contact fails closed with no public lookup',async t=>{
 let calls=0;const {service}=await setup(t,{userAgent:'',fetchImpl:async()=>{calls++;return response([]);}});assert.equal(service.decorateTrack(track()).coverMetadataStatus,'source-unavailable');assert.equal(calls,0);
});
test('legacy iTunes cache mappings cannot register artwork after source change',async t=>{
 const {service,root}=await setup(t);await service.close();await fs.writeFile(path.join(root,'cache/index.json'),JSON.stringify({version:1,entries:[{status:'matched',artworkUrl:'https://is1-ssl.mzstatic.com/image/thumb/x/512x512bb.jpg'}]}));
 const second=createMetadataCoverService({cacheDirectory:path.join(root,'cache'),artworkUrlFor:()=>{throw new Error('Legacy source must not register');},fetchImpl:unexpectedFetch,userAgent:''});t.after(()=>second.close());await second.initialize();assert.equal(second.decorateTrack(track()).coverMetadataStatus,'source-unavailable');
});

test('known indexed release ID registers fixed CAA without UA or metadata fetch',async t=>{
 let calls=0;const seen=[];const {service}=await setup(t,{userAgent:'',fetchImpl:async()=>{calls++;throw new Error('No search allowed');},artworkUrlFor:u=>{seen.push(u);return scheme(u);}});
 for(const field of ['musicbrainzAlbumId','musicbrainzReleaseId']){
  const input={...track(),[field]:uuid('known')};const out=service.decorateTrack(input);
  assert.equal(out.coverMetadataStatus,'matched');assert.equal(out.coverUrl,scheme(art('known')));assert.equal(out.coverMetadataSource.releaseId,uuid('known'));assert.equal(input.coverUrl,'');
 }
 assert.deepEqual(seen,[art('known'),art('known')]);assert.equal(calls,0);
});
test('invalid or conflicting indexed release IDs are rejected without search',async t=>{
 let calls=0;const {service}=await setup(t,{userAgent:'',fetchImpl:async()=>{calls++;return response([row()]);},artworkUrlFor:()=>{throw new Error('Invalid ID must not register');}});
 for(const id of ['../x',uuid('known').toUpperCase(),uuid('known')+'?x',['not-a-string'],'00000000-0000-0000-0000-000000000000']){
  const out=service.decorateTrack({...track(),musicbrainzAlbumId:id});assert.equal(out.coverMetadataStatus,'invalid-release-id');assert.equal(out.coverUrl,'');
 }
 assert.equal(service.decorateTrack({...track(),musicbrainzAlbumId:uuid('a'),musicbrainzReleaseId:uuid('b')}).coverMetadataStatus,'ambiguous');assert.equal(calls,0);
});
test('existing embedded/local cover always wins over known or invalid release ID',async t=>{
 let calls=0;const {service}=await setup(t,{userAgent:'',fetchImpl:async()=>{calls++;return response([]);},artworkUrlFor:()=>{throw new Error('Existing cover must win');}});
 for(const id of [uuid('known'),'invalid']){
  const input={...track(),coverUrl:'still-cover://cover/original',musicbrainzReleaseId:id};assert.equal(service.decorateTrack(input),input);
 }
 assert.equal(calls,0);
});

function deferred() {let resolve; const promise=new Promise(yes=>{resolve=yes;});return {promise,resolve};}
function pacingClock() {
 let mono=0,wall=100000,sequence=0;const timers=new Map();
 return {now:()=>mono,wallNow:()=>wall,
  setTimeout(callback,delay){const timer={id:++sequence,callback,due:mono+Math.max(0,Number(delay)||0)};timers.set(timer.id,timer);return timer;},
  clearTimeout(timer){if(timer)timers.delete(timer.id);},
  advance(delta,wallDelta=delta){mono+=delta;wall+=wallDelta;
   for(let step=0;step<1000;step++){
    const timer=[...timers.values()].filter(value=>value.due<=mono).sort((a,b)=>a.due-b.due||a.id-b.id)[0];
    if(!timer)return;timers.delete(timer.id);timer.callback();
   }throw new Error('Pacing timer callbacks did not converge.');
  },
  wakeEarly(){const timer=[...timers.values()].sort((a,b)=>a.due-b.due||a.id-b.id)[0];assert.ok(timer,'no timer to wake early');timers.delete(timer.id);timer.callback();}
 };
}
async function flush() {for(let index=0;index<20;index++)await tick();}
async function syntheticMetadata(fetchImpl, options = {}) {
 const source=await fs.readFile(path.join(__dirname,'../src/main/metadata-covers.js'),'utf8');
 const ownModule={exports:{}},timers=new Set(),files=new Map(),payloads=[];let now=100000,writes=0,changes=0;
 const missing=()=>Object.assign(new Error('Synthetic missing file.'),{code:'ENOENT'});
 const fakeFs={
  mkdir:async()=>{await options.initializationGate;},
  lstat:async file=>{if(file.endsWith('index.json')){if(!files.has(file))throw missing();return {isSymbolicLink:()=>false,isFile:()=>true,nlink:1};}return {isSymbolicLink:()=>false,isDirectory:()=>true};},
  open:async file=>{
   if(file.endsWith('index.json')&&!files.has(file))throw missing();
   return {stat:async()=>({isFile:()=>true,nlink:1,size:Buffer.byteLength(files.get(file)||'')}),
    readFile:async()=>files.get(file),writeFile:async value=>{files.set(file,String(value));},sync:async()=>{},close:async()=>{}};
  },
  rename:async(from,to)=>{files.set(to,files.get(from));files.delete(from);writes++;},unlink:async file=>{files.delete(file);}
 };
 const sharedSource=await fs.readFile(path.join(__dirname,'../src/main/bounded-serial-fetch.js'),'utf8');
 const sharedModule={exports:{}};
 const context={
  Buffer,Uint8Array,URL,URLSearchParams,AbortController,Date:class extends Date{static now(){return options.wallNow?options.wallNow():now+=1001;}},
  queueMicrotask,
  setTimeout:(callback,delay)=>{const timer={callback,delay,unref(){}};timers.add(timer);return timer;},clearTimeout:timer=>timers.delete(timer)};
 vm.runInNewContext(sharedSource,{...context,module:sharedModule,exports:sharedModule.exports,require});
 vm.runInNewContext(source,{...context,module:ownModule,exports:ownModule.exports,require:name=>name==='node:fs/promises'?fakeFs:name==='./bounded-serial-fetch'?sharedModule.exports:require(name)});
 const service=ownModule.exports.createMetadataCoverService({cacheDirectory:'D:/synthetic-metadata-test',artworkUrlFor:scheme,
  userAgent:'STILL/1.0.0 (https://fixture.invalid/contact)',...options.serviceOptions,
  clock:options.clock||{now:()=>now+=1001,setTimeout:context.setTimeout,clearTimeout:context.clearTimeout},
  fetchImpl,onChange:payload=>{changes++;payloads.push(payload);options.onChange?.(payload);}});
 if(options.initialize !== false)await service.initialize();
 return {service,payloads,get writes(){return writes;},get changes(){return changes;},get stored(){return [...files.values()].map(value=>JSON.parse(value));},
  expire:()=>{for(const timer of [...timers])if(timer.delay===LIMITS.timeoutMs){timers.delete(timer);timer.callback();}}};
}

test('ignored-abort fetches retain two real slots across timeout and continued queue pressure',async()=>{
 const gates=[],signals=[];
 const env=await syntheticMetadata(async(_url,options)=>{const gate=deferred();gates.push(gate);signals.push(options.signal);return gate.promise;});
 try {
  for(let index=0;index<6;index++)env.service.decorateTrack(track('Held '+index));
  await flush();assert.equal(gates.length,2);
  env.expire();await flush();assert.ok(signals.every(signal=>signal.aborted));
  assert.equal(env.service.decorateTrack(track('Held 0')).coverMetadataStatus,'failed');
  assert.equal(env.service.decorateTrack(track('Held 1')).coverMetadataStatus,'failed');
  for(let index=6;index<40;index++)env.service.decorateTrack(track('Held '+index));
  env.expire();await flush();assert.equal(gates.length,2);
  assert.equal(env.service.decorateTrack(track('Overflow')).coverMetadataStatus,'queue-full');
  const before=env.changes;
  await Promise.race([env.service.close(),new Promise((_,reject)=>setTimeout(()=>reject(new Error('Close waited for ignored fetch.')),300))]);
  assert.equal(env.changes,before);assert.equal(gates.length,2);
 } finally {await env.service.close();for(const gate of gates)gate.resolve(response([]));await flush();}
});

test('late fetch completion frees only its physical slot without late success cache or notification',async()=>{
 const gates=[];
 const env=await syntheticMetadata(async()=>{const gate=deferred();gates.push(gate);return gate.promise;});
 try {
  for(const album of ['A','B','C'])env.service.decorateTrack(track(album));
  await flush();env.expire();await flush();const beforeChanges=env.changes,beforeWrites=env.writes;
  let bodyCancelled=false;
  gates[0].resolve({status:200,headers:new Headers({'content-type':'application/json'}),body:{cancel:async()=>{bodyCancelled=true;}}});
  await flush();assert.equal(bodyCancelled,true);assert.equal(gates.length,3);
  assert.equal(env.service.decorateTrack(track('A')).coverMetadataStatus,'failed');assert.equal(env.changes,beforeChanges);assert.equal(env.writes,beforeWrites);
  gates[2].resolve(response([row('C')]));await flush();
  assert.equal(env.service.decorateTrack(track('C')).coverMetadataStatus,'matched');assert.equal(env.writes,beforeWrites+1);assert.equal(env.changes,beforeChanges+1);
  assert.ok(env.stored.flatMap(index=>index.entries).every(entry=>entry.album!=='a'||entry.status==='failed'));
 } finally {await env.service.close();for(const gate of gates)gate.resolve(response([]));await flush();}
});

test('ignored body read and cancellation keep physical slots after logical timeout',async()=>{
 const bodies=[];let calls=0;
 const env=await syntheticMetadata(async()=>{
  calls++;const read=deferred(),cancel=deferred(),state={read,cancel,cancellations:0};bodies.push(state);
  return {status:200,headers:new Headers({'content-type':'application/json'}),body:{getReader:()=>({
   read:()=>read.promise,cancel:()=>{state.cancellations++;return cancel.promise;},releaseLock(){}})}};
 });
 try {
  for(const album of ['A','B','C','D'])env.service.decorateTrack(track(album));
  await flush();assert.equal(calls,2);env.expire();await flush();assert.ok(bodies.every(body=>body.cancellations===1));
  bodies[0].read.resolve({done:true});await flush();assert.equal(calls,2); // cancel is still unsettled.
  const changes=env.changes,writes=env.writes;
  bodies[0].cancel.resolve();await flush();assert.equal(calls,3);assert.equal(env.changes,changes);assert.equal(env.writes,writes);
  assert.equal(env.service.decorateTrack(track('A')).coverMetadataStatus,'failed');
 } finally {await env.service.close();for(const body of bodies){body.read.resolve({done:true});body.cancel.resolve();}await flush();}
});

test('close promptly cancels logical jobs but late fetch/body completion never starts queue or publishes',async()=>{
 const late=deferred(),read=deferred(),cancel=deferred();let calls=0;const signals=[];
 const env=await syntheticMetadata(async(_url,options)=>{
  signals.push(options.signal);calls++;
  if(calls===1)return late.promise;
  return {status:200,headers:new Headers({'content-type':'application/json'}),body:{getReader:()=>({read:()=>read.promise,cancel:()=>cancel.promise,releaseLock(){}})}};
 });
 for(const album of ['A','B','C','D'])env.service.decorateTrack(track(album));
 await flush();assert.equal(calls,2);const changes=env.changes,writes=env.writes;
 try {
  await Promise.race([env.service.close(),new Promise((_,reject)=>setTimeout(()=>reject(new Error('Close waited for ignored body.')),300))]);
  assert.ok(signals.every(signal=>signal.aborted));assert.equal(env.changes,changes);assert.equal(env.writes,writes);
  late.resolve(response([row('A')]));read.resolve({done:true});cancel.resolve();await flush();env.expire();await flush();
  assert.equal(calls,2);assert.equal(env.changes,changes);assert.equal(env.writes,writes);assert.equal(env.service.decorateTrack(track()).coverMetadataStatus,'closed');
 } finally {late.resolve(response([]));read.resolve({done:true});cancel.resolve();await env.service.close();await flush();}
});

test('contact validator accepts supplied email or HTTPS page and rejects header injection',()=>{
 for(const value of ['listener@example.org','team+still@example.co.uk','https://example.org/contact','HTTPS://example.org/contact',' https://example.org/contact '])
  assert.equal(normalizeMusicBrainzContact(value),value.trim());
 for(const value of [undefined,null,123,'','not an email','mailto:listener@example.org','http://example.org/contact',
  'https://user:password@example.org/contact','https://example.org/(contact)','a@example.org\r\nX-Test: injected',
  'https://example.org/%0d%0aX-Test','https://example.org/\u202econtact','\ufeffa@example.org','a@example.org\u2028',
  '.a@example.org','a..b@example.org','a'.repeat(201)+'@example.org'])
  assert.equal(normalizeMusicBrainzContact(value),'',String(value));
});

test('explicit empty/invalid contact never queries even with legacy fixture UA',async()=>{
 for(const contact of ['', 'invalid', 'a@example.org\n']){
  let calls=0;
  const env=await syntheticMetadata(async()=>{calls++;return response([]);},{serviceOptions:{contact}});
  try {assert.equal(env.service.decorateTrack(track()).coverMetadataStatus,'source-unavailable');await flush();assert.equal(calls,0);}
  finally {await env.service.close();}
 }
});

test('contact generates application UA, merges changed IDs and cancels old contact without late writes',async()=>{
 const calls=[],gates=[];
 const env=await syntheticMetadata(async(url,options)=>{
  const gate=deferred();calls.push({url,options});gates.push(gate);return gate.promise;
 },{serviceOptions:{contact:''}});
 try {
  for(const id of ['one','two'])assert.equal(env.service.decorateTrack({...track(),id}).coverMetadataStatus,'source-unavailable');
  assert.equal(env.service.setContact('listener@example.org'),'listener@example.org');
  assert.equal(env.service.setContact('https://example.org/contact'),'https://example.org/contact');
  await flush();assert.equal(env.payloads.length,1);assert.deepEqual(Array.from(env.payloads[0].trackIds).sort(),['one','two']);
  assert.equal(env.service.decorateTrack({...track(),id:'one'}).coverMetadataStatus,'queued');await flush();
  assert.equal(calls.length,1);assert.equal(calls[0].options.headers['User-Agent'],'STILL/1.0.1 (https://example.org/contact)');
  assert.equal(calls[0].options.credentials,'omit');assert.equal(calls[0].options.redirect,'error');
  assert.equal(env.service.setContact(''),'');await flush();assert.equal(calls[0].options.signal.aborted,true);
  const before=env.changes;
  gates[0].resolve(response([row()]));await flush();
  assert.equal(env.changes,before);assert.equal(env.writes,0);assert.equal(env.stored.length,0);
  assert.equal(env.service.decorateTrack({...track(),id:'one'}).coverMetadataStatus,'source-unavailable');
  env.service.setContact('listener@example.org');env.service.decorateTrack({...track(),id:'one'});await flush();
  assert.equal(calls.length,2);assert.equal(calls[1].options.headers['User-Agent'],'STILL/1.0.1 (listener@example.org)');
  gates[1].resolve(response([row()]));await flush();assert.equal(env.service.decorateTrack({...track(),id:'one'}).coverMetadataStatus,'matched');
 } finally {await env.service.close();for(const gate of gates)gate.resolve(response([]));await flush();}
});

test('initialization only notifies IDs already decorated as initializing and preserves snapshot playlist duplicates',async()=>{
 const gate=deferred();
 const env=await syntheticMetadata(async()=>response([]),{initialize:false,initializationGate:gate.promise,serviceOptions:{contact:''}});
 try {
  const snapshot={tracks:[track('A'),track('B'),track('A'),{id:'missing'}, {...track('covered'),coverUrl:'still-cover://cover/local'}],
   playlists:[{id:'p',trackIds:['A','A','B']}]};
  const out=env.service.decorateSnapshot(snapshot);
  assert.equal(out.tracks[0].coverMetadataStatus,'initializing');assert.equal(out.tracks[1].coverMetadataStatus,'initializing');
  assert.equal(out.playlists,snapshot.playlists);assert.deepEqual(out.playlists[0].trackIds,['A','A','B']);
  gate.resolve();await env.service.initialize();await flush();
  assert.equal(env.payloads.length,1);assert.deepEqual(Array.from(env.payloads[0].trackIds).sort(),['A','B']);
 } finally {gate.resolve();await env.service.close();}
});

test('metadata-key changes and existing covers remove old ID bindings; album notifications deduplicate IDs',async()=>{
 const gates=new Map();
 const env=await syntheticMetadata(async url=>{
  const gate=deferred();gates.set(new URL(url).searchParams.get('query'),gate);return gate.promise;
 },{serviceOptions:{contact:'listener@example.org'}});
 try {
  env.service.decorateTrack({...track('A'),id:'moving'});env.service.decorateTrack({...track('A'),id:'covered'});
  await flush();
  env.service.decorateTrack({...track('B'),id:'moving'});env.service.decorateTrack({...track('B'),id:'peer'});
  env.service.decorateTrack({...track('B'),id:'peer'});env.service.decorateTrack({...track('A'),id:'covered',coverUrl:'still-cover://cover/local'});
  await flush();assert.equal(gates.size,2);
  gates.get('release:"a" AND artist:"artist"').resolve(response([row('A')]));await flush();assert.equal(env.payloads.length,0);
  gates.get('release:"b" AND artist:"artist"').resolve(response([row('B')]));await flush();
  assert.equal(env.payloads.length,1);assert.deepEqual(Array.from(env.payloads[0].trackIds).sort(),['moving','peer']);
  assert.equal(env.service.decorateTrack({...track('B'),id:'moving'}).coverMetadataStatus,'matched');
 } finally {await env.service.close();for(const gate of gates.values())gate.resolve(response([]));await flush();}
});

test('closing suppresses a pending batched contact notification',async()=>{
 const env=await syntheticMetadata(async()=>response([]),{serviceOptions:{contact:''}});
 env.service.decorateTrack(track());env.service.setContact('listener@example.org');
 await env.service.close();await flush();assert.equal(env.changes,0);
 assert.equal(env.service.decorateTrack(track()).coverMetadataStatus,'closed');
});

test('affected track notifications split into bounded batches and exclude forgotten IDs',async()=>{
 const env=await syntheticMetadata(async()=>response([]),{serviceOptions:{contact:''}});
 try {
  for(let index=0;index<600;index++)env.service.decorateTrack({...track(),id:'track-'+index});
  env.service.setContact('listener@example.org');env.service.forgetTracks(['track-0','track-0','unknown']);
  await flush();assert.equal(env.payloads.length,3);
  assert.ok(env.payloads.every(payload=>payload.trackIds.length<=LIMITS.maxNotificationBatch));
  const ids=env.payloads.flatMap(payload=>Array.from(payload.trackIds));
  assert.equal(ids.length,599);assert.equal(new Set(ids).size,599);assert.equal(ids.includes('track-0'),false);
 } finally {await env.service.close();}
});

test('forgetting last metadata reference aborts work and removes all late cache/event effects',async()=>{
 const gate=deferred();let signal;
 const env=await syntheticMetadata(async(_url,options)=>{signal=options.signal;return gate.promise;},
  {serviceOptions:{contact:'listener@example.org'}});
 try {
  env.service.decorateTrack({...track(),id:'one'});env.service.decorateTrack({...track(),id:'two'});await flush();
  env.service.forgetTracks(['one']);assert.equal(signal.aborted,false);
  env.service.forgetTracks(['two','two']);assert.equal(signal.aborted,true);
  env.service.setContact('https://example.org/contact');await flush();assert.equal(env.changes,0);
  gate.resolve(response([row()]));await flush();assert.equal(env.writes,0);assert.equal(env.changes,0);
 } finally {await env.service.close();gate.resolve(response([]));await flush();}
});

test('queue capacity changes notify only enough indexed waiting keys to fill available admission slots',async()=>{
 const gates=[];
 const env=await syntheticMetadata(async()=>{const gate=deferred();gates.push(gate);return gate.promise;});
 try {
  const statuses=[];
  for(let index=0;index<36;index++)statuses.push(env.service.decorateTrack(track('Waiting '+index)).coverMetadataStatus);
  await flush();assert.equal(gates.length,2);assert.deepEqual(statuses.slice(34),['queue-full','queue-full']);
  gates[0].resolve(response([]));await flush();assert.equal(gates.length,3);
  const ids=env.payloads.flatMap(payload=>Array.from(payload.trackIds));
  assert.deepEqual(ids.sort(),['Waiting 0','Waiting 34']);
  assert.equal(env.service.decorateTrack(track('Waiting 34')).coverMetadataStatus,'queued');
  assert.equal(env.service.decorateTrack(track('Waiting 35')).coverMetadataStatus,'queue-full');
 } finally {await env.service.close();for(const gate of gates)gate.resolve(response([]));await flush();}
});
