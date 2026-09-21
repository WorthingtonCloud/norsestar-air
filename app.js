// NorseStar Air — browser. Holds the session; the server is stateless.
import { priorSignals, scoreOffers, buildAgentContext, shortlist, whyText, SIGNALS, DEFAULT_WEIGHTS, ADDONS, FARES, BY_ID } from '/shared/engine.mjs';
import { itineraryFor } from '/shared/flight.mjs';
import { randomCustomer, defaultCustomer, AIRPORTS, TIERS, CABINS, SEATS, BAGS, STOPS } from '/shared/customers.mjs';

const WELCOME = 'Welcome to NorseStar Air. What can I help you with today?';
// An arc worth walking through in order, then a spread of one-liners.
const EXAMPLES = [
  "I don't care where I sit. Just get me there cheaply.",
  "Actually, if it's only another hundred bucks I'd rather be comfortable.",
  "I have an important meeting when I land, so I really don't want a risky connection.",
  'Can I use miles to upgrade?',
  "OK, let's book that.",
  "I'm traveling with my wife and want us sitting together.",
  'Does the flight have Wi-Fi? I need to work on the plane.',
  'Can I bring my dog in the cabin?',
  "I've had two terrible delays with you recently.",
  'I need to cancel my flight.',
  'What time does the flight leave?',
];
const FIELDS = [
  ['name', 'Name', 'text'], ['account', 'Account number', 'text'],
  ['tier', 'Loyalty tier', TIERS], ['miles', 'Miles balance', 'number'],
  ['flights12', 'Flights, last 12 mo', 'number'], ['avgSpend', 'Avg ticket spend $', 'number'],
  ['home', 'Home airport', AIRPORTS], ['destination', 'Flying to', AIRPORTS],
  ['stops', 'Current itinerary', STOPS], ['baseFare', 'Main Cabin fare $', 'number'],
  ['cabin', 'Typical cabin', CABINS], ['seat', 'Seat preference', SEATS],
  ['bags', 'Checks a bag', BAGS], ['upgrades', 'Upgrades bought, 12 mo', 'number'],
  ['disruptions', 'Recent delays / cancels', 'number'], ['party', 'Travel party size', 'number'],
];
const PRIORITY_LABELS = { customerValue: 'Customer value', conversion: 'Conversion', revenue: 'Revenue', loyalty: 'Loyalty' };

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const money = (x) => (x == null ? 'n/a' : x === 0 ? '$0' : x < 0.01 ? `$${x.toFixed(6)}` : `$${x.toFixed(4)}`);
const ms = (x) => (x == null ? '—' : x < 10 ? `${x.toFixed(2)} ms` : `${Math.round(x)} ms`);
const pretty = (k) => String(k ?? '—').replace(/_/g, ' ');
const post = async (path, body) => {
  const r = await fetch(path, { method: 'POST', body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok || j.error) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
};

// Two ways to run. Normally the server holds the keys and this page calls /api/*. In the public
// bring-your-own-key build there is no server: the same modules load into this tab, and the visitor's
// key lives in `config` (memory only) and goes to openrouter.ai straight from their browser.
const BYOK = document.documentElement.dataset.mode === 'byok';
let local = null;
const decideCall = (body) => (BYOK ? local.decide(body) : post('/api/decide', body));
const replyCall = (body, onDelta) => (BYOK ? local.respondStream(body.context, body.messages, onDelta) : stream('/api/respond-stream', body, onDelta));

// POST, then read server-sent events: {delta} pieces as they arrive, then one {done} record.
async function stream(path, body, onDelta) {
  const res = await fetch(path, { method: 'POST', body: JSON.stringify(body) });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  const reader = res.body.getReader(), dec = new TextDecoder();
  let buf = '', done = null;
  for (;;) {
    const { value, done: end } = await reader.read();
    if (end) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 2);
      if (!line.startsWith('data:')) continue;
      const o = JSON.parse(line.slice(5));
      if (o.error) throw new Error(o.error);
      if (o.delta) onDelta(o.delta);
      if (o.done) done = o.done;
    }
  }
  if (!done) throw new Error('The reply stream ended early.');
  return done;
}

let S;
function fresh(customer) {
  S = {
    customer, weights: { ...DEFAULT_WEIGHTS }, jevOn: $('jevToggle').checked,
    messages: [{ role: 'agent', text: WELCOME }],
    trace: [],            // cycles and policy-change notes, oldest first
    signals: null, prevSignals: null, ranking: null, prevRanks: null, context: null,
    busy: false, stage: '', openCycle: null, filter: new Set(), showAll: false, booking: null, offered: null,
    rankNote: 'Initial ranking from the customer record. No conversation yet.',
  };
  rescore({ silent: true });
  renderAll();
}

// ---------- decisioning in the browser: same engine module the server uses ----------
function currentSignals() { return S.signals || priorSignals(S.customer); }
function rescore({ silent = false, note } = {}) {
  const before = S.ranking;
  if (!silent && before) S.prevRanks = ranksOf(before);
  const out = scoreOffers(S.customer, currentSignals(), S.weights, { offered: S.offered });
  S.ranking = out.ranking; S.blocked = out.blocked; S.counts = out.counts;
  S.context = buildAgentContext({ cycle: cycles().length, customer: S.customer, signals: currentSignals(), ranking: S.ranking,
    blocked: S.blocked, previousTop: before?.[0]?.name ?? null, jevOn: S.jevOn && !!S.signals, flight: itineraryFor(S.customer) });
  if (note) S.rankNote = note;
  return { out, before };
}
const ranksOf = (ranking) => Object.fromEntries(ranking.map((r) => [r.id, r.rank]));
const cycles = () => S.trace.filter((t) => t.kind === 'cycle');
const topName = (ranking) => ranking?.[0]?.name ?? null;

