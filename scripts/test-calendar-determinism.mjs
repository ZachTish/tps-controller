import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
process.env.TZ = 'UTC';
const bundle = await build({stdin:{contents:"export * from './src/services/ical-parser-service.ts'; export * from './src/services/external-calendar-service.ts';",resolveDir:process.cwd(),loader:'ts'},bundle:true,write:false,format:'esm',platform:'node',logLevel:'silent',plugins:[{name:'obsidian-stub',setup(b){b.onResolve({filter:/logger$/},()=>({path:'logger',namespace:'log'}));b.onLoad({filter:/.*/,namespace:'log'},()=>({contents:'export const flow=()=>{}; export const flowWarn=()=>{}; export const flowError=()=>{}; export const errorSummary=String;',loader:'js'}));b.onResolve({filter:/^obsidian$/},()=>({path:'obsidian',namespace:'stub'}));b.onLoad({filter:/.*/,namespace:'stub'},()=>({contents:'export const moment = {}; export const requestUrl = async()=>{ const response=globalThis.__calendarTestResponse; if(response instanceof Error) throw response; return response; };',loader:'js'}));}}]});
const { ICalParserService, ExternalCalendarService }=await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const parser=new ICalParserService();
const component=(uid, fields=[])=>['BEGIN:VEVENT',`UID:${uid}`,'DTSTAMP:20260901T000000Z',...fields,'END:VEVENT'].join('\r\n');
const feed=(...events)=>['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//TPS Test//EN',...events,'END:VCALENDAR'].join('\r\n');
const master=(uid='series',more=[])=>component(uid,['DTSTART:20260924T090000Z','DTEND:20260924T100000Z','SUMMARY:Original','RRULE:FREQ=DAILY;COUNT=3',...more]);
const exception=(uid='series',more=[])=>component(uid,['RECURRENCE-ID:20260925T090000Z','DTSTART:20260925T120000Z','DTEND:20260925T130000Z','SUMMARY:Moved',...more]);
const parse=(input,includeCancelled=true,start='2026-09-23',end='2026-10-01')=>parser.parseICalData(input,new Date(start),new Date(end),includeCancelled,true);

