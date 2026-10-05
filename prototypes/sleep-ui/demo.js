/* Standalone UI study. Deterministic synthetic fixtures; no network or storage. */
(() => {
  'use strict';
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const anchor = '2026-09-16';
  const shift = (date, days) => new Date(Date.parse(`${date}T12:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
  const dateLabel = (date, options = {month:'short', day:'numeric'}) => new Date(`${date}T12:00:00Z`).toLocaleDateString('en-CA', {...options, timeZone:'UTC'});
  const duration = min => `${Math.floor(Math.round(min) / 60)}h ${String(Math.round(min) % 60).padStart(2, '0')}m`;
  const clock = min => `${String(Math.floor(((min % 1440) + 1440) % 1440 / 60)).padStart(2, '0')}:${String(Math.floor(((min % 60) + 60) % 60)).padStart(2, '0')}`;
  const mean = values => values.length ? values.reduce((a,b) => a+b, 0) / values.length : null;
  const colors = {awake:'#eba96c', rem:'#c78add', light:'#81a9ed', deep:'#8e7be0'};
  const stageNames = {awake:'Awake',rem:'REM',light:'Light',deep:'Deep'};
  const factors = ['caffeine','late meal','stress','alcohol','illness','travel','heat','noise'];
  const ratings = ['Very tired','Somewhat tired','Okay','Rested','Very rested'];
  const icons = {
    note:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 4H5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-8M14 4l6 6M9 15l2-6 7-7 4 4-7 7-6 2Z"/></svg>',
  };
  const fixtures = new Map();
  const checkins = new Map();
  for (let i = 183; i >= 0; i--) {
    const date = shift(anchor, -i);
    if ([4,19,42,83,130,171].includes(i)) continue;
    const asleep = i === 0 ? 414 : Math.round(459 + 34 * Math.sin(i * .73) - (i % 3 === 0 ? 31 : 0) - i * .16);
    const awake = i === 0 ? 8 : 9 + (i * 7 % 24);
    const deep = i === 0 ? 68 : Math.round(asleep * (.155 + .032 * Math.sin(i * .89)));
    const rem = i === 0 ? 98 : Math.round(asleep * (.235 + .021 * Math.cos(i * .63)));
    const bedtime = i === 0 ? 180 : Math.round(70 + 68 * Math.sin(i * .38));
    fixtures.set(date, {date, asleep, awake, deep, rem, light:asleep-deep-rem, bedtime,
      heart:Math.round(56 + 4 * Math.sin(i*.53)), hrv:+(39.5+7*Math.sin(i*.42)).toFixed(1),
      spo2:i === 2 ? null : +(96.4+.6*Math.sin(i*.51)).toFixed(1), breathing:+(15.2+.6*Math.cos(i*.35)).toFixed(1),
      temperature:i === 6 ? null : +(.12*Math.sin(i*.59)).toFixed(2), calories:Math.round(2500+550*Math.cos(i*.44)),
      onset:8 + i%13, nap:i===1 || i===7 || i===16, seed:i});
    if (i > 0 && i % 11 !== 0) {
      const context = [];
      if (i%3===0) context.push('caffeine');
      if (i%6<2) context.push('late meal');
      if (i%9===0) context.push('stress');
      if (i%13===0) context.push('alcohol');
      if (i%37===0) context.push('illness');
      if (i%43===0) context.push('travel');
      if (i%23===0) context.push('heat');
      if (i%17===0) context.push('noise');
      checkins.set(date, {rating:1+i%5, awakenings:i%3, context, reviewed:i%7!==1});
    }
  }
  checkins.set(anchor, {rating:4, awakenings:1, context:[], reviewed:true});
  const dates = [...fixtures.keys()].sort();
  const query = new URLSearchParams(location.search);
  const pages = ['night','trends','patterns'];
  const state = {
    page:pages.includes(query.get('page')) ? query.get('page') : 'night',
    date:/^\d{4}-\d{2}-\d{2}$/.test(query.get('date') ?? '') && Number.isFinite(Date.parse(query.get('date'))) ? query.get('date') : anchor,
    session:'main', days:30, factor:'caffeine', cursor:.48, goal:420,
  };
  const button = (label, attributes='', classes='') => `<button type="button" class="button ${classes}" ${attributes}>${label}</button>`;
  const badge = (text, classes='') => `<span class="badge ${classes}">${text}</span>`;
  const periodButtons = () => `<div class="period-control"><div class="segmented" role="group" aria-label="Comparison period">${[7,30,90].map(n=>`<button data-days="${n}" aria-pressed="${state.days===n}">${n} days</button>`).join('')}</div></div>`;
  const currentNight = () => fixtures.get(state.date);
  const session = () => {const n=currentNight(); return !n ? null : state.session==='nap' && n.nap ? {...n,asleep:45,awake:3,deep:5,rem:9,light:31,bedtime:890,onset:4,isNap:true} : {...n,isNap:false};};
  const periodNights = (previous=false) => {
    const end=shift(state.date, previous ? -state.days : 0), start=shift(end,1-state.days);
    return [...fixtures.values()].filter(n=>n.date>=start && n.date<=end);
  };
  function updateUrl() {
    const params=new URLSearchParams({page:state.page,date:state.date});
    try {history.replaceState(null,'',`${location.pathname}?${params}`);} catch { /* file previews may restrict history */ }
  }
  function dateControls() {
    const prev=dates.filter(d=>d<state.date).at(-1), next=dates.find(d=>d>state.date);
    return `<div class="date-control" aria-label="Browse recorded nights">${button('<span class="arrow" aria-hidden="true">‹</span> Previous night',`data-date="${prev??''}" ${prev?'':'disabled'}`)}<label class="date-field"><span>Wake date</span><input type="date" id="wake-date" value="${escape(state.date)}" min="${dates[0]}" max="${anchor}"></label>${button('Next night <span class="arrow" aria-hidden="true">›</span>',`data-date="${next??''}" ${next?'':'disabled'}`)}${button('Latest recorded night',`data-date="${anchor}" ${state.date===anchor?'disabled':''}`,'latest')}</div>`;
  }
  function nightHeading() {
    const n=session();
    return `<div class="page-heading"><div><h1>${dateLabel(state.date,{weekday:'long',month:'long',day:'numeric'})}</h1>${n?`<div class="session-line"><label for="session-select" class="sr-only">Sleep session</label><select id="session-select"><option value="main" ${state.session==='main'?'selected':''}>Main sleep${currentNight().nap?' · '+duration(currentNight().asleep):''}</option>${currentNight().nap?`<option value="nap" ${state.session==='nap'?'selected':''}>Afternoon nap · 45m</option>`:''}</select><span>${clock(n.bedtime)}–${clock(n.bedtime+n.asleep+n.awake)} <span class="muted">· recorded local time</span></span></div>`:'<p>No sleep recorded for this wake date.</p>'}</div>${dateControls()}</div>`;
  }
  function summary(n) {
    const diff=n.asleep-state.goal;
    const headline=n.isNap?'Nap':diff===0?'Goal met':`${Math.abs(diff)} min ${diff<0?'below':'above'} goal`;
    const description=n.isNap?'Excluded from the main-sleep goal.':`Goal: ${duration(state.goal)} · ${n.awake} min awake.`;
    return `<section class="night-summary" aria-label="Night summary"><div class="summary-intro"><div class="summary-title"><span class="status-ring"></span>${headline}</div><p>${description}</p></div><dl class="stat"><dt>Time asleep</dt><dd>${duration(n.asleep)}</dd><small>${duration(n.asleep+n.awake)} recorded</small></dl><dl class="stat"><dt>Sleep efficiency</dt><dd>${Math.round(n.asleep/(n.asleep+n.awake)*100)}<small class="sr-only"> percent</small><span aria-hidden="true">%</span></dd><small>Time asleep ÷ recording</small></dl><dl class="stat"><dt>Deep sleep</dt><dd>${duration(n.deep)}</dd><small>${Math.round(n.deep/n.asleep*100)}% of time asleep</small></dl><dl class="stat"><dt>REM sleep</dt><dd>${duration(n.rem)}</dd><small>${Math.round(n.rem/n.asleep*100)}% of time asleep</small></dl></section>`;
  }
  function stages(n) {
    const order=['light','deep','light','rem','awake','light','deep','light','rem','light','awake','light','deep','light','rem','awake','light','rem','light','awake'];
    const weights=[.10,.42,.06,.13,.2,.10,.35,.08,.20,.05,.3,.10,.23,.10,.29,.2,.10,.38,.31,.3];
    const remaining={light:n.light,deep:n.deep,rem:n.rem,awake:n.awake};
    const totals=Object.fromEntries(Object.keys(remaining).map(k=>[k,order.reduce((v,s,i)=>v+(s===k?weights[i]:0),0)]));
    let start=0;
    return order.map((stage,i)=>{
      const last=order.lastIndexOf(stage)===i;
      const count=last?remaining[stage]:Math.round(n[stage]*weights[i]/totals[stage]);
      remaining[stage]-=count;
      const item={stage,start,end:start+count};start+=count;return item;
    }).filter(s=>s.end>s.start);
  }
  function signal(n,key,index) {
    if(key==='spo2' && (n.spo2===null || (index>=34&&index<=45) || (index>=116&&index<=122)))return null;
    if(key==='hrv' && index>=73&&index<=79)return null;
    const wiggle=Math.sin(index*2.31+n.seed)*.65+Math.cos(index*.67)*.4;
    if(key==='heart')return n.heart+2.8*Math.sin(index*.09)+3.2*Math.cos(index*.023)+wiggle*2.3+(index>174?(index-174)*.24:0);
    if(key==='spo2')return n.spo2+.8*Math.sin(index*.06)+.45*Math.cos(index*.21)+wiggle*.16;
    return n.hrv+8*Math.sin(index*.046)+4*Math.cos(index*.16)+wiggle*2.8;
  }
  function trace(n,key,top,width=1100,height=65) {
    const ranges={heart:[43,77],spo2:[93,99],hrv:[16,68]}, [min,max]=ranges[key];
    let d='',active=false;
    for(let i=0;i<=200;i++){
      const value=signal(n,key,i);
      if(value===null){active=false;continue;}
      const x=i/200*width, y=top+height-10-(value-min)/(max-min)*(height-20);
      d+=`${active?'L':'M'}${x.toFixed(1)},${y.toFixed(1)} `;active=true;
    }
    return d;
  }
  function timeline(n) {
    const tracks=['heart','spo2','hrv'];
    const height=116+65*tracks.length, total=n.asleep+n.awake;
    const ys={awake:7,rem:32,light:57,deep:82};
    const entries=stages(n);
    const rects=entries.map((s,i)=>{const x=s.start/total*1100,w=(s.end-s.start)/total*1100, y=ys[s.stage]; return `${i?`<line class="stage-join" x1="${x}" x2="${x}" y1="${ys[entries[i-1].stage]+7}" y2="${y+7}"/>`:''}<rect x="${x}" y="${y}" width="${Math.max(.5,w-.5)}" height="14" rx="1" fill="${colors[s.stage]}"/>`;}).join('');
    const configs={heart:['Heart rate','bpm','var(--accent)'],spo2:['SpO₂','%','var(--rem)'],hrv:['HRV','ms','var(--deep)']};
    return `<section class="timeline-panel" aria-labelledby="timeline-heading"><div class="section-heading"><div class="timeline-heading"><h2 id="timeline-heading">Overnight timeline</h2>${badge(`${duration(total)} recording`)}</div><div class="timeline-tools"><div class="legend">${Object.keys(colors).map(k=>`<span><i class="dot ${k}"></i>${stageNames[k]}</span>`).join('')}</div></div></div><div class="timeline-chart"><div class="track-labels"><div class="stage-labels"><span>Awake</span><span>REM</span><span>Light</span><span>Deep</span></div>${tracks.map(k=>`<div class="track-label signal"><strong>${configs[k][0]}</strong><small>${configs[k][1]}</small></div>`).join('')}</div><div class="plot" id="night-plot"><svg id="timeline-svg" viewBox="0 0 1100 ${height}" height="${height}" preserveAspectRatio="none" role="img" aria-label="Synthetic sleep stages and overnight measurements. Use the inspection slider below for values.">${[20,45,70,95,...tracks.map((_,i)=>116+i*65)].map(y=>`<line class="line-grid" x1="0" x2="1100" y1="${y}" y2="${y}"/>`).join('')}${rects}${tracks.map((key,i)=>`<path class="trace" stroke="${configs[key][2]}" d="${trace(n,key,116+i*65)}"/>${key==='spo2'&&n.spo2===null?`<text x="550" y="${116+i*65+36}" fill="#a4b0bd" text-anchor="middle" font-size="14">No readings recorded</text>`:''}`).join('')}<line class="cursor-line" id="chart-cursor" x1="${state.cursor*1100}" x2="${state.cursor*1100}" y1="0" y2="${height}"/></svg><div class="time-axis">${[0,.25,.5,.75,1].map(f=>`<span>${clock(n.bedtime+total*f)}</span>`).join('')}</div><label class="sr-only" for="inspector">Inspect time across the night</label><input type="range" class="inspector" id="inspector" min="0" max="1000" step="1" value="${Math.round(state.cursor*1000)}"></div></div><p class="chart-caption">Move across the chart, or use the slider and arrow keys. Gaps mean no recorded reading.</p><div id="chart-readout" class="chart-readout" aria-live="off"></div></section>`;
  }
  function updateCursor(value) {
    const n=session();if(!n || !$('#chart-cursor'))return;
    state.cursor=Math.max(0,Math.min(1,value));
    const x=state.cursor*1100;
    $('#chart-cursor').setAttribute('x1',x);$('#chart-cursor').setAttribute('x2',x);
    $('#inspector').value=Math.round(state.cursor*1000);
    const elapsed=Math.min(n.asleep+n.awake-.001,state.cursor*(n.asleep+n.awake));
    const stage=stages(n).find(s=>s.start<=elapsed && s.end>elapsed)?.stage;
    const index=Math.round(state.cursor*200);
    const values=['heart','spo2','hrv'].map(k=>signal(n,k,index));
    const reading=(v,unit)=>v===null?'No reading':`${Number(v.toFixed(unit==='bpm'?0:1))} ${unit}`;
    const time=clock(n.bedtime+elapsed);
    $('#chart-readout').innerHTML=`<span class="readout-time">${time}</span><span class="readout-stage"><i class="dot ${stage}"></i>${stageNames[stage]}</span>${['Heart rate','SpO₂','HRV'].map((label,i)=>`<span class="muted">${label}<strong>${reading(values[i],['bpm','%','ms'][i])}</strong></span>`).join('')}`;
    $('#inspector').setAttribute('aria-valuetext',`${time}, ${stageNames[stage]}, heart rate ${reading(values[0],'bpm')}, oxygen ${reading(values[1],'%')}, HRV ${reading(values[2],'ms')}`);
  }
  function measurements(n) {
    const data=[['Daily HRV',`${n.hrv} <small>ms</small>`,'Provider-date summary'],['Breathing rate',`${n.breathing} <small>breaths/min</small>`,'Sleep summary'],['Daily SpO₂',n.spo2===null?'Not recorded':`${n.spo2} <small>%</small>`,'Provider-date estimate'],['Temperature change',n.temperature===null?'Not recorded':`${n.temperature>0?'+':''}${n.temperature} <small>°C</small>`,'Provider baseline'],['Time to fall asleep',`${n.onset} <small>min</small>`,'Selected session']];
    return `<section aria-label="Supporting measurements"><div class="support-heading"><h2>Supporting measurements</h2><p>Daily summaries for ${dateLabel(n.date)}; separate from overnight readings.</p></div><dl class="measurement-row">${data.map(([label,value,note])=>`<div><dt>${label}</dt><dd>${value}</dd><div class="measure-note">${note}</div></div>`).join('')}</dl></section>`;
  }
  function checkinStrip() {
    const entry=checkins.get(state.date);
    return `<div class="checkin-strip"><div><h3>${icons.note} ${entry?'Sample morning check-in':'Morning check-in not recorded'}</h3><p>${entry?`${entry.rating?ratings[entry.rating-1]:'Restfulness unanswered'} · ${entry.context.length?escape(entry.context.join(', ')):entry.reviewed?'No unusual factors':'Factors not reviewed'}`:'This synthetic night has no check-in.'}</p><p class="demo-unavailable">Editing is not available in the public demo.</p></div>${badge('Read only')}</div>`;
  }
  function assessment() {
    return `<details class="explainer"><summary>Metric definitions</summary><p>Time asleep excludes awake minutes. Efficiency = time asleep ÷ recorded duration. Daily summaries use the provider date. Stage duration alone does not indicate sleep quality.</p></details>`;
  }
  function nightPage() {
    const n=session();
    if(!n)return `${nightHeading()}<section class="empty-state"><div class="empty-symbol" aria-hidden="true">☾</div><h2>No sleep recorded</h2><p>No session for ${dateLabel(state.date)}. Missing data is not zero sleep.</p><div class="empty-actions">${button('Latest recorded night',`data-date="${anchor}"`,'primary')}${button('View sleep trends','data-page="trends"')}</div></section>`;
    return `${nightHeading()}${summary(n)}${timeline(n)}${measurements(n)}${checkinStrip()}${assessment()}`;
  }
  const metricConfig = {
    asleep:{label:'Time asleep', unit:'min', min:240,max:600,ticks:['10h','8h','6h','4h'],format:duration,color:'#bedb98'},
    bedtime:{label:'Bedtime',unit:'min',min:-60,max:240,ticks:['04:00','02:20','00:40','23:00'],format:clock,color:'#81a9ed'},
    deep:{label:'Deep sleep',unit:'min',min:0,max:150,ticks:['2h 30','1h 40','50m','0'],format:duration,color:'#8e7be0'},
    rem:{label:'REM sleep',unit:'min',min:0,max:180,ticks:['3h','2h','1h','0'],format:duration,color:'#c78add'},
    hrv:{label:'HRV',unit:'ms',min:15,max:70,ticks:['70','50','30','15'],format:v=>`${v.toFixed(1)} ms`,color:'#bedb98'},
    heart:{label:'Heart rate',unit:'bpm',min:40,max:75,ticks:['75','63','52','40'],format:v=>`${Math.round(v)} bpm`,color:'#81a9ed'},
  };
  function trendChart(metric) {
    const config=metricConfig[metric], values=periodNights(), first=shift(state.date,1-state.days), width=1100, height=160;
    const y=v=>height-(v-config.min)/(config.max-config.min)*height;
    const w=width/state.days;
    const marks=Array.from({length:state.days},(_,i)=>{
      const date=shift(first,i),n=values.find(n=>n.date===date);if(!n)return '';
      const value=n[metric], top=y(value);
      return `<rect x="${i*w+w*.16}" y="${top}" width="${Math.max(1,w*.68)}" height="${height-top}" fill="${config.color}" opacity="${date===state.date?1:.64}" rx="1"><title>${dateLabel(date)}: ${config.format(value)}</title></rect>`;
    }).join('');
    return `<div class="trend-chart"><div class="trend-y">${config.ticks.map(t=>`<span>${t}</span>`).join('')}</div><div class="trend-plot"><svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="${escape(config.label)} over ${state.days} days. ${values.length} recorded nights. Gaps indicate missing nights.">${[0,1/3,2/3,1].map(f=>`<line x1="0" x2="1100" y1="${height*f}" y2="${height*f}" stroke="#28333e" stroke-width="1" vector-effect="non-scaling-stroke"/>`).join('')}${marks}${metric==='asleep'?`<line class="goal-line" x1="0" x2="1100" y1="${y(state.goal)}" y2="${y(state.goal)}"/>`:''}</svg></div></div><div class="trend-x">${[0,.25,.5,.75,1].map(f=>`<span>${dateLabel(shift(first,Math.floor((state.days-1)*f)))}</span>`).join('')}</div>`;
  }
  function trendPanel(metric,compact=false) {
    const c=metricConfig[metric],current=mean(periodNights().map(n=>n[metric])),previous=mean(periodNights(true).map(n=>n[metric]));
    const required={7:4,30:15,90:45}[state.days];
    const enough=periodNights().length>=required&&periodNights(true).length>=required;
    const diff=enough&&current!==null&&previous!==null?current-previous:null;
    const change=diff===null?'Not enough data':`${diff>=0?'+':'−'}${Math.abs(diff).toFixed(c.unit==='ms'?1:0)} ${c.unit}`;
    return `<section class="trend-panel"><div class="section-heading"><h2>${c.label}</h2>${metric==='asleep'?`<div class="legend"><span><i class="dot accent"></i>Asleep</span><span>‐‐ ${duration(state.goal)} goal</span></div>`:`<span class="subtext">${metric==='bedtime'?'Recorded local time':'Main sleep only'}</span>`}</div><div class="trend-summary"><div><div class="trend-value">${current===null?'No data':c.format(current)}<small>average</small></div><p>${periodNights().length} recorded nights in this period</p></div>${!compact?`<div class="trend-delta">${change}<small>vs. previous ${state.days} days${metric==='bedtime'?' · later / earlier':''}</small></div>`:''}</div>${trendChart(metric)}</section>`;
  }
  function comparisonTable() {
    const a=periodNights(),b=periodNights(true),required={7:4,30:15,90:45}[state.days],enough=a.length>=required&&b.length>=required;
    return `<div class="table-heading"><h2>Period comparison</h2><span class="subtext">${a.length} nights vs. ${b.length} nights</span></div><div class="table-wrap"><table><thead><tr><th>Measurement</th><th>Current ${state.days} days</th><th>Previous ${state.days} days</th><th>Change</th></tr></thead><tbody>${Object.entries(metricConfig).map(([k,c])=>{const x=mean(a.map(n=>n[k])),y=mean(b.map(n=>n[k])),diff=x!==null&&y!==null?x-y:null;return `<tr><td>${c.label}</td><td>${x===null?'No data':c.format(x)}</td><td>${y===null?'No data':c.format(y)}</td><td>${enough&&diff!==null?`${diff>=0?'+':'−'}${Math.abs(diff).toFixed(c.unit==='ms'?1:0)} ${c.unit}`:'Not enough nights'}</td></tr>`;}).join('')}</tbody></table></div><p class="trend-note">Each comparison needs ${required} usable nights in each period. Changes describe the measurements; higher or lower is not automatically better.</p>`;
  }
  function trendsPage() {
    return `<div class="page-heading"><div><h1>Sleep trends</h1></div>${periodButtons()}</div><div class="range-note"><span>${dateLabel(shift(state.date,1-state.days))} – ${dateLabel(state.date,{month:'short',day:'numeric',year:'numeric'})} · compared with the preceding ${state.days} days</span><span>Main sleep only · gaps remain visible</span></div>${trendPanel('asleep')}<div class="trend-panels">${trendPanel('bedtime',true)}${trendPanel('deep',true)}</div>${comparisonTable()}`;
  }
  function factorComparison(factor) {
    const nights=periodNights();
    const groupA=[],groupB=[];
    for(const n of nights){const entry=checkins.get(n.date);if(!entry)continue;
      if(factor==='restfulness'){if(entry.rating>=4)groupA.push(n);else if(entry.rating&&entry.rating<=2)groupB.push(n);}
      else if(entry.context.includes(factor))groupA.push(n);else if(entry.reviewed)groupB.push(n);
    }
    const a=mean(groupA.map(n=>n.asleep)),b=mean(groupB.map(n=>n.asleep));
    return {groupA,groupB,a,b,difference:a!==null&&b!==null?a-b:null,enough:groupA.length>=7&&groupB.length>=7};
  }
  const factorName = factor => factor==='restfulness'?'Restfulness':factor[0].toUpperCase()+factor.slice(1);
  const factorLabels = factor => factor==='restfulness'?['Rested / very rested','Tired / very tired']:[`${factorName(factor)} recorded`,`${factorName(factor)} absent after review`];
  const factorResult = c => c.enough?`${c.difference>=0?'+':'−'}${Math.abs(Math.round(c.difference))} min`:'Insufficient data';
  function factorDetail() {
    const c=factorComparison(state.factor),labels=factorLabels(state.factor);
    return `<section class="pattern-detail" aria-labelledby="pattern-detail-heading"><div class="section-heading"><div><h2 id="pattern-detail-heading">${factorName(state.factor)} &amp; time asleep</h2><p class="subtext">${state.factor==='restfulness'?'Rested ratings (4–5) compared with tired ratings (1–2).':'Nights with this factor recorded compared with nights marked absent after review.'}</p></div>${badge(c.enough?'Sufficient data':'Insufficient data',c.enough?'green':'amber')}</div>${c.enough?`${[c.a,c.b].map((v,i)=>`<div class="comparison-bars"><div class="bar-label">${labels[i]}<small>${[c.groupA,c.groupB][i].length} usable nights</small></div><div class="bar-track"><svg width="100%" height="30" viewBox="0 0 650 30" preserveAspectRatio="none" role="img" aria-label="${escape(labels[i])}: ${duration(v)} average"><rect width="${v/600*650}" height="30" rx="3" fill="${i===0?'#bedb98':'#425544'}"/></svg></div><strong class="bar-value">${duration(v)}</strong></div>`).join('')}<p class="comparison-explanation">${Math.abs(Math.round(c.difference))} min ${c.difference>=0?'more':'less'} average sleep in the first group. Descriptive association only; not causal.</p><details class="explainer"><summary>Usable nights</summary><p>${labels[0]}: ${c.groupA.map(n=>`<button class="text-button" data-open-night="${n.date}">${dateLabel(n.date)}</button>`).join(' · ')}</p><p>${labels[1]}: ${c.groupB.map(n=>`<button class="text-button" data-open-night="${n.date}">${dateLabel(n.date)}</button>`).join(' · ')}</p></details>`:`<div class="unavailable-box"><h3>Insufficient data</h3><p>${labels[0]}: <strong>${c.groupA.length} / 7 nights</strong>. ${labels[1]}: <strong>${c.groupB.length} / 7 nights</strong>. Both groups require seven usable nights.</p><svg width="100%" height="5" viewBox="0 0 360 5" preserveAspectRatio="none" aria-hidden="true"><rect width="360" height="5" fill="#28333e"/><rect width="${Math.min(1,Math.min(c.groupA.length,c.groupB.length)/7)*360}" height="5" fill="#bedb98"/></svg><p class="trend-note">Unanswered check-ins are unknown, not “factor absent.” ${state.factor==='restfulness'?'Neutral ratings stay outside these two groups.':'“Absent” means the sample explicitly reviewed the factors.'}</p><p class="demo-unavailable">Editing is not available in the public demo.</p></div>`}</section>`;
  }
  function patternsPage() {
    const featured=['caffeine','restfulness','stress'];
    return `<div class="page-heading"><div><h1>Patterns</h1></div>${periodButtons()}</div><div class="patterns-intro"><p>Comparisons use <strong>morning ratings and selected factors</strong>. Journal text is excluded.</p>${badge(`${periodNights().filter(n=>checkins.has(n.date)).length} check-ins · ${state.days} days`)}</div><div class="pattern-list">${featured.map(f=>{const c=factorComparison(f);return `<button class="pattern-card" data-factor="${f}" aria-pressed="${state.factor===f}"><span class="card-top"><h3>${factorName(f)}</h3><span aria-hidden="true">↗</span></span><span class="pattern-result ${c.enough?'':'unavailable'}">${factorResult(c)}</span><small>${c.enough?'Average time asleep · ':''}${c.groupA.length} vs. ${c.groupB.length} nights</small></button>`;}).join('')}</div><div class="factor-nav" role="group" aria-label="Choose comparison">${['restfulness',...factors].map(f=>button(factorName(f),`data-factor="${f}" aria-pressed="${state.factor===f}"`,state.factor===f?'small primary':'small')).join('')}</div>${factorDetail()}<section class="activity-proposal"><div class="activity-grid"><div>${badge('Proposed feature · illustrative example')}<h2>Activity and subsequent sleep</h2><p class="subtext">Pairs previous-day expenditure with the following main sleep.</p></div><div class="activity-pair"><div><small>Sep 14 · daytime expenditure</small><strong>${fixtures.get(shift(anchor,-2)).calories.toLocaleString('en-CA')} <small>kcal burned</small></strong></div><span class="pair-arrow" aria-hidden="true">→</span><div><small>Sleep ending Sep 15</small><strong>${duration(fixtures.get(shift(anchor,-1)).asleep)}</strong><small>${duration(fixtures.get(shift(anchor,-1)).deep)} deep sleep</small></div></div></div><p class="trend-note">Illustrative only. No quality score or causal claim.</p></section>`;
  }
  function render() {
    $$('.main-nav button').forEach(b=>{if(b.dataset.page===state.page)b.setAttribute('aria-current','page');else b.removeAttribute('aria-current');});
    const renders={night:nightPage,trends:trendsPage,patterns:patternsPage};
    $('#main').innerHTML=renders[state.page]();
    document.title=`Sleep Tracker · ${state.page[0].toUpperCase()+state.page.slice(1)} · Public demo`;
    updateUrl();updateCursor(state.cursor);
  }
  function rerenderWithFocus(button) {
    const attrs=['data-days','data-factor'];
    const key=attrs.find(k=>button.hasAttribute(k)),value=key?button.getAttribute(key):null;
    render();
    if(key)$$(`button[${key}]`).find(b=>b.getAttribute(key)===value)?.focus({preventScroll:true});
  }
  function navigate(page) {
    state.page=page;render();window.scrollTo({top:0,behavior:'instant'});$('#main').focus({preventScroll:true});
  }
  function selectDate(date) {
    if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(Date.parse(date)))return;
    state.date=date;state.session='main';render();
  }
  document.addEventListener('click',event=>{
    const b=event.target.closest('button');if(!b||b.disabled)return;
    if(b.dataset.page){navigate(b.dataset.page);return;}
    if(b.dataset.date){selectDate(b.dataset.date);return;}
    if(b.dataset.openNight){state.page='night';selectDate(b.dataset.openNight);window.scrollTo({top:0,behavior:'instant'});return;}
    if(b.dataset.days){state.days=Number(b.dataset.days);rerenderWithFocus(b);return;}
    if(b.dataset.factor){state.factor=b.dataset.factor;rerenderWithFocus(b);}
  });
  document.addEventListener('change',event=>{
    const input=event.target;
    if(input.id==='wake-date'){if(input.value&&input.checkValidity())selectDate(input.value);return;}
    if(input.id==='session-select'){state.session=input.value;render();}
  });
  document.addEventListener('input',event=>{if(event.target.id==='inspector')updateCursor(Number(event.target.value)/1000);});
  document.addEventListener('pointermove',event=>{const svg=event.target.closest('#timeline-svg');if(svg&&event.pointerType!=='touch'){const box=svg.getBoundingClientRect();updateCursor((event.clientX-box.left)/box.width);}});
  document.addEventListener('pointerdown',event=>{const svg=event.target.closest('#timeline-svg');if(svg){const box=svg.getBoundingClientRect();updateCursor((event.clientX-box.left)/box.width);}});
  render();
})();