// ---------- one decision cycle ----------
async function send(text) {
  text = text.trim();
  if (!text || S.busy) return;
  S.busy = true;
  S.messages.push({ role: 'customer', text });
  const n = cycles().length + 1;
  const cyc = { kind: 'cycle', n, utterance: text, jevOn: S.jevOn, prevSignals: S.signals || priorSignals(S.customer),
    prevTop: topName(S.ranking), prevRanks: ranksOf(S.ranking), started: performance.now() };
  S.trace.push(cyc); S.openCycle = n;
  S.stage = S.jevOn ? 'JEV is reading the message…' : 'Scoring from the customer record…';
  renderChat(); renderTrace();

  try {
    const d = await decideCall({ customer: S.customer, messages: S.messages, weights: S.weights, jevOn: S.jevOn, cycle: n, previousTop: cyc.prevTop });
    Object.assign(cyc, { jev: d.jev, signals: d.signals, engine: d.engine, context: d.context, decide_ms: d.decide_ms });
    S.prevSignals = cyc.prevSignals; S.signals = d.signals; S.prevRanks = cyc.prevRanks;
    if (d.party_update) { S.customer.party = d.party_update.to; cyc.party_update = d.party_update; renderCustomer(); flashField('party'); }
    // The server sends only the head of the ranking. The same engine module runs here, so the full
    // list is rebuilt from the signals it returned: identical inputs, identical order.
    S.offered = cyc.prevTop;
    const local = scoreOffers(S.customer, d.signals, S.weights, { offered: S.offered });
    S.ranking = local.ranking; S.blocked = local.blocked; S.counts = local.counts; S.context = d.context;
    if (local.ranking[0]?.id !== d.engine.ranking[0]?.id) console.warn('ranking mismatch: server', d.engine.ranking[0]?.id, 'browser', local.ranking[0]?.id);
    cyc.newTop = topName(S.ranking);
    cyc.story = storyOf(cyc);
    if (d.context.booking) S.booking = { ...d.context.booking, cycle: n };
    S.rankNote = `Decision cycle #${n}. ${cyc.newTop !== cyc.prevTop ? 'Top recommendation changed.' : 'Top recommendation held.'}`;
    S.stage = 'Agent is writing a reply…';
    renderDecision(true); renderTrace(); renderChat(); renderTotals();

    const live = { role: 'agent', text: '', cycle: n, streaming: true };
    const r = await replyCall({ context: d.context, messages: S.messages }, (delta) => {
      if (!live.text) { S.messages.push(live); S.stage = ''; }
      live.text = (live.text + delta).replace(/\*/g, ''); renderChat();
    });
    if (!live.text) S.messages.push(live);
    live.text = r.text; live.streaming = false;
    cyc.llm = r; cyc.total_ms = performance.now() - cyc.started;
  } catch (e) {
    cyc.error = String(e.message || e);
    S.messages = S.messages.filter((m) => !m.streaming);
    S.messages.push({ role: 'agent', text: `⚠ ${cyc.error}`, error: true });
  }
  S.busy = false; S.stage = '';
  renderChat(); renderTrace(); renderTotals();
  $('chatInput').focus();
}

// ---------- rendering ----------
function renderAll() { renderCustomer(); renderSliders(); renderChat(); renderCombo(); renderDecision(false); renderTrace(); renderTotals(); renderChips(); }

function renderWho() {
  const c = S.customer;
  $('whoHint').innerHTML = `<b>${esc(c.name)}</b> · ${esc(c.tier)} · ${esc(c.home)}→${esc(c.destination)} ${esc(c.stops).toLowerCase()} · ${Number(c.miles).toLocaleString()} mi${c.party > 1 ? ` · party of ${c.party}` : ''}`;
}

function renderCustomer() {
  const c = S.customer;
  renderWho();
  $('customerCard').innerHTML = `
    <div class="pass">
      <div class="pass-row"><span class="pass-name">${esc(c.name)}</span><span class="tier t-${esc(c.tier)}">${esc(c.tier)}</span></div>
      <div class="route"><b>${esc(c.home)}</b><span class="route-line"><i>${esc(c.stops)}</i></span><b>${esc(c.destination)}</b></div>
      <div class="pass-row small"><span>${esc(c.account)}</span><span>${Number(c.miles).toLocaleString()} mi</span><span>${esc(c.archetype || 'Manual')}</span></div>
    </div>`;
  $('customerForm').innerHTML = FIELDS.map(([k, label, type]) => `
    <label class="field"><span>${label}</span>${Array.isArray(type)
      ? `<select data-k="${k}">${type.map((o) => `<option ${o === c[k] ? 'selected' : ''}>${o}</option>`).join('')}</select>`
      : `<input data-k="${k}" type="${type}" value="${esc(c[k])}" ${type === 'number' ? 'min="0"' : ''}>`}</label>`).join('');
}

function flashField(k) {
  const el = document.querySelector(`[data-k="${k}"]`)?.closest('.field');
  if (el) { el.classList.remove('heard-field'); void el.offsetWidth; el.classList.add('heard-field'); }
}

function renderSliders() {
  $('sliders').innerHTML = Object.keys(PRIORITY_LABELS).map((k) => `
    <label class="slider"><span>${PRIORITY_LABELS[k]}</span>
      <input type="range" min="0" max="100" step="1" value="${S.weights[k]}" data-w="${k}">
      <b id="w-${k}">${Math.round(S.weights[k])}%</b></label>`).join('');
}

function renderChips() {
  $('chips').innerHTML = EXAMPLES.map((e, i) => `<button class="chip" data-i="${i}" title="${esc(e)}">${esc(e)}</button>`).join('');
}