test('a moved instance affects only its UID and preserves original occurrence identity',()=>{
 const rows=parse(feed(master('A'),master('B'),exception('A')));
 assert.equal(rows.length,6);
 assert.equal(rows.filter(e=>e.uid==='B').every(e=>e.startDate.getUTCHours()===9),true);
 const moved=rows.find(e=>e.uid==='A'&&e.startDate.getUTCHours()===12);
 assert.equal(moved.occurrenceIdentity,'A-20260925T090000');
});
test('latest master/exception revisions win independently of feed order, never expand a second series',()=>{
 const old=master('series',['SEQUENCE:1']);
 const newer=master('series',['SEQUENCE:2']).replaceAll('T090000Z','T100000Z').replace('DTEND:20260924T100000Z','DTEND:20260924T110000Z');
 const a=parse(feed(old,newer)),b=parse(feed(newer,old));
 assert.deepEqual(a,b);assert.equal(a.length,3);assert.equal(a.every(e=>e.startDate.getUTCHours()===10),true);
 const ex1=exception('series',['SEQUENCE:1']),ex2=exception('series',['SEQUENCE:2']).replaceAll('T120000Z','T140000Z').replaceAll('T130000Z','T150000Z');
 assert.deepEqual(parse(feed(master(),ex1,ex2)),parse(feed(ex2,master(),ex1)));
 assert.equal(parse(feed(master(),ex1,ex2)).filter(e=>e.title==='Moved').length,1);
});
test('identical repeats collapse; equally ranked conflicting revisions fail closed',()=>{
 assert.equal(parse(feed(master(),master())).length,3);
 assert.throws(()=>parse(feed(master(),master().replace('SUMMARY:Original','SUMMARY:Conflict'))),/Conflicting calendar revisions/);
});
test('THISANDFUTURE shifts remaining occurrences with original identities and one explicit override',()=>{
 const range=exception().replace('RECURRENCE-ID:','RECURRENCE-ID;RANGE=THISANDFUTURE:');
 const rows=parse(feed(master(),range));
 assert.deepEqual(rows.map(e=>e.startDate.getUTCHours()),[9,12,12]);
 assert.deepEqual(rows.map(e=>e.occurrenceIdentity),['series-20260924T090000','series-20260925T090000','series-20260926T090000']);
 const explicit=component('series',['RECURRENCE-ID:20260926T090000Z','DTSTART:20260926T150000Z','DTEND:20260926T160000Z']);
 assert.deepEqual(parse(feed(master(),range,explicit)).map(e=>e.startDate.getUTCHours()),[9,12,15]);
});
test('a recurring exception with RRULE remains one occurrence, never another master',()=>{
 const rows=parse(feed(master(),exception('series',['RRULE:FREQ=DAILY;COUNT=100'])));
 assert.equal(rows.length,3);assert.equal(rows.filter(e=>e.title==='Moved').length,1);
});
test('equivalent UTC and TZID recurrence identifiers resolve to the master clock',()=>{
 const local=master().replace('DTSTART:20260924T090000Z','DTSTART;TZID=America/Chicago:20260924T090000').replace('DTEND:20260924T100000Z','DTEND;TZID=America/Chicago:20260924T100000');
 const moved=exception().replace('RECURRENCE-ID:20260925T090000Z','RECURRENCE-ID:20260925T140000Z');
 const rows=parse(feed(local,moved));assert.equal(rows.length,3);
 assert.equal(rows.find(e=>e.title==='Moved').occurrenceIdentity,'series-20260925T090000');
 assert.equal(rows.filter(e=>e.title==='Original').every(e=>e.startDate.getUTCHours()===14),true);
});
test('moved occurrence enters the requested window despite original date outside it',()=>{
 const moved=exception().replaceAll('20260925T120000Z','20260928T120000Z').replaceAll('20260925T130000Z','20260928T130000Z');
 const rows=parse(feed(master(),moved),true,'2026-09-28','2026-09-29');
 assert.equal(rows.length,1);assert.equal(rows[0].occurrenceIdentity,'series-20260925T090000');
});
test('range shift can move an original future occurrence back into the requested window',()=>{
 const m=master().replace('COUNT=3','COUNT=10');
 const moved=exception().replace('RECURRENCE-ID:','RECURRENCE-ID;RANGE=THISANDFUTURE:').replace('20260925T120000Z','20260923T120000Z').replace('20260925T130000Z','20260923T130000Z');
 const rows=parse(feed(m,moved),true,'2026-09-29','2026-09-30');
 assert.equal(rows.length,1);assert.equal(rows[0].occurrenceIdentity,'series-20261001T090000');
});
test('cancelled masters and exceptions do not resurrect their original active occurrences',()=>{
 assert.equal(parse(feed(master('series',['STATUS:CANCELLED'])),false).length,0);
 const rows=parse(feed(master(),exception('series',['STATUS:CANCELLED'])),false);
 assert.equal(rows.length,2);assert.equal(rows.some(e=>e.occurrenceIdentity==='series-20260925T090000'),false);
});
test('malformed responses and invalid timing fail instead of reporting an empty successful feed',()=>{
 assert.throws(()=>parse('<html>Error</html>'),/not an iCalendar/);
 assert.throws(()=>parse(feed(component('broken',['SUMMARY:No start']))),/missing DTSTART/);
 assert.throws(()=>parse(feed(component('broken',['DTSTART:20260924T100000Z','DTEND:20260924T090000Z']))),/invalid timing/);
 assert.throws(()=>parse(feed(master('dense').replace('FREQ=DAILY;COUNT=3','FREQ=SECONDLY;COUNT=20000'))),/expansion limit/);
});
test('all-day recurrence identity and EXDATE/RDATE survive moved exceptions',()=>{
 const m=component('day',['DTSTART;VALUE=DATE:20260924','DTEND;VALUE=DATE:20260925','RRULE:FREQ=DAILY;COUNT=3','EXDATE;VALUE=DATE:20260925','RDATE;VALUE=DATE:20260928']);
 const ex=component('day',['RECURRENCE-ID;VALUE=DATE:20260926','DTSTART;VALUE=DATE:20260927','DTEND;VALUE=DATE:20260928']);
 const rows=parse(feed(m,ex));assert.equal(rows.length,3);assert.equal(rows.every(e=>e.isAllDay),true);
 assert.ok(rows.some(e=>e.occurrenceIdentity==='day-20260926T000000'&&e.startDate.toISOString().startsWith('2026-09-27')));
});


