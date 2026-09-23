import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
process.env.TZ = 'UTC';
const bundle = await build({stdin:{contents:"export * from './src/services/ical-parser-service.ts'; export * from './src/services/external-calendar-service.ts';",resolveDir:process.cwd(),loader:'ts'},bundle:true,write:false,format:'esm',platform:'node',logLevel:'silent',plugins:[{name:'obsidian-stub',setup(b){b.onResolve({filter:/logger$/},()=>({path:'logger',namespace:'log'}));b.onLoad({filter:/.*/,namespace:'log'},()=>({contents:'export const flow=()=>{}; export const flowWarn=()=>{}; export const flowError=()=>{}; export const errorSummary=String;',loader:'js'}));b.onResolve({filter:/^obsidian$/},()=>({path:'obsidian',namespace:'stub'}));b.onLoad({filter:/.*/,namespace:'stub'},()=>({contents:'export const moment = {}; export const requestUrl = async()=>globalThis.__calendarTestResponse;',loader:'js'}));}}]});
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