function renderChat() {
  const el = $('chat');
  el.innerHTML = S.messages.map((m) => `
    <div class="msg ${m.role} ${m.error ? 'error' : ''}">
      <div class="who">${m.role === 'agent' ? 'NorseStar agent' : esc(S.customer.name)}${m.cycle ? `<button class="link" data-open="${m.cycle}">cycle #${m.cycle} ↗</button>` : ''}</div>
      <div class="bubble ${m.streaming ? 'typing' : ''}">${esc(m.text)}</div>
    </div>`).join('') + (S.busy && S.stage ? `<div class="msg agent"><div class="who">NorseStar agent</div><div class="bubble thinking"><span class="dots"><i></i><i></i><i></i></span>${esc(S.stage)}</div></div>` : '');
  el.scrollTop = el.scrollHeight;
  $('sendBtn').disabled = S.busy;
}

function moveBadge(r) {
  const prev = S.prevRanks?.[r.id];
  if (!S.prevRanks) return '<span class="move flat">initial</span>';
  if (!r.eligible) return '';
  if (prev == null) return '<span class="move up">▲ newly eligible</span>';
  if (prev === r.rank) return '<span class="move flat">— held</span>';
  return prev > r.rank ? `<span class="move up">▲ from #${prev}</span>` : `<span class="move down">▼ from #${prev}</span>`;
}

function compBars(r) {
  return `<div class="comps">${Object.entries(PRIORITY_LABELS).map(([k, label]) => `
    <div class="comp" title="${label}: ${r.components[k]} × weight ${Math.round(S.weights[k])}%">
      <span>${label}</span><div class="bar"><i style="width:${r.components[k] * 100}%"></i></div><b>${r.components[k].toFixed(2)}</b></div>`).join('')}</div>`;
}

function termsTable(r) {
  return `<table class="terms"><tr><th>customerValue term</th><th>signal</th><th>weight</th><th>adds</th></tr>${r.terms.map((t) => `
    <tr><td>${esc(t.label)}${t.part ? ` <i>${esc(t.part)}</i>` : ''}</td><td>${t.signal ?? ''}</td><td>${t.weight ?? ''}</td><td class="${t.value < 0 ? 'neg' : 'pos'}">${t.value > 0 ? '+' : ''}${t.value}</td></tr>`).join('')}
    <tr class="sum"><td colspan="3">match ${r.detail.match} ÷ best in set = customerValue</td><td>${r.components.customerValue}</td></tr>
    <tr><td colspan="3">affordability (feeds conversion)</td><td>${r.detail.affordability}</td></tr>
    <tr><td colspan="3">customer loyalty value (from the record)</td><td>${r.detail.loyaltyValue}</td></tr></table>`;
}

function renderCombo() {
  const blocked = new Set((S.blocked || []).map((b) => b.id));
  const cell = (c) => `<label class="combo ${S.filter.has(c.id) ? 'on' : ''} ${blocked.has(c.id) ? 'off' : ''}">
    <input type="checkbox" data-combo="${c.id}" ${S.filter.has(c.id) ? 'checked' : ''} ${blocked.has(c.id) ? 'disabled' : ''}>
    <span>${esc(c.short)}</span></label>`;
  $('comboFare').innerHTML = FARES.map(cell).join('');
  $('comboAddon').innerHTML = [...ADDONS, BY_ID.miles_cash].map(cell).join('');
  $('clearCombo').hidden = S.filter.size === 0;
}

function renderBlocked() {
  const b = S.blocked || [];
  $('blockedList').innerHTML = b.length
    ? `<h3 class="sub">Not available to this customer</h3>` + b.map((x) => `<div class="row inel"><span class="row-name">${esc(x.name)}<em>${esc(x.reason)}</em></span></div>`).join('')
    : '';
}

function renderBooking() {
  const b = S.booking;
  $('booking').innerHTML = b ? `<div class="booked"><span class="booked-tick">✓</span><div><b>Booked</b> · ${esc(b.package)}
    <div class="booked-meta">${esc(b.quote_this_price)} · confirmation <b>${esc(b.confirmation_code)}</b> · cycle #${b.cycle}</div></div></div>` : '';
}

function partChips(r) {
  if (r.fare === 'no_offer') return r.addons.length ? r.addons.map((id) => `<span class="part gift">${esc(BY_ID[id].name)}</span>`).join('') : '<span class="part none">nothing offered</span>';
  const added = r.addons;   // a miles payment is shown as a badge on the fare name, not as a part
  return added.length ? added.map((id) => `<span class="part ${BY_ID[id].gift ? 'gift' : ''}">${esc(BY_ID[id].short)}</span>`).join('') : '<span class="part none">fare only</span>';
}

function renderDecision(flash) {
  const list = S.ranking;
  const first = new Map([...document.querySelectorAll('[data-offer]')].map((n) => [n.dataset.offer, n.getBoundingClientRect()]));
  const top = shortlist(list);
  $('decisionHint').textContent = S.rankNote;
  renderBooking();
  $('top3').innerHTML = top.map((r, i) => {
    const prev = S.prevRanks?.[r.id];
    const moved = S.prevRanks && prev !== r.rank;
    const noSale = r.fare === 'no_offer';
    return `<details class="rec ${i === 0 ? 'rank1' : ''} ${noSale ? 'nosale' : ''} ${moved && flash ? 'flash' : ''}" data-offer="top-${r.id}">
      <summary>
        <div class="rec-rank">${i === 0 ? '1' : `<small>#</small>${r.rank}`}</div>
        <div class="rec-main">
          <div class="rec-kicker">${i === 0 ? (noSale ? 'Recommended action' : 'Recommended') : 'Best alternative on a different fare'}</div>
          <div class="rec-name">${esc(BY_ID[r.fare].name)}${r.payment ? ' <span class="onmiles">on miles</span>' : ''}</div>
          <div class="parts">${partChips(r)}</div>
          <div class="rec-meta"><span>${esc(r.price)}</span>${moveBadge(r)}</div>
        </div>
        <div class="rec-score"><b>${Math.round(r.score)}</b><span>score</span></div>
      </summary>
      <p class="why"><span>Why</span> ${esc(whyText(r))}</p>
      ${compBars(r)}
      ${termsTable(r)}
    </details>`;
  }).join('');

  const matches = list.filter((r) => [...S.filter].every((id) => r.fare === id || r.payment === id || r.addons.includes(id)));
  const shown = S.showAll ? matches : matches.slice(0, 12);
  $('rankCount').innerHTML = S.filter.size
    ? `<b>${matches.length}</b> of ${list.length} combinations include everything ticked${matches[0] ? ` · best is <b>#${matches[0].rank}</b>` : ''}`
    : `<b>${list.length}</b> scored for this customer, of ${S.counts.catalog} in the catalog`;
  $('fullRanking').innerHTML = shown.map((r) => `
    <div class="row" data-offer="row-${r.id}" title="${esc(whyText(r))}">
      <span class="row-rank">${r.rank}</span>
      <span class="row-name">${esc(r.name)}</span>
      <span class="row-bar"><i style="width:${Math.max(0, Math.min(100, r.score))}%"></i></span>
      <span class="row-score">${r.score.toFixed(1)}</span>
      ${moveBadge(r)}
    </div>`).join('') || '<div class="row none">No combination available to this customer includes all of those.</div>';
  $('showAllBtn').textContent = S.showAll ? `Show top 12` : `Show all ${matches.length}`;
  $('showAllBtn').hidden = matches.length <= 12;
  renderBlocked();

  // FLIP: slide each offer from where it was to where it is now
  document.querySelectorAll('[data-offer]').forEach((n) => {
    const a = first.get(n.dataset.offer); if (!a) return;
    const dy = a.top - n.getBoundingClientRect().top;
    if (Math.abs(dy) < 2) return;
    n.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: 520, easing: 'cubic-bezier(.2,.8,.2,1)' });
  });
}

// ----- trace -----
// The two-second version of a cycle: what Jev heard, what the code did, what the agent was told.
function storyOf(c) {
  const now = c.signals, was = c.prevSignals;
  const heard = [];
  if (!c.jevOn) heard.push({ text: 'JEV is off. Nothing was read; the record alone set the signals.', off: true });
  else {
    const pick = (key, label) => { const p = now[key]; if (p?.pick && (p.pick !== was[key]?.pick)) heard.push({ text: `${label}: <b>${pretty(p.pick)}</b>`, p: p.probabilities?.[p.pick] ?? p.confidence }); };
    if (c.party_update) heard.push({ text: `travelers: <b>${c.party_update.to}</b> <span class="dim">(record said ${c.party_update.from}; updated)</span>` });
    pick('primary_intent', 'intent');
    if (now.requested_cabin?.pick && now.requested_cabin.pick !== 'none') pick('requested_cabin', 'asked for');
    pick('trip_priority', 'priority');
    const moved = Object.keys(SIGNALS).map((k) => ({ k, a: was.values[k] ?? 0, b: now.values[k] ?? 0 }))
      .map((x) => ({ ...x, d: x.b - x.a })).filter((x) => Math.abs(x.d) >= 0.2)
      .sort((x, y) => (y.d > 0) - (x.d > 0) || Math.abs(y.d) - Math.abs(x.d)).slice(0, 5);   // what rose first: that is what was heard
    for (const m of moved) heard.push({ text: `${SIGNALS[m.k].label.toLowerCase()} <i class="${m.d > 0 ? 'up' : 'down'}">${m.d > 0 ? '▲' : '▼'}</i> <b>${m.b.toFixed(2)}</b>`, was: m.a });
    if (!heard.length) heard.push({ text: 'nothing new; every signal held within 0.20', off: true });
  }
  const top = S.ranking?.[0];
  const from = top ? c.prevRanks?.[top.id] : null;
  const told = (c.context?.guardrails || []).slice(0, -1);
  return { heard, top: top?.name, from, changed: c.newTop !== c.prevTop, scored: S.ranking?.length, told };
}

function storyView(c) {
  const st = c.story; if (!st) return '';
  return `<div class="story">
    <div class="story-row jev"><span class="story-k">Jev heard</span><div class="story-v">${st.heard.map((h) => `<span class="heard ${h.off ? 'off' : ''}">${h.text}</span>`).join('')}</div></div>
    <div class="story-row eng"><span class="story-k">Code decided</span><div class="story-v">${st.changed
      ? `<b>${esc(st.top)}</b> ${st.from && st.from > 1 ? `climbed from <b>#${st.from}</b> to <b>#1</b>` : 'is now #1'}`
      : `<b>${esc(st.top)}</b> held at #1`} <span class="dim">· ${st.scored} packages re-scored in ${ms(c.engine.latency_ms)}</span></div></div>
    <div class="story-row llm"><span class="story-k">Agent was told</span><div class="story-v">${st.told.length ? `<ul>${st.told.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>` : '<span class="dim">no special handling</span>'}</div></div>
  </div>`;
}

function answerDetail(q) {
  const a = q.answer;
  if (!a) return '';
  if (a.type === 'noul') return '';
  if (a.type === 'choice') {
    const opts = Object.entries(a.probabilities).sort((x, y) => y[1] - x[1]);
    return `<div class="dist">${opts.map(([k, p]) => `
      <div class="dist-row ${k === a.choice ? 'pick' : ''}"><span>${pretty(k)}</span><div class="pbar"><i style="width:${p * 100}%"></i></div><b>${p.toFixed(2)}</b></div>`).join('')}
      <div class="conf">pick: <b>${pretty(a.choice)}</b> · confidence ${a.confidence?.toFixed(2)}</div></div>`;
  }
  const topLevel = Object.keys(a.probabilities).length - 1;
  const best = Math.max(...Object.values(a.probabilities));
  return `<div class="dist">
    ${Object.entries(a.probabilities).map(([lv, p]) => `
      <div class="dist-row ladder ${p === best ? 'pick' : ''}"><span title="${esc(a.legend?.[lv])}">${lv} · ${esc(a.legend?.[lv])}</span><div class="pbar"><i style="width:${p * 100}%"></i></div><b>${p.toFixed(2)}</b></div>`).join('')}
    <div class="conf">expected level ${a.score} on a 0–${topLevel} ladder · confidence ${a.confidence?.toFixed(2)} · shown as ${a.score} ÷ ${topLevel}</div>
  </div>`;
}

// One line per question: what was asked, in short, and what came back. Click for the wording.
function questionRow(q) {
  const a = q.answer;
  let value = 0, text = '—', hot = false;
  if (a?.type === 'noul') { value = a.noul; text = a.noul.toFixed(2); hot = a.noul >= 0.6; }
  else if (a?.type === 'choice') { value = a.probabilities[a.choice] ?? 0; text = pretty(a.choice); hot = a.choice !== 'none' && a.choice !== 'unclear' && a.choice !== 'other'; }
  else if (a?.type === 'score') { const t = Object.keys(a.probabilities).length - 1; value = a.score / t; text = value.toFixed(2); hot = value >= 0.6; }
  return `<details class="qrow ${hot ? 'hot' : ''}">
    <summary><span class="q-label">${esc(q.label)}</span><span class="pbar"><i style="width:${value * 100}%"></i></span><b class="${a?.type === 'choice' ? 'word' : ''}">${esc(text)}</b></summary>
    <div class="q-body">
      <div class="q-text">“${esc(q.instructions)}”</div>
      ${answerDetail(q)}
      <div class="q-crit">${criteriaView(q)}</div>
    </div>
  </details>`;
}

function criteriaView(q) {
  if (Array.isArray(q.criteria)) return '';                  // a ladder's levels are already shown with their odds
  if (q.type === 'choice') return '';                         // so are a choice's options
  return `<ul>${Object.entries(q.criteria).map(([k, v]) => `<li><b>${k === 'true' ? 'yes if' : 'no if'}</b> ${esc(v)}</li>`).join('')}</ul>`;
}

function jevView(c) {
  if (!c.jevOn) return '<div class="skip">JEV Decisioning is OFF. No call was made. Signals below come from the static customer record only.</div>';
  if (!c.jev) return '<div class="pending"><span class="dots"><i></i><i></i><i></i></span> calling Jev…</div>';
  return `<p class="lede">${c.jev.calls.reduce((a, x) => a + x.questions.length, 0)} typed questions, sent as ${c.jev.calls.length} calls at the same moment. Each answer is a probability, not a sentence. Lit rows came back 0.60 or higher. Click any row for the exact wording.</p>`
    + c.jev.calls.map((call) => `
    <div class="call">
      <div class="call-head"><span class="prim p-${call.primitive}">${call.primitive.toUpperCase()}</span>
        <span class="call-title">${esc(call.title || call.primitive)}</span>
        <span class="mono jev-c">${ms(call.latency_ms)}</span><span class="mono dim">${money(call.cost)}<sup>est</sup></span></div>
      ${call.questions.map(questionRow).join('')}
      <details class="mini raw"><summary>raw Jev response · ${esc(call.model)} · ${call.usage.input_tokens} tokens in</summary><pre>${esc(JSON.stringify(call.raw, null, 2))}</pre></details>
    </div>`).join('') + `<details class="mini raw"><summary>the state Jev was shown</summary><pre>${esc(JSON.stringify(c.jev.state, null, 2))}</pre></details>`;
}

function signalsView(c) {
  const now = c.signals, was = c.prevSignals;
  const row = (k) => {
    const a = was.values[k] ?? 0, b = now.values[k] ?? 0, d = b - a, big = Math.abs(d) >= 0.2;
    return { big, mag: Math.abs(d), html: `<div class="sig ${big ? 'big' : ''}"><span>${SIGNALS[k].label}<em>${SIGNALS[k].kind}</em></span>
      <div class="pbar two"><u style="left:${a * 100}%"></u><i style="width:${b * 100}%"></i></div>
      <span class="mono was">${a.toFixed(2)}</span><span class="arrow">→</span><b class="mono">${b.toFixed(2)}</b>
      <span class="delta mono ${d > 0.005 ? 'up' : d < -0.005 ? 'down' : ''}">${Math.abs(d) < 0.005 ? '·' : (d > 0 ? '+' : '') + d.toFixed(2)}</span></div>` };
  };
  const rows = Object.keys(SIGNALS).map(row).sort((x, y) => y.mag - x.mag);
  const loud = rows.filter((r) => r.big), quiet = rows.filter((r) => !r.big);
  const pickRow = (label, key) => {
    const a = was[key]?.pick, b = now[key]?.pick;
    return `<div class="sig pickrow ${a !== b && b ? 'big' : ''}"><span>${label}<em>choice</em></span>
      <span class="mono was">${pretty(a)}</span><span class="arrow">→</span><b class="mono">${pretty(b)}</b>
      <span class="mono dim">${now[key]?.confidence != null ? `conf ${now[key].confidence.toFixed(2)}` : ''}</span></div>`;
  };
  return `<div class="sig-src">Previous value → this cycle. Before: <b>${was.source === 'jev' ? 'Jev' : 'the record'}</b>. Now: <b>${now.source === 'jev' ? 'Jev' : 'the record'}</b>. The tick on each bar is where it was.</div>
    ${pickRow('Primary intent', 'primary_intent')}${pickRow('Trip priority', 'trip_priority')}${pickRow('Cabin asked for', 'requested_cabin')}
    ${loud.map((r) => r.html).join('') || '<div class="sig-none">No signal moved by 0.20 or more.</div>'}
    <details class="mini"><summary>${quiet.length} signals that held steady</summary>${quiet.map((r) => r.html).join('')}</details>`;
}

function engineView(c) {
  const el = c.engine.ranking;
  return `<div class="eng-list">${el.slice(0, 6).map((r) => {
    const p = c.prevRanks?.[r.id];
    const mv = p == null ? '' : p === r.rank ? '<span class="move flat">—</span>' : p > r.rank ? `<span class="move up">▲${p - r.rank}</span>` : `<span class="move down">▼${r.rank - p}</span>`;
    return `<div class="eng-row ${r.rank <= 3 ? 'top' : ''}"><span class="row-rank">${r.rank}</span><span>${esc(r.name)}</span>
      <span class="row-bar"><i style="width:${r.score}%"></i></span><b class="mono">${r.score.toFixed(1)}</b>${mv}</div>`;
  }).join('')}</div>
  <div class="conf">weights — ${Object.entries(c.engine.weights).map(([k, w]) => `${PRIORITY_LABELS[k]} ${Math.round(w * 100)}%`).join(' · ')} · scored ${c.engine.counts?.scored ?? c.engine.ranking.length} combinations in <b class="eng-c">${ms(c.engine.latency_ms)}</b>${(c.engine.blocked || []).length ? ` · unavailable: ${c.engine.blocked.map((b) => esc(b.name)).join(', ')}` : ''}</div>`;
}

function perfView(c) {
  const j = c.jev?.wall_ms ?? 0, e = c.engine?.latency_ms ?? 0, l = c.llm?.latency_ms ?? 0;
  const tot = j + e + l || 1;
  const jc = c.jev?.cost ?? 0, lc = c.llm?.cost;
  return `<div class="perf">
    <div class="lat"><i class="jev" style="flex:${j / tot}"></i><i class="eng" style="flex:${Math.max(e / tot, 0.004)}"></i><i class="llm" style="flex:${l / tot}"></i></div>
    <div class="perf-grid">
      <div class="jev-c"><h5>JEV</h5><b>${c.jevOn ? ms(j) : 'off'}</b>
        <span>${c.jev ? `${c.jev.calls.reduce((a, x) => a + x.questions.length, 0)} questions, ${c.jev.calls.length} calls in parallel` : 'no calls'}</span>
        <span>${c.jev ? c.jev.calls.map((x) => `${x.name || x.primitive} ${Math.round(x.latency_ms)}`).join(' · ') + ' ms' : ''}</span>
        <span>cost ${c.jev ? money(jc) : '$0'} ${c.jev ? '<sup>est</sup>' : ''}</span></div>
      <div class="eng-c"><h5>Decision engine</h5><b>${ms(e)}</b><span>10 offers scored, local code</span><span>cost $0</span></div>
      <div class="llm-c"><h5>Conversational LLM</h5><b>${c.llm ? ms(l) : '…'}</b>
        <span>${c.llm?.first_token_ms ? `first words at ${ms(c.llm.first_token_ms)}` : ''}</span>
        <span>${c.llm ? `${c.llm.usage.prompt_tokens ?? '?'} in + ${c.llm.usage.completion_tokens ?? '?'} out tokens` : ''}</span>
        <span>${c.llm ? esc(c.llm.model) : ''}</span>
        <span>cost ${c.llm ? money(lc) : '…'} ${c.llm && lc != null ? '<sup>actual</sup>' : ''}</span></div>
      <div><h5>Entire turn</h5><b>${c.total_ms ? ms(c.total_ms) : '…'}</b><span>browser round trip, all stages</span>
        <span>cost ${c.llm ? money(jc + (lc ?? 0)) : '…'}</span></div>
    </div>
    ${c.jev ? `<div class="conf"><sup>est</sup> ${esc(c.jev.cost_basis)}</div>` : ''}
  </div>`;
}

function cycleView(c) {
  const changed = c.newTop && c.newTop !== c.prevTop;
  const open = S.openCycle === c.n;
  const step = (n, cls, title, body, extra = '') => `<div class="step ${cls}"><div class="step-n">${n}</div><div class="step-b"><h4>${title}${extra}</h4>${body}</div></div>`;
  return `<article class="cycle ${open ? 'open' : ''} ${changed ? 'changed' : ''}" id="cycle-${c.n}">
    <button class="cycle-head" data-toggle="${c.n}">
      <span class="cycle-n">Decision Cycle #${c.n}</span>
      <span class="cycle-utt">“${esc(c.utterance)}”</span>
      <span class="cycle-sum">${c.newTop ? (changed ? `<em class="chg">${esc(c.prevTop)} → ${esc(c.newTop)}</em>` : `<em>held: ${esc(c.newTop)}</em>`) : ''}
        <span class="mono jev-c">${c.jev ? ms(c.jev.wall_ms) : c.jevOn ? '…' : 'JEV off'}</span><span class="mono llm-c">${c.llm ? ms(c.llm.latency_ms) : ''}</span></span>
    </button>
    ${open ? `<div class="cycle-body">
      ${storyView(c)}
      <div class="evidence-label">The evidence, step by step</div>
      ${step(1, '', 'Customer said', `<blockquote>${esc(c.utterance)}</blockquote>`)}
      ${step(2, 'jev', 'Jev read it', jevView(c), c.jev ? `<span class="tag">${ms(c.jev.wall_ms)} · ${money(c.jev.cost)} est</span>` : '')}
      ${c.signals ? step(3, 'jev', 'Customer state updated', signalsView(c)) : ''}
      ${c.engine ? step(4, 'eng', 'Every package re-scored', engineView(c)) : ''}
      ${c.engine ? step(5, 'eng', changed ? 'Recommendation changed' : 'Recommendation held', `<div class="change ${changed ? 'yes' : ''}"><span>${esc(c.prevTop)}</span><span class="arrow">→</span><b>${esc(c.newTop)}</b></div>`) : ''}
      ${c.context ? step(6, 'llm', 'Agent briefed', `<ul class="rails">${c.context.guardrails.map((g) => `<li>${esc(g)}</li>`).join('')}</ul>
          <details class="mini raw"><summary>the full decision context handed to the agent (JSON)</summary><pre class="ctx">${esc(JSON.stringify(c.context, null, 2))}</pre></details>
          ${c.llm ? `<details class="mini raw"><summary>the full system prompt, airline facts included</summary><pre>${esc(c.llm.system_prompt)}</pre></details>` : ''}`) : ''}
      ${c.context ? step(7, 'llm', 'Agent replied', c.llm ? `<blockquote class="reply">${esc(c.llm.text)}</blockquote>` : c.error ? `<div class="skip">${esc(c.error)}</div>` : '<div class="pending"><span class="dots"><i></i><i></i><i></i></span> the agent is writing…</div>', c.llm ? `<span class="tag">${esc(c.llm.model)}</span>` : '') : ''}
      ${c.engine ? perfView(c) : ''}
    </div>` : ''}
  </article>`;
}

function renderTrace() {
  const el = $('trace');
  if (!S.trace.length) {
    el.innerHTML = `<div class="empty"><b>Nothing decided yet.</b><p>Send a message as the customer. Each message opens a decision cycle here:</p>
      <ol><li>Customer said</li><li class="jev-c">Jev read it</li><li class="jev-c">Customer state updated</li><li class="eng-c">Every package re-scored</li><li class="eng-c">Recommendation changed or held</li><li class="llm-c">Agent briefed</li><li class="llm-c">Agent replied</li></ol></div>`;
    return;
  }
  el.innerHTML = [...S.trace].reverse().map((t) => (t.kind === 'cycle' ? cycleView(t)
    : `<div class="policy"><span class="prim sm p-eng">POLICY</span> Priorities re-weighted (${Object.entries(t.weights).map(([k, w]) => `${PRIORITY_LABELS[k]} ${Math.round(w)}%`).join(' · ')}).
        Top: ${t.from === t.to ? `held, <b>${esc(t.to)}</b>` : `<b>${esc(t.from)} → ${esc(t.to)}</b>`}. <span class="mono">0 Jev calls · ${ms(t.ms)}</span></div>`)).join('');
}

// Like-for-like only: turns where BOTH Jev and the LLM ran.
function ratio(both) {
  if (!both.length) return '—';
  const j = both.reduce((a, c) => a + c.jev.cost, 0), l = both.reduce((a, c) => a + (c.llm.cost || 0), 0);
  const jt = both.reduce((a, c) => a + c.jev.wall_ms, 0), lt = both.reduce((a, c) => a + c.llm.latency_ms, 0);
  return `${j && l ? (l / j).toFixed(1) : '?'}× cost · ${(lt / jt).toFixed(1)}× time`;
}

function renderTotals() {
  const cs = cycles().filter((c) => c.engine);
  const sum = (f) => cs.reduce((a, c) => a + (f(c) || 0), 0);
  const jevCalls = sum((c) => c.jev?.calls.length), jevCost = sum((c) => c.jev?.cost), llmCost = sum((c) => c.llm?.cost);
  const done = cs.filter((c) => c.llm);
  const avgDec = cs.length ? sum((c) => (c.jev?.wall_ms || 0) + c.engine.latency_ms) / cs.length : null;
  const avgLlm = done.length ? done.reduce((a, c) => a + c.llm.latency_ms, 0) / done.length : null;
  const cell = (label, val, cls = '') => `<div class="tot ${cls}"><span>${label}</span><b>${val}</b></div>`;
  $('totals').innerHTML = [
    cell('Turns', cs.length), cell('JEV calls', jevCalls, 'jev-c'),
    cell('JEV spend <sup>est</sup>', money(jevCost), 'jev-c'), cell('LLM spend', money(llmCost), 'llm-c'),
    cell('Total system cost', money(jevCost + llmCost)),
    cell('Avg decision latency', avgDec == null ? '—' : ms(avgDec), 'jev-c'),
    cell('Avg LLM latency', avgLlm == null ? '—' : ms(avgLlm), 'llm-c'),
    cell('LLM ÷ JEV, measured', ratio(done.filter((c) => c.jev)), ''),
  ].join('');
}

// ---------- events ----------
$('chatForm').addEventListener('submit', (e) => { e.preventDefault(); const v = $('chatInput').value; $('chatInput').value = ''; send(v); });
$('chatInput').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); $('chatForm').requestSubmit(); } });
$('chips').addEventListener('click', (e) => { const b = e.target.closest('.chip'); if (b) send(EXAMPLES[+b.dataset.i]); });
document.querySelector('.grid').addEventListener('change', (e) => {
  const id = e.target.dataset?.combo; if (!id) return;
  if (e.target.checked) S.filter.add(id); else S.filter.delete(id);
  // Only one fare can be in a package, so ticking a fare unticks the others.
  if (FARES.some((f) => f.id === id) && e.target.checked) for (const f of FARES) if (f.id !== id) S.filter.delete(f.id);
  S.showAll = false;
  renderCombo(); renderDecision(false);
});
$('clearCombo').addEventListener('click', () => { S.filter.clear(); S.showAll = false; renderCombo(); renderDecision(false); });
$('showAllBtn').addEventListener('click', () => { S.showAll = !S.showAll; renderDecision(false); });
$('randomBtn').addEventListener('click', () => { if (!S.busy) fresh(randomCustomer()); $('chatInput').focus(); });
$('resetBtn').addEventListener('click', () => { if (!S.busy) fresh(defaultCustomer()); });
$('chat').addEventListener('click', (e) => { const b = e.target.closest('[data-open]'); if (!b) return; S.openCycle = +b.dataset.open; renderTrace(); document.getElementById(`cycle-${S.openCycle}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); });
$('trace').addEventListener('click', (e) => { const b = e.target.closest('[data-toggle]'); if (!b) return; const n = +b.dataset.toggle; S.openCycle = S.openCycle === n ? null : n; renderTrace(); });

$('customerForm').addEventListener('change', (e) => {
  const k = e.target.dataset.k; if (!k) return;
  S.customer[k] = e.target.type === 'number' ? Math.max(0, Number(e.target.value) || 0) : e.target.value;
  if (k === 'party') S.customer.party = Math.max(1, S.customer.party);
  S.customer.archetype = 'Manual';
  rescore({ note: 'Customer record edited. Re-scored with the same Jev reading.' });
  renderCustomer(); renderDecision(true);
});

$('sliders').addEventListener('input', (e) => {
  const k = e.target.dataset.w; if (!k) return;
  const v = Number(e.target.value), others = Object.keys(S.weights).filter((x) => x !== k);
  const rest = others.reduce((a, x) => a + S.weights[x], 0);
  others.forEach((x) => { S.weights[x] = rest > 0 ? (S.weights[x] / rest) * (100 - v) : (100 - v) / others.length; });
  S.weights[k] = v;
  // keep whole-number weights that really total 100: round the others, give the remainder to the largest of them
  others.forEach((x) => { S.weights[x] = Math.round(S.weights[x]); });
  const big = others.reduce((a, x) => (S.weights[x] > S.weights[a] ? x : a), others[0]);
  S.weights[big] += 100 - Object.values(S.weights).reduce((a, b) => a + b, 0);
  Object.keys(S.weights).forEach((x) => { document.querySelector(`[data-w="${x}"]`).value = S.weights[x]; $(`w-${x}`).textContent = `${S.weights[x]}%`; });
  const from = topName(S.ranking);
  const { out } = rescore({ note: 'Business priorities changed. Re-scored with the same Jev reading; no model call.' });
  const last = S.trace[S.trace.length - 1];
  const entry = { kind: 'policy', weights: { ...S.weights }, from: last?.kind === 'policy' ? last.from : from, to: topName(S.ranking), ms: out.latency_ms };
  if (last?.kind === 'policy') S.trace[S.trace.length - 1] = entry; else S.trace.push(entry);
  renderDecision(true); renderTrace();
});

$('jevToggle').addEventListener('change', (e) => {
  S.jevOn = e.target.checked; $('jevState').textContent = S.jevOn ? 'ON' : 'OFF';
  document.body.classList.toggle('jev-off', !S.jevOn);
  if (!S.jevOn) { S.prevSignals = S.signals; S.signals = null; rescore({ note: 'JEV OFF. Ranking now uses the static customer record and rules only.' }); }
  else rescore({ note: 'JEV ON. The next message will be read by Jev.' });
  renderDecision(true);
});

if (BYOK) startKeyGate();
else fetch('/api/config').then((r) => r.json()).then((c) => {
  if (!c.keys.jev || !c.keys.llm) S.messages.push({ role: 'agent', error: true, text: `⚠ Missing API key: ${!c.keys.jev ? 'JEV_API_KEY ' : ''}${!c.keys.llm ? 'LLM_API_KEY' : ''}. See README.` }), renderChat();
});

// The key is checked against OpenRouter, then kept in one place: the `config` object in this tab's
// memory. It is never written to storage, and nothing on this page talks to any other host.
async function startKeyGate() {
  const [{ config, configure }, { decide }, { respondStream }] = await Promise.all([import('/lib/config.mjs'), import('/lib/decide.mjs'), import('/lib/agent.mjs')]);
  local = { decide, respondStream };
  const gate = $('keyGate'), input = $('keyInput'), err = $('keyError'), go = $('keyStart');
  gate.addEventListener('cancel', (e) => e.preventDefault());            // Escape must not skip the gate
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('keyForm').requestSubmit(); } });
  $('keyForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const key = input.value.trim();
    err.textContent = ''; go.disabled = true; go.textContent = 'Checking the key with OpenRouter…';
    try {
      const res = await fetch('https://openrouter.ai/api/v1/key', { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15000) });
      if (res.status === 401) throw new Error('OpenRouter did not recognize that key.');
      if (!res.ok) throw new Error(`OpenRouter answered HTTP ${res.status}. Try again in a moment.`);
      configure({ JEV_API_KEY: key, LLM_API_KEY: key, JEV_PROVIDER: 'openrouter', JEV_CALL_MODE: 'per_primitive',
        LLM_MODEL: 'anthropic/claude-haiku-4.5', LLM_BASE_URL: 'https://openrouter.ai/api/v1' });
      input.value = ''; gate.close(); $('chatInput').focus();
    } catch (e2) {
      err.textContent = e2.name === 'TimeoutError' || e2 instanceof TypeError ? 'Could not reach openrouter.ai. Check your connection and try again.' : e2.message;
    }
    go.disabled = false; go.textContent = 'Start the demo';
  });
  $('forgetKeyBtn').addEventListener('click', () => {
    for (const k of Object.keys(config)) delete config[k];
    fresh(defaultCustomer()); gate.showModal(); input.focus();
  });
  gate.showModal();
}

fresh(defaultCustomer());