test('HTTP 200 partial/malformed feed is a failed fetch, never a cached successful empty calendar',async()=>{
 const service=new ExternalCalendarService();globalThis.__calendarTestResponse={status:200,text:feed(master()).replace('END:VCALENDAR','')};
 const args=['https://calendar.example.test/events.ics',new Date('2026-09-23'),new Date('2026-10-01'),true];
 const failed=await service.fetchEventsWithStatus(...args);assert.equal(failed.ok,false);assert.deepEqual(failed.events,[]);
 globalThis.__calendarTestResponse={status:200,text:feed(master())};const recovered=await service.fetchEventsWithStatus(...args);
 assert.equal(recovered.ok,true);assert.equal(recovered.fromCache,false);assert.equal(recovered.events.length,3);delete globalThis.__calendarTestResponse;
});

test('timezone conversion keeps wall-clock recurrence across both DST boundaries and midnight',()=>{
 for(const [day,time,expected] of [
  ['20260308','033000','2026-03-08T08:30:00.000Z'],
  ['20261101','033000','2026-11-01T09:30:00.000Z'],
  ['20260924','000000','2026-09-24T05:00:00.000Z'],
  ['20260308','013000','2026-03-08T07:30:00.000Z'],
  ['20261101','013000','2026-11-01T06:30:00.000Z'],
 ]){
  const row=parse(feed(component('dst',[`DTSTART;TZID=America/Chicago:${day}T${time}`,'DURATION:PT30M'])),true,'2026-01-01','2027-01-01')[0];
  assert.equal(row.startDate.toISOString(),expected,day+' '+time);
 }
});

test('distinct DTSTART and DTEND timezones represent the same intended interval',()=>{
 const row=parse(feed(component('zones',['DTSTART;TZID=America/Chicago:20260924T090000','DTEND;TZID=America/New_York:20260924T110000'])))[0];
 assert.equal(row.startDate.toISOString(),'2026-09-24T14:00:00.000Z');assert.equal(row.endDate.toISOString(),'2026-09-24T15:00:00.000Z');
});

test('unresolved explicit timezone fails instead of interpreting it in the machine timezone',()=>{
 assert.throws(()=>parse(feed(component('unknown',['DTSTART;TZID=Unknown/Custom:20260924T090000','DURATION:PT1H']))),/timezone/i);
});

test('a cancelled detached instance may omit DTSTART without resurrecting the master occurrence',()=>{
 const cancelled=component('series',['RECURRENCE-ID:20260925T090000Z','STATUS:CANCELLED','SEQUENCE:2']);
 const rows=parse(feed(master(),cancelled));assert.equal(rows.length,3);assert.equal(rows.filter(e=>e.isCancelled).length,1);
 assert.equal(parse(feed(master(),cancelled),false).length,2);
});

test('seeded feed permutations across 25 series and 100 orders produce identical instances',()=>{
 const parts=[];for(let i=0;i<25;i++){parts.push(master('stress-'+i),exception('stress-'+i,['SEQUENCE:2']),exception('stress-'+i,['SEQUENCE:1']));}
 const expected=parse(feed(...parts));assert.equal(expected.length,75);
 let seed=2401;const next=()=>((seed=(Math.imul(seed,1664525)+1013904223)>>>0)/2**32);
 for(let run=0;run<100;run++){
  const shuffled=[...parts,parts[run%parts.length]];for(let i=shuffled.length-1;i>0;i--){const j=Math.floor(next()*(i+1));[shuffled[i],shuffled[j]]=[shuffled[j],shuffled[i]];}
  assert.deepEqual(parse(feed(...shuffled)),expected,`permutation ${run}`);
 }
});

test('DST gap, elapsed hours, nominal days and DTEND recurrence duration follow iCalendar semantics',()=>{
 const one=(start,interval)=>parse(feed(component('duration',[`DTSTART;TZID=America/Chicago:${start}`,interval])),true,'2026-01-01','2027-01-01')[0];
 assert.equal(one('20260308T023000','DURATION:PT1H').startDate.toISOString(),'2026-03-08T08:30:00.000Z');
 assert.equal(one('20261101T013000','DURATION:PT2H').endDate.toISOString(),'2026-11-01T08:30:00.000Z');
 assert.equal(one('20261101T000000','DURATION:P1D').endDate.toISOString(),'2026-11-02T06:00:00.000Z');
 assert.equal(one('20261101T000000','DURATION:PT24H').endDate.toISOString(),'2026-11-02T05:00:00.000Z');
 const rows=parse(feed(component('exact',['DTSTART;TZID=America/Chicago:20260307T013000','DTEND;TZID=America/Chicago:20260307T033000','RRULE:FREQ=DAILY;COUNT=3'])),true,'2026-03-06','2026-03-11');
 assert.deepEqual(rows.map(e=>(e.endDate-e.startDate)/3600000),[2,2,2]);assert.equal(rows[1].endDate.toISOString(),'2026-03-08T09:30:00.000Z');
});

test('feed-local VTIMEZONE survives detached exception normalization',()=>{
 const zone=['BEGIN:VTIMEZONE','TZID:Custom/Office','BEGIN:STANDARD','DTSTART:19700101T000000','TZOFFSETFROM:+0230','TZOFFSETTO:+0230','END:STANDARD','END:VTIMEZONE'].join('\r\n');
 const m=component('custom',['DTSTART;TZID=Custom/Office:20260924T090000','DTEND;TZID=Custom/Office:20260924T100000','RRULE:FREQ=DAILY;COUNT=2']);
 const ex=component('custom',['RECURRENCE-ID:20260925T063000Z','DTSTART:20260925T100000Z','DTEND:20260925T110000Z']);
 const rows=parse(feed(zone,m,ex));assert.equal(rows.length,2);assert.equal(rows[0].startDate.toISOString(),'2026-09-24T06:30:00.000Z');
 assert.equal(rows[1].startDate.toISOString(),'2026-09-25T10:00:00.000Z');assert.equal(rows[1].occurrenceIdentity,'custom-20260925T090000');
});

test('zoned events stay identical across device zones; all-day dates keep their calendar day',()=>{
 const original=process.env.TZ;
 try{
  for(const device of ['UTC','America/Los_Angeles','Asia/Kolkata','Pacific/Auckland']){
   process.env.TZ=device;
   const row=parse(feed(component('zone',['DTSTART;TZID=America/Chicago:20261101T033000','DURATION:PT1H'])),true,'2026-01-01','2027-01-01')[0];
   assert.equal(row.startDate.toISOString(),'2026-11-01T09:30:00.000Z',device);
   const day=parse(feed(component('date',['DTSTART;VALUE=DATE:20260308','DTEND;VALUE=DATE:20260310'])),true,'2026-01-01','2027-01-01')[0];
   assert.equal(day.startDate.getDate(),8);assert.equal(day.endDate.getDate(),10);assert.equal(day.isAllDay,true);
  }
 }finally{process.env.TZ=original;}
});


test('HTTP failures, network errors, timeouts and conflicting revisions never become successful empty calendars',async()=>{
 const service=new ExternalCalendarService();service.FETCH_TIMEOUT_MS=10;
 const args=['https://calendar.example.test/failure.ics',new Date('2026-09-23'),new Date('2026-10-01'),true,true];
 globalThis.__calendarTestResponse={status:200,text:feed(master())};assert.equal((await service.fetchEventsWithStatus(...args)).events.length,3);
 for(const response of [{status:401,text:''},{status:404,text:''},{status:500,text:''},new Error('offline'),new Promise(()=>{}),{status:200,text:feed(master(),master().replace('SUMMARY:Original','SUMMARY:Conflict'))}]){
  globalThis.__calendarTestResponse=response;const result=await service.fetchEventsWithStatus(...args);assert.equal(result.ok,false);assert.deepEqual(result.events,[]);assert.equal(result.fromCache,false);
 }
 globalThis.__calendarTestResponse={status:200,text:feed(master())};const recovered=await service.fetchEventsWithStatus(...args);assert.equal(recovered.ok,true);assert.equal(recovered.events.length,3);delete globalThis.__calendarTestResponse;
});

test('zoned recurring calendar volume expands 2600 unique occurrences with stable identities',t=>{
 const parts=Array.from({length:100},(_,i)=>component('volume-'+i,['DTSTART;TZID=America/Chicago:20260102T090000','DTEND;TZID=America/Chicago:20260102T100000','RRULE:FREQ=WEEKLY;COUNT=26']));
 const began=performance.now();const rows=parse(feed(...parts),true,'2026-01-01','2027-01-01');
 assert.equal(rows.length,2600);assert.equal(new Set(rows.map(e=>e.occurrenceIdentity)).size,2600);assert.equal(rows.every(e=>+e.endDate-+e.startDate===3600000),true);
 t.diagnostic(`2600 zoned occurrences in ${Math.round(performance.now()-began)} ms; synthetic Node timing, not a device benchmark`);
});

test('embedded DST definitions use the first repeated time and the pre-gap offset',()=>{
 const zone=['BEGIN:VTIMEZONE','TZID:Custom/DST','BEGIN:STANDARD','DTSTART:19701101T020000','RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU','TZOFFSETFROM:-0500','TZOFFSETTO:-0600','END:STANDARD','BEGIN:DAYLIGHT','DTSTART:19700308T020000','RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU','TZOFFSETFROM:-0600','TZOFFSETTO:-0500','END:DAYLIGHT','END:VTIMEZONE'].join('\r\n');
 for(const [local,expected] of [['20261101T013000','2026-11-01T06:30:00.000Z'],['20260308T023000','2026-03-08T08:30:00.000Z'],['20260308T033000','2026-03-08T08:30:00.000Z']]){
  const rows=parse(feed(zone,component('embedded',[`DTSTART;TZID=Custom/DST:${local}`,'DURATION:PT1H'])),true,'2026-01-01','2027-01-01');
  assert.equal(rows[0].startDate.toISOString(),expected);
 }
 const m=component('embedded',['DTSTART;TZID=Custom/DST:20261031T013000','DURATION:PT1H','RRULE:FREQ=DAILY;COUNT=3']);
 const ex=component('embedded',['RECURRENCE-ID:20261101T063000Z','DTSTART:20261101T093000Z','DTEND:20261101T103000Z']);
 const moved=parse(feed(zone,m,ex),true,'2026-10-30','2026-11-04');
 assert.equal(moved.length,3);assert.equal(moved[1].occurrenceIdentity,'embedded-20261101T013000');assert.equal(moved[1].startDate.toISOString(),'2026-11-01T09:30:00.000Z');
});
