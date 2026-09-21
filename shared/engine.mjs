// Deterministic decision engine. No model calls, no randomness.
// Shared by the server (each decision cycle) and the browser (instant re-score on slider moves).
//
// The unit of decision is a BUNDLE: one fare (or no offer at all), an optional way to pay for an
// upgrade, and any combination of add-ons. Every valid combination is generated and scored, so "a nonstop with
// extra legroom and no bag fee" is a real, ranked, bookable row rather than three separate offers
// the agent has to staple together in prose.
//
//   final = 100 x ( wCV x customerValue + wConv x conversion + wRev x revenue + wLoy x loyalty )
//
// Every component is 0..1. Every term that feeds a component is returned so the UI can show it.

export const SIGNALS = {
  // scores: Jev expectation / top level -> 0..1
  price_sensitivity: { label: 'Price sensitivity', kind: 'score' },
  comfort_preference: { label: 'Comfort preference', kind: 'score' },
  disruption_concern: { label: 'Disruption concern', kind: 'score' },
  purchase_readiness: { label: 'Purchase readiness', kind: 'score' },
  upgrade_propensity: { label: 'Upgrade propensity', kind: 'score' },
  // nouls: P(yes) — the situation
  business_travel: { label: 'Business travel', kind: 'noul' },
  needs_bags: { label: 'Baggage sensitive', kind: 'noul' },
  together_seating: { label: 'Needs seats together', kind: 'noul' },
  flexibility_need: { label: 'Values flexibility', kind: 'noul' },
  delay_complaint: { label: 'Complaint about disruptions', kind: 'noul' },
  special_assistance: { label: 'Needs special assistance', kind: 'noul' },
  traveling_with_pet: { label: 'Bringing a pet', kind: 'noul' },
  confirms_purchase: { label: 'Just said yes', kind: 'noul' },
  // nouls: P(yes) — asked for by name
  wants_miles: { label: 'Wants to use miles', kind: 'noul' },
  wants_nonstop: { label: 'Asked for a nonstop', kind: 'noul' },
  asked_legroom: { label: 'Asked for legroom', kind: 'noul' },
  wants_seat_choice: { label: 'Asked for a specific seat', kind: 'noul' },
  wants_lounge: { label: 'Asked for lounge access', kind: 'noul' },
  wants_wifi: { label: 'Asked for Wi-Fi', kind: 'noul' },
  declines_extras: { label: 'Refusing extras', kind: 'noul' },
};

export const PRIORITY_OPTIONS = ['lowest_cost', 'comfort', 'reliability', 'flexibility', 'loyalty_optimization', 'unclear'];
export const INTENT_OPTIONS = ['book_flight', 'upgrade', 'reduce_cost', 'use_loyalty_benefits', 'change_itinerary', 'service_complaint', 'cancel_or_refund', 'ask_information', 'other'];
export const CABIN_OPTIONS = ['basic_economy', 'main_cabin', 'premium_economy', 'first_class', 'none'];

export const DEFAULT_WEIGHTS = { customerValue: 40, conversion: 25, revenue: 20, loyalty: 15 };

// What an upgrade costs when paid with miles: a block of miles plus a cash co-pay, per traveler.
export const MILES_PRICE = {
  premium_economy: { miles: 15000, cash: 75, margin: 60 },
  first_class: { miles: 40000, cash: 150, margin: 140 },
};
const MILES_PER_UPGRADE = MILES_PRICE.premium_economy.miles; // the cheapest way in; used for the eligibility floor
const GOODWILL_MILES = 5000;
const TIER_RANK = { Member: 0, Silver: 1, Gold: 2, Platinum: 3 };

// ---- Business assumptions, set in code. Each is a dial a person could turn. ----
// Each UNWANTED thing put in front of a customer costs some of the close rate. Something they
// asked for is not an extra ask, it is the answer, so friction is charged in proportion to how
// little the customer wanted it.
const ASK_FRICTION = 0.85;
// How hard price pulls a package down: PRICE_BITE x (share of the ask the customer cannot absorb)
// x (size of the ask, maxing out at PRICE_FULL_BITE_AT dollars).
const PRICE_BITE = 1.2;
const PRICE_FULL_BITE_AT = 250;
// The price of something you asked for by name is not a surprise. This share of a requested
// part's price is left out of the affordability test.
const ASKED_PRICE_RELIEF = 0.75;
// Naming a cabin outright is the strongest signal there is about which fare to lead with.
const CABIN_ASK = 0.8;
// "No extras" is charged against every paid add-on and every upgrade.
const DECLINE_BITE = 0.6;
// A fare that already INCLUDES something the customer asked for gets this share of the credit.
const COVERED_CREDIT = 0.45;
// When the customer is complaining or canceling, selling converts badly. Share of the close rate lost.
const SERVICE_DAMPER = 0.8;
// A redemption that empties the account is a bad recommendation even when it is allowed.
// Charged as MILES_DRAIN x (share of the balance used) squared, so small redemptions are nearly free.
const MILES_DRAIN = 0.3;
// Once the customer says yes to a package, that package is the answer.
const ACCEPTED_BONUS = 1.5;
// Putting something in front of a customer who showed no interest in it is noise, and noise costs
// the customer attention. Charged per add-on, in proportion to how little they wanted it.
const NOISE_COST = 0.2;

// ---------------------------------------------------------------------------
// Components. A bundle is built from exactly one `fare`, an optional `payment`
// method for an upgrade, and any subset of `addon`s.
//
//   cash    = extra dollars per traveler vs the customer's Main Cabin fare
//   margin  = airline contribution, dollars (negative = a giveaway that costs money)
//   base    = standing utility of the fare itself (add-ons carry none; they earn
//             their place from signals only, so piling them on cannot inflate a score)
//   score   = weight x (signal - 0.5).  noul = weight x P(yes).
//   ask     = weight x max(0, 2 x P(yes) - 1): for "asked for this by name". A request only counts
//             once Jev thinks it more likely than not, so a stray 0.4 cannot slip a part in.
//   need    = weight x 2 x (P(yes) - 0.5): for a yes/no that falls back to the record and so never
//             rests at zero. Below even odds it counts AGAINST the part.
//   priority / intent = affinity x probability
//   covers  = add-ons this fare already includes (so they are never sold on top of it)
//   bars    = add-ons this fare cannot carry
// ---------------------------------------------------------------------------
export const COMPONENTS = [
  // ---- fares (pick exactly one) ----
  { id: 'no_offer', group: 'fare', name: 'Service first — no sale', short: 'no sale', cabin: null,
    cash: 0, margin: 0, loyaltyBase: 0.35, recovery: 0.45, base: 0.15, upsell: false, wIntent: 1.0,
    score: {}, noul: { special_assistance: 0.9 },
    priority: {}, intent: { service_complaint: 1, cancel_or_refund: 1 }, covers: [], giftsOnly: true },
  { id: 'basic_economy', group: 'fare', name: 'Basic Economy', short: 'Basic Economy', cabin: 'Basic Economy',
    cash: -40, margin: 15, loyaltyBase: 0.10, recovery: 0, base: 0.35, upsell: false,
    score: { price_sensitivity: 0.7, comfort_preference: -0.6, disruption_concern: -0.2 },
    noul: { together_seating: -0.3, business_travel: -0.25, flexibility_need: -0.3, declines_extras: 0.15 },
    priority: { lowest_cost: 1 }, intent: { reduce_cost: 1, book_flight: 0.4 },
    covers: [], bars: ['preferred_seat', 'seat_choice', 'flexible_fare'],
    includes: 'a carry-on and a personal item; seat assigned at the gate; no changes' },
  { id: 'main_cabin', group: 'fare', name: 'Main Cabin', short: 'Main Cabin', cabin: 'Main Cabin',
    cash: 0, margin: 45, loyaltyBase: 0.30, recovery: 0, base: 0.45, upsell: false,
    score: { price_sensitivity: 0.2, comfort_preference: -0.1 },
    noul: { together_seating: 0.1 },
    priority: { lowest_cost: 0.4, unclear: 0.6 }, intent: { book_flight: 1, ask_information: 0.6, other: 0.6 },
    covers: [],
    includes: 'a carry-on and a personal item; free seat assignment at check-in; changes allowed for the fare difference' },
  { id: 'premium_economy', group: 'fare', name: 'Premium Economy', short: 'Premium Economy', cabin: 'Premium Economy',
    cash: 119, margin: 130, loyaltyBase: 0.50, recovery: 0, base: 0.35, upsell: true,
    score: { comfort_preference: 0.7, upgrade_propensity: 0.35 },
    noul: { business_travel: 0.15 },
    priority: { comfort: 1 }, intent: { upgrade: 1, book_flight: 0.4 },
    covers: ['preferred_seat', 'seat_choice', 'checked_bag'],
    includes: 'a wider seat with extra legroom, advance seat selection, one checked bag, a meal and priority boarding' },
  { id: 'first_class', group: 'fare', name: 'First Class', short: 'First Class', cabin: 'First',
    cash: 420, margin: 300, loyaltyBase: 0.60, recovery: 0, base: 0.22, upsell: true,
    score: { comfort_preference: 0.7, upgrade_propensity: 0.4 },
    noul: { business_travel: 0.15 },
    priority: { comfort: 0.8 }, intent: { upgrade: 0.9 },
    covers: ['preferred_seat', 'seat_choice', 'checked_bag', 'lounge_pass'],
    includes: 'a lie-back First seat, lounge access, advance seat selection, two checked bags, a full meal and priority boarding' },

  // ---- payment method for an upgrade fare (optional; replaces the upgrade's cash price) ----
  { id: 'miles_cash', group: 'payment', name: 'paid with miles + cash', short: 'on miles', cabin: null,
    cash: 75, margin: 60, /* per-fare figures live in MILES_PRICE */ loyaltyBase: 0.90, recovery: 0, base: 0, upsell: true,
    score: { price_sensitivity: 0.25 },
    noul: {}, ask: { wants_miles: 0.6 },
    priority: { loyalty_optimization: 1 }, intent: { use_loyalty_benefits: 1 } },

  // ---- add-ons (any subset the fare can carry) ----
  { id: 'preferred_seat', group: 'addon', name: 'Extra legroom seat', short: 'extra legroom', cabin: null,
    cash: 39, margin: 33, loyaltyBase: 0.35, recovery: 0, base: 0, upsell: true,
    score: { comfort_preference: 0.4 },
    noul: {}, ask: { asked_legroom: 0.9 },
    priority: { comfort: 0.3 }, intent: { upgrade: 0.4 } },
  { id: 'seat_choice', group: 'addon', name: 'Advance seat selection', short: 'seat selection', cabin: null,
    cash: 15, margin: 13, loyaltyBase: 0.30, recovery: 0, base: 0, upsell: true,
    score: {},
    noul: { together_seating: 0.35 }, ask: { wants_seat_choice: 0.8 },
    priority: {}, intent: {} },
  { id: 'checked_bag', group: 'addon', name: 'Prepaid checked bag', short: 'checked bag', cabin: null,
    cash: 35, margin: 28, loyaltyBase: 0.30, recovery: 0, base: 0, upsell: true,
    score: {},
    noul: {}, need: { needs_bags: 0.7 },
    priority: {}, intent: {} },
  { id: 'lounge_pass', group: 'addon', name: 'Lounge pass', short: 'lounge pass', cabin: null,
    cash: 59, margin: 28, loyaltyBase: 0.55, recovery: 0.2, base: 0, upsell: true,
    score: { comfort_preference: 0.2, disruption_concern: 0.1 },
    noul: { business_travel: 0.2 }, ask: { wants_lounge: 0.9 },
    priority: { loyalty_optimization: 0.3 }, intent: { use_loyalty_benefits: 0.4 } },
  { id: 'flexible_fare', group: 'addon', name: 'Flexible changes', short: 'flexible changes', cabin: null,
    cash: 80, margin: 55, loyaltyBase: 0.40, recovery: 0, base: 0, upsell: true,
    score: { disruption_concern: 0.15 },
    noul: { business_travel: 0.1 }, ask: { flexibility_need: 0.8 },
    priority: { flexibility: 1, reliability: 0.2 }, intent: { change_itinerary: 0.5 } },
  { id: 'direct_flight', group: 'addon', name: 'Nonstop routing', short: 'nonstop', cabin: null,
    cash: 60, margin: 20, loyaltyBase: 0.45, recovery: 0.3, base: 0, upsell: true,
    score: { disruption_concern: 0.8 },
    noul: { business_travel: 0.2 }, ask: { wants_nonstop: 0.9 },
    priority: { reliability: 1 }, intent: { change_itinerary: 0.6 } },
  { id: 'wifi', group: 'addon', name: 'Wi-Fi pass', short: 'Wi-Fi', cabin: null,
    cash: 12, margin: 9, loyaltyBase: 0.25, recovery: 0, base: 0, upsell: true,
    score: {},
    noul: { business_travel: 0.15 }, ask: { wants_wifi: 0.9 },
    priority: {}, intent: {} },
  { id: 'pet_cabin', group: 'addon', name: 'Pet in cabin', short: 'pet in cabin', cabin: null,
    cash: 95, margin: 70, loyaltyBase: 0.30, recovery: 0, base: 0, upsell: true,
    score: {},
    noul: {}, ask: { traveling_with_pet: 1.0 },
    priority: {}, intent: {} },
  { id: 'goodwill_miles', group: 'addon', name: `${GOODWILL_MILES.toLocaleString()} goodwill miles`, short: 'goodwill miles', cabin: null,
    cash: 0, margin: -15, loyaltyBase: 0.80, recovery: 0.6, base: 0, upsell: false, gift: true,
    score: {},
    noul: { delay_complaint: 0.8 },
    priority: {}, intent: { service_complaint: 0.8 } },
];

export const BY_ID = Object.fromEntries(COMPONENTS.map((c) => [c.id, c]));
export const FARES = COMPONENTS.filter((c) => c.group === 'fare');
export const ADDONS = COMPONENTS.filter((c) => c.group === 'addon');
export const CATALOG = COMPONENTS; // kept for callers that only need the component list

// Which Jev signal means "the customer asked for this part by name". Drives the price relief
// above and the agent's "you raised X, here is the package that has it" hint.
export const ASKED_BY = { miles_cash: 'wants_miles', preferred_seat: 'asked_legroom', seat_choice: 'wants_seat_choice',
  checked_bag: 'needs_bags', lounge_pass: 'wants_lounge', flexible_fare: 'flexibility_need', direct_flight: 'wants_nonstop',
  wifi: 'wants_wifi', pet_cabin: 'traveling_with_pet' };

// Extra dollars per traveler the customer will accept at each level of Jev's price ladder
// (level 0 = price is no factor ... level 3 = rejects any extra cost). A business assumption, set in code.
export const BUDGET_BY_LEVEL = [Infinity, 130, 45, 0];

// affordability = sum over levels of P(level) x min(1, budget / extra cash). Uses the ladder's
// per-level probabilities as thresholds rather than turning the score back into a dollar figure.
export function affordabilityOf(cash, signals) {
  if (cash <= 0) return 1;
  let p = signals.price_levels;
  if (!p) { // no Jev distribution (record-only signals): split the prior across its two nearest levels
    const x = (signals.values.price_sensitivity ?? 0.5) * 3, lo = Math.min(2, Math.floor(x)), f = x - lo;
    p = [0, 0, 0, 0]; p[lo] = 1 - f; p[lo + 1] = f;
  }
  return p.reduce((s, pr, i) => s + pr * Math.min(1, BUDGET_BY_LEVEL[i] / cash), 0);
}

const clamp01 = (x) => Math.max(0, Math.min(1, x));
const r3 = (x) => Math.round(x * 1000) / 1000;

// ---- Eligibility: hard business rules from the customer record only ----
export function eligibility(component, c) {
  switch (component.id) {
    case 'miles_cash': {
      const need = MILES_PER_UPGRADE * c.party;
      return c.miles >= need ? ok() : no(`Needs ${need.toLocaleString()} miles for ${c.party} traveler${c.party > 1 ? 's' : ''}; has ${Number(c.miles).toLocaleString()}.`);
    }
    case 'checked_bag': return TIER_RANK[c.tier] >= 2 ? no(`${c.tier} already includes a free checked bag.`) : ok();
    case 'lounge_pass': return c.tier === 'Platinum' ? no('Platinum already includes lounge access.') : ok();
    case 'direct_flight': return c.stops === 'Nonstop' ? no('Current itinerary is already nonstop.') : ok();
    case 'basic_economy': return TIER_RANK[c.tier] >= 3 ? no('Not offered to Platinum members (policy).') : ok();
    case 'goodwill_miles': return c.disruptions >= 1 ? ok() : no('Goodwill miles need a delay or cancellation on the record in the last 6 months; this record shows none.');
    default: return ok();
  }
}
const ok = () => ({ eligible: true, reason: '' });
const no = (reason) => ({ eligible: false, reason });

// What can ride on what. A fare never carries an add-on it already includes (that would be
// charging twice), Basic Economy cannot carry seat or change products, "no sale" carries only
// gifts, and the miles payment applies only to an upgrade.
export function compatible(fareId, componentId) {
  const fare = BY_ID[fareId], part = BY_ID[componentId];
  if (componentId === 'miles_cash') return fareId === 'premium_economy' || fareId === 'first_class';
  if (fare.giftsOnly) return !!part.gift;
  if ((fare.covers || []).includes(componentId)) return false;
  if ((fare.bars || []).includes(componentId)) return false;
  return true;
}

// ---- Loyalty value: arithmetic on the record. Done in code, not asked of Jev (it is not a calculator). ----
export function loyaltyValue(c) {
  return r3(clamp01(0.4 * (TIER_RANK[c.tier] / 3) + 0.35 * Math.min(1, c.flights12 / 30) + 0.25 * Math.min(1, (c.avgSpend * c.flights12) / 15000)));
}

// ---- Priors: what the static record alone suggests. Used before the first message and when JEV is OFF. ----
export function priorSignals(c) {
  const s = c.avgSpend;
  return {
    source: 'profile',
    values: {
      price_sensitivity: s < 250 ? 0.75 : s < 450 ? 0.55 : s < 800 ? 0.4 : 0.2,
      comfort_preference: { 'Basic Economy': 0.25, 'Main Cabin': 0.45, 'Premium Economy': 0.7, First: 0.9 }[c.cabin] ?? 0.45,
      disruption_concern: c.disruptions === 0 ? 0.2 : c.disruptions === 1 ? 0.45 : 0.7,
      purchase_readiness: 0.5,
      upgrade_propensity: c.upgrades === 0 ? 0.2 : c.upgrades <= 2 ? 0.5 : 0.75,
      business_travel: c.flights12 >= 20 ? 0.6 : 0.3,
      needs_bags: { Never: 0.05, Sometimes: 0.4, Usually: 0.75, Always: 0.95 }[c.bags] ?? 0.4,
      together_seating: c.party > 1 ? 0.7 : 0,
      flexibility_need: 0.1,
      delay_complaint: 0,
      special_assistance: 0,
      traveling_with_pet: 0,
      confirms_purchase: 0,
      wants_miles: c.miles >= 40000 ? 0.5 : 0.2,
      wants_nonstop: 0,
      asked_legroom: 0,
      wants_seat_choice: c.party > 1 ? 0.5 : 0,
      wants_lounge: 0,
      wants_wifi: c.flights12 >= 20 ? 0.4 : 0.1,
      declines_extras: 0,
    },
    // The record says nothing about intent, priority or a named cabin, so these contribute zero until Jev reports.
    trip_priority: { pick: null, confidence: null, probabilities: {} },
    primary_intent: { pick: null, confidence: null, probabilities: {} },
    requested_cabin: { pick: null, confidence: null, probabilities: {} },
    party_size_stated: { pick: null, confidence: null, probabilities: {} },
  };
}

// ---- Jev answers -> structured customer decision state ----
export function signalsFromJev(answers) {
  const values = {};
  for (const [id, def] of Object.entries(SIGNALS)) {
    const a = answers[id];
    if (!a) continue;
    if (def.kind === 'noul') values[id] = r3(a.noul);
    else values[id] = r3(a.score / (Object.keys(a.probabilities).length - 1)); // expectation / top level
  }
  const choice = (a) => (a
    ? { pick: a.choice, confidence: a.confidence, probabilities: a.probabilities }
    : { pick: null, confidence: null, probabilities: {} });
  const pl = answers.price_sensitivity?.probabilities;
  return {
    source: 'jev',
    values,
    price_levels: pl ? Object.keys(pl).sort().map((k) => pl[k]) : null,
    trip_priority: choice(answers.trip_priority),
    primary_intent: choice(answers.primary_intent),
    requested_cabin: choice(answers.requested_cabin),
    party_size_stated: choice(answers.party_size_stated),
  };
}

// How many travelers the customer SAID are going, when that differs from the record. Jev picks
// from a fixed list of sizes; code only takes it when the pick is confident.
export const PARTY_OPTIONS = { one: 1, two: 2, three: 3, four: 4, five_or_more: 5 };
export function statedParty(signals) {
  const a = signals.party_size_stated;
  if (!a?.pick || a.pick === 'not_stated') return null;
  return (a.probabilities?.[a.pick] ?? 0) >= 0.7 ? PARTY_OPTIONS[a.pick] ?? null : null;
}

// Share of the conversation that is a complaint, a cancellation or an assistance request, 0..1. In that mode the
// right move is usually not to sell.
export function serviceMode(signals) {
  const p = signals.primary_intent?.probabilities || {};
  return clamp01((p.service_complaint ?? 0) + (p.cancel_or_refund ?? 0) + 0.8 * (signals.values.special_assistance ?? 0));
}

// ---------------------------------------------------------------------------
// Step 1 — how well does each COMPONENT match this customer, on its own?
// Computed once per decision, then summed into bundles. `fit` excludes the fare's
// standing base utility and the price term; both are handled at bundle level,
// because price is only meaningful for the package as a whole.
// ---------------------------------------------------------------------------
export function componentFits(signals) {
  const v = signals.values;
  const cabinP = signals.requested_cabin?.probabilities || {};
  const out = {};
  for (const o of COMPONENTS) {
    const terms = [];
    for (const [k, a] of Object.entries(o.score || {})) terms.push({ key: k, label: SIGNALS[k].label, signal: v[k], weight: a, value: r3(a * ((v[k] ?? 0.5) - 0.5)) });
    for (const [k, a] of Object.entries(o.noul || {})) terms.push({ key: k, label: SIGNALS[k].label, signal: v[k], weight: a, value: r3(a * (v[k] ?? 0)) });
    for (const [k, a] of Object.entries(o.ask || {})) terms.push({ key: k, label: SIGNALS[k].label, signal: v[k], weight: a, value: r3(a * Math.max(0, 2 * (v[k] ?? 0) - 1)) });
    for (const [k, a] of Object.entries(o.need || {})) terms.push({ key: k, label: SIGNALS[k].label, signal: v[k], weight: a, value: r3(a * 2 * ((v[k] ?? 0.5) - 0.5)) });
    const pm = Object.entries(o.priority || {}).reduce((s, [k, a]) => s + a * (signals.trip_priority.probabilities[k] ?? 0), 0);
    const im = Object.entries(o.intent || {}).reduce((s, [k, a]) => s + a * (signals.primary_intent.probabilities[k] ?? 0), 0);
    const wI = o.wIntent ?? 0.15;
    if (pm > 0) terms.push({ key: 'trip_priority', label: 'Trip priority match', signal: r3(pm), weight: 0.25, value: r3(0.25 * pm) });
    if (im > 0) terms.push({ key: 'primary_intent', label: 'Intent match', signal: r3(im), weight: wI, value: r3(wI * im) });
    if (o.group === 'fare' && cabinP[o.id] > 0.005) terms.push({ key: 'requested_cabin', label: 'Asked for this cabin by name', signal: r3(cabinP[o.id]), weight: CABIN_ASK, value: r3(CABIN_ASK * cabinP[o.id]) });
    if (o.upsell && (v.declines_extras ?? 0) > 0.005) terms.push({ key: 'declines_extras', label: SIGNALS.declines_extras.label, signal: v.declines_extras, weight: -DECLINE_BITE, value: r3(-DECLINE_BITE * v.declines_extras) });
    out[o.id] = { id: o.id, name: o.name, short: o.short, group: o.group, terms, fit: r3(terms.reduce((s, t) => s + t.value, 0)) };
  }
  return out;
}

// How strongly the customer asked for a part by name, 0..1.
function askedFor(part, signals) {
  if (part.group === 'fare') return signals.requested_cabin?.probabilities?.[part.id] ?? 0;
  const k = ASKED_BY[part.id];
  return k ? (signals.values[k] ?? 0) : 0;
}

// ---------------------------------------------------------------------------
// Step 2 — every valid combination. One fare, optional miles payment on an
// upgrade, any subset of the add-ons that fare can carry. Components the customer
// cannot have are dropped first, so every bundle generated is actually bookable.
// ---------------------------------------------------------------------------
export function bundleSpace(customer) {
  const blocked = {};
  for (const c of COMPONENTS) { const e = eligibility(c, customer); if (!e.eligible) blocked[c.id] = e.reason; }
  const fares = FARES.filter((f) => !blocked[f.id]);
  const addons = ADDONS.filter((a) => !blocked[a.id]);

  const bundles = [];
  for (const fare of fares) {
    const canPayMiles = !blocked.miles_cash && compatible(fare.id, 'miles_cash') && customer.miles >= MILES_PRICE[fare.id].miles * customer.party;
    const payments = [null, ...(canPayMiles ? ['miles_cash'] : [])];
    const usable = addons.filter((a) => compatible(fare.id, a.id));
    for (const payment of payments) {
      for (let mask = 0; mask < (1 << usable.length); mask += 1) {
        const picked = usable.filter((_, i) => mask & (1 << i));
        bundles.push({
          id: [fare.id, ...(payment ? [payment] : []), ...picked.map((a) => a.id)].join('+'),
          fare: fare.id,
          payment,
          addons: picked.map((a) => a.id),
        });
      }
    }
  }
  return { bundles, blocked };
}

// The size of the catalog's combination space, ignoring who is asking. Shown in the UI so the
// count on screen is not mistaken for the whole menu.
let CATALOG_SIZE = null;
export function catalogSize() {
  if (CATALOG_SIZE == null) {
    CATALOG_SIZE = FARES.reduce((n, fare) => n
      + (compatible(fare.id, 'miles_cash') ? 2 : 1) * (1 << ADDONS.filter((a) => compatible(fare.id, a.id)).length), 0);
  }
  return CATALOG_SIZE;
}

// ---------------------------------------------------------------------------
// Step 3 — score every combination.
// ---------------------------------------------------------------------------
// `offered` is the name of the package the agent put in front of the customer last turn. When the
// customer says yes, that package is what they said yes to, so it is held at the top rather than
// letting this turn's re-reading of their mood swap it out from under them.
export function scoreOffers(customer, signals, weights = DEFAULT_WEIGHTS, { offered = null } = {}) {
  const t0 = performance.now();
  const v = signals.values;
  const wSum = Object.values(weights).reduce((a, b) => a + b, 0) || 1;
  const w = Object.fromEntries(Object.entries(weights).map(([k, x]) => [k, x / wSum]));
  const lv = loyaltyValue(customer);
  const fits = componentFits(signals);
  const service = serviceMode(signals);
  const { bundles, blocked } = bundleSpace(customer);

  const rows = bundles.map((b) => {
    const fare = BY_ID[b.fare];
    const pay = b.payment ? BY_ID[b.payment] : null;
    const addons = b.addons.map((id) => BY_ID[id]);
    const parts = [fare, ...(pay ? [pay] : []), ...addons];

    // ---- price ----
    const onMiles = pay ? MILES_PRICE[fare.id] : null;      // miles payment replaces the upgrade's cash price
    const fareCash = onMiles ? onMiles.cash : fare.cash;
    const extrasCash = addons.reduce((s, a) => s + a.cash, 0);
    const cash = fareCash + extrasCash;
    const miles = onMiles ? onMiles.miles * customer.party : 0;
    const margin = (onMiles ? onMiles.margin : fare.margin) + addons.reduce((s, a) => s + a.margin, 0);
    // Affordability is tested on the part of the price the customer did NOT ask for.
    const surprise = Math.max(0, fareCash) * (1 - ASKED_PRICE_RELIEF * askedFor(fare, signals))
      + addons.reduce((s, a) => s + a.cash * (1 - ASKED_PRICE_RELIEF * askedFor(a, signals)), 0)
      + Math.min(0, fareCash);
    const affordability = affordabilityOf(surprise, signals);

    // ---- match: the fare's standing utility, every component's fit, then the price term ----
    const terms = [{ key: 'base', label: `Base utility — ${fare.name}`, value: fare.base }];
    for (const p of parts) for (const t of fits[p.id].terms) terms.push({ ...t, part: p.short });
    // A fare that already includes something the customer wants gets credit for it.
    for (const id of fare.covers || []) {
      if (blocked[id]) continue;
      const credit = r3(COVERED_CREDIT * Math.max(0, fits[id].fit));
      if (credit > 0.02) terms.push({ key: 'covered', label: `Already includes ${BY_ID[id].short}`, signal: fits[id].fit, weight: COVERED_CREDIT, value: credit, part: fare.short });
    }
    if (miles > 0) {
      const share = Math.min(1, miles / Math.max(1, customer.miles));
      terms.push({ key: 'miles_drain', label: `Uses ${Math.round(share * 100)}% of the miles balance`, signal: r3(share), weight: -MILES_DRAIN, value: r3(-MILES_DRAIN * share * share), part: pay.short });
    }
    for (const a of addons) {
      const noise = r3(-(a.gift ? 2 : 1) * NOISE_COST * (1 - clamp01(2 * fits[a.id].fit)));   // a giveaway for no reason is worse than a pitch for no reason
      if (noise < -0.005) terms.push({ key: 'noise', label: 'Not asked for', signal: fits[a.id].fit, weight: -NOISE_COST, value: noise, part: a.short });
    }
    const yes = signals.values.confirms_purchase ?? 0;
    if (offered && yes >= 0.7 && fare.id !== 'no_offer' && bundleName(b) === offered) terms.push({ key: 'accepted', label: 'The customer said yes to this package', signal: yes, weight: ACCEPTED_BONUS, value: r3(ACCEPTED_BONUS * yes) });
    // The price penalty is the share of the ask the customer cannot absorb, weighted by how big the
    // ask is. A flat +/- band would let a large pile of add-ons look as harmless as a $39 seat.
    if (surprise > 0) terms.push({ key: 'affordability', label: `Price of the package ($${cash}${surprise < cash - 0.5 ? `, $${Math.round(surprise)} of it unasked` : ''})`, signal: r3(affordability), weight: r3(PRICE_BITE * Math.min(1, surprise / PRICE_FULL_BITE_AT)), value: r3(-PRICE_BITE * (1 - affordability) * Math.min(1, surprise / PRICE_FULL_BITE_AT)) });
    const match = terms.reduce((s, t) => s + t.value, 0);

    // ---- conversion: readiness + affordability of the WHOLE package, minus the cost of each UNWANTED ask ----
    const upsell = parts.some((p) => p.upsell);
    const unwanted = addons.reduce((s, a) => s + (1 - clamp01(2 * fits[a.id].fit)), 0);
    const friction = ASK_FRICTION ** unwanted;
    // "No sale" converts exactly as often as the conversation is a service call; a sale converts
    // badly during one.
    const conversion = fare.giftsOnly
      ? clamp01(service * friction)
      : clamp01((0.10 + 0.35 * (v.purchase_readiness ?? 0.5) + 0.55 * affordability
        + (upsell ? 0.2 * ((v.upgrade_propensity ?? 0.5) - 0.5) : 0)) * friction * (1 - SERVICE_DAMPER * service));

    // Revenue is what the airline can EXPECT to earn, not what the package lists for. Gross margin
    // alone would always crown the biggest pile of add-ons. So the package's margin is weighed by
    // its conversion, and each add-on's share by how much the customer wanted it: an add-on nobody
    // asked for brings friction and no money. A giveaway costs its full amount either way.
    const wantedMargin = (onMiles ? onMiles.margin : fare.margin)
      + addons.reduce((s, a) => s + (a.margin < 0 ? a.margin : a.margin * clamp01(2 * fits[a.id].fit)), 0);
    const expectedMargin = wantedMargin * conversion;

    // ---- loyalty: the strongest gesture in the bundle, but a perk only earns loyalty if it was wanted ----
    const gesture = Math.max(...parts.map((p) => p.loyaltyBase * (p.group === 'fare' ? 1 : clamp01(2 * fits[p.id].fit))));
    const recovery = Math.max(...parts.map((p) => p.recovery || 0));
    const loyalty = clamp01(gesture * (0.5 + 0.5 * lv) + recovery * (v.delay_complaint ?? 0));

    return {
      id: b.id, fare: b.fare, payment: b.payment, addons: b.addons,
      parts: parts.map((p) => ({ id: p.id, name: p.name, short: p.short, group: p.group, fit: fits[p.id].fit })),
      name: bundleName(b), eligible: true, reason: '',
      match, conversion, expectedMargin, loyalty, terms,
      detail: { affordability: r3(affordability), loyaltyValue: lv, cash, miles, margin,
        expectedMargin: Math.round(expectedMargin), friction: r3(friction), extras: addons.length,
        unwantedAsks: r3(unwanted), serviceMode: r3(service),
        perTraveler: fare.giftsOnly ? 0 : customer.baseFare + cash, total: fare.giftsOnly ? 0 : (customer.baseFare + cash) * customer.party },
      price: priceLabel({ fare, fareCash, extrasCash, miles, payment: b.payment }, customer),
    };
  });

  // Two components are scaled against the best package in this customer's own set rather than a
  // fixed ceiling: match, because a sum of fits has no natural maximum and a hard clamp would make
  // every strong package look identical; and revenue, because expected margin is dollars.
  const bestMatch = Math.max(0.001, ...rows.map((r) => r.match));
  const bestExpected = Math.max(1, ...rows.map((r) => r.expectedMargin));
  for (const r of rows) {
    const customerValue = clamp01(r.match / bestMatch);
    const revenue = clamp01(r.expectedMargin / bestExpected);
    r.components = { customerValue: r3(customerValue), conversion: r3(r.conversion), revenue: r3(revenue), loyalty: r3(r.loyalty) };
    r.detail.match = r3(r.match);
    r.exact = 100 * (w.customerValue * customerValue + w.conversion * r.conversion + w.revenue * revenue + w.loyalty * r.loyalty);
    r.score = Math.round(r.exact * 10) / 10;
    delete r.match; delete r.conversion; delete r.expectedMargin; delete r.loyalty;
  }

  // Exact score first; on a dead heat the smaller package wins, then the id, so the order is
  // identical wherever this runs.
  rows.sort((a, b) => (b.exact - a.exact) || (a.addons.length - b.addons.length) || (a.id < b.id ? -1 : 1));
  rows.forEach((r, i) => { r.rank = i + 1; delete r.exact; });
  return {
    ranking: rows,
    blocked: Object.entries(blocked).map(([id, reason]) => ({ id, name: BY_ID[id].name, reason })),
    counts: { scored: rows.length, catalog: catalogSize() },
    weights: w, loyaltyValue: lv, serviceMode: r3(service), latency_ms: performance.now() - t0,
  };
}

export function bundleName(b) {
  const fare = BY_ID[b.fare];
  const head = fare.name + (b.payment ? ' on miles' : '');
  const tail = b.addons.map((id) => BY_ID[id].short);
  return tail.length ? `${head} + ${tail.join(' + ')}` : head;
}

function priceLabel({ fare, fareCash, extrasCash, miles, payment }, c) {
  if (fare.giftsOnly) return 'nothing to buy';
  const n = c.party, each = miles / n;
  let s = `$${c.baseFare + fareCash} fare`;
  if (payment) s += ` + ${each.toLocaleString()} miles`;
  if (extrasCash > 0) s += ` + $${extrasCash} extras`;
  if (n > 1) s += ` each · $${((c.baseFare + fareCash + extrasCash) * n).toLocaleString()}${payment ? ` + ${miles.toLocaleString()} miles` : ''} for ${n}`;
  return s;
}

// ---- Words for a number ----
export const level = (x) => (x >= 0.7 ? 'high' : x >= 0.4 ? 'moderate' : 'low');

export function whyText(row) {
  const t = row.terms.filter((x) => x.key !== 'base' && x.key !== 'noise');
  const pos = t.filter((x) => x.value > 0.02).sort((a, b) => b.value - a.value).slice(0, 3);
  const neg = t.filter((x) => x.value < -0.03).sort((a, b) => a.value - b.value).slice(0, 1);
  const say = (x) => {
    const core = x.key === 'affordability' ? 'over the stated budget'
      : x.key === 'requested_cabin' ? 'asked for by name'
        : x.key === 'accepted' ? 'the customer said yes to it'
        : x.key === 'covered' || x.key === 'miles_drain' ? x.label.toLowerCase()
          : x.key === 'trip_priority' || x.key === 'primary_intent' ? x.label.toLowerCase()
            : SIGNALS[x.key]?.kind === 'noul' ? x.label.toLowerCase()
              : `${level(x.signal)} ${x.label.toLowerCase()}`;
    return x.part && x.key !== 'covered' ? `${core} (${x.part})` : core;
  };
  let s = pos.length ? pos.map(say).join(', ') : 'no strong signal; ranks on economics';
  if (neg.length) s += `. Held back by ${neg.map(say).join(', ')}`;
  const unasked = row.terms.filter((x) => x.key === 'noise' && x.value < -0.06).length;
  if (unasked >= 1) s += `. ${unasked} part${unasked > 1 ? 's' : ''} the customer showed no interest in`;
  return s.charAt(0).toUpperCase() + s.slice(1) + '.';
}

// The three packages worth SHOWING: the winner, then the best package built on a different fare,
// then the best on a third. The raw top three are usually one package with and without Wi-Fi,
// which gives the customer nothing to choose between. Each keeps its true rank.
export function shortlist(ranking, n = 3) {
  const out = [], seen = new Set();
  for (const r of ranking) {
    const key = r.fare + (r.payment ? '+miles' : '');
    if (seen.has(key)) continue;
    seen.add(key); out.push(r);
    if (out.length === n) break;
  }
  return out;
}

// A booking reference that is stable for a given customer and turn, so the agent never invents one.
export function confirmationCode(customer, cycle, what = '') {
  let h = 2166136261;
  for (const ch of `${customer.account}|${customer.name}|${cycle}|${what}`) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < 6; i += 1) { out += A[h % A.length]; h = Math.floor(h / A.length) + (i + 1) * 7919; }
  return out;
}

// The customer said yes. What they accepted is the package that was ON OFFER when they said it
// (last turn's top), not whatever this turn's re-ranking put first.
export function acceptedPackage({ signals, ranking, previousTop }) {
  if ((signals.values.confirms_purchase ?? 0) < 0.7 || !previousTop) return null;
  const r = ranking.find((x) => x.name === previousTop);
  return r && r.fare !== 'no_offer' ? r : null;
}

// ---- Structured decision context handed to the conversational model ----
export function buildAgentContext({ cycle, customer, signals, ranking, blocked = [], previousTop, jevOn, flight = null }) {
  const v = signals.values;
  const intent = signals.primary_intent.probabilities || {};
  const top = shortlist(ranking);
  const recommended = top[0];
  const noSale = recommended?.fare === 'no_offer';
  const brief = (r) => {
    if (!r) return null;
    if (r.fare === 'no_offer') {
      return { action: 'Do not sell anything this turn. Deal with what the customer raised.',
        gift: r.addons.includes('goodwill_miles') ? `${BY_ID.goodwill_miles.name}, added to the account now` : null,
        decision_score: r.score, why: whyText(r) };
    }
    const fare = BY_ID[r.fare];
    return {
      package: r.name,
      fare: fare.name,
      fare_already_includes: fare.includes,
      added_to_the_fare: r.parts.filter((p) => p.group !== 'fare').map((p) => p.name),
      quote_this_price: r.detail.miles
        ? `$${r.detail.perTraveler} plus ${(r.detail.miles / customer.party).toLocaleString()} miles per traveler${customer.party > 1 ? `; $${r.detail.total.toLocaleString()} plus ${r.detail.miles.toLocaleString()} miles for all ${customer.party}` : ''}`
        : `$${r.detail.perTraveler} per traveler${customer.party > 1 ? `; $${r.detail.total.toLocaleString()} for all ${customer.party}` : ''}`,
      change_from_their_current_ticket_usd: r.detail.cash,
      total_per_traveler_usd: r.detail.perTraveler,
      total_for_party_usd: r.detail.total,
      miles_per_traveler: r.detail.miles ? r.detail.miles / customer.party : 0,
      rank_among_all_packages: r.rank,
      decision_score: r.score,
      why: whyText(r),
    };
  };

  const accepted = acceptedPackage({ signals, ranking, previousTop });
  const booking = accepted ? { status: 'CONFIRMED', ...brief(accepted), confirmation_code: confirmationCode(customer, cycle, accepted.id) } : null;
  if (booking) { delete booking.rank_among_all_packages; delete booking.decision_score; delete booking.why; }

  const g = [];
  if (booking) g.push(`The customer said yes. Confirm the booking of "${accepted.name}": say what is in it, the total, and the confirmation code ${booking.confirmation_code}. Do not offer anything else this turn.`);
  if (noSale) g.push('This is a service moment, not a sales moment. Do not offer, price or mention any fare, upgrade or add-on. Help with what they raised using AIRLINE FACTS.');
  if (v.delay_complaint >= 0.6) g.push('Acknowledge the past delays and apologize sincerely BEFORE anything else.');
  if (recommended?.addons.includes('goodwill_miles')) g.push(`Tell the customer you have added ${BY_ID.goodwill_miles.name} to their account as an apology. It is already done; do not make it conditional.`);
  if ((intent.cancel_or_refund ?? 0) >= 0.5) g.push('Customer wants to cancel or get money back. Explain the cancellation and refund rules from AIRLINE FACTS that apply to them, and offer to start it. Do not try to save the sale.');
  if (v.special_assistance >= 0.6) g.push('Customer asked for special assistance. Confirm it is free, that you have added the request to the booking, and ask what else would help. Do not sell.');
  if ((intent.ask_information ?? 0) >= 0.5) g.push('Customer asked a factual question. Answer it FIRST and directly from FLIGHT and AIRLINE FACTS. Mention the recommended package only if it bears on what they asked.');
  if ((intent.other ?? 0) >= 0.5) g.push('Customer is making small talk or is off topic. Reply briefly and warmly, do not pitch, and steer back to their trip.');
  const selling = !noSale && !booking;
  if (selling && v.price_sensitivity >= 0.6) g.push('Customer is price sensitive. Do not push First Class or other high-price options; lead with value.');
  if (selling && v.declines_extras >= 0.6) g.push('Customer has refused extras. Offer the fare on its own and do not mention add-ons.');
  if (selling && v.purchase_readiness < 0.35) g.push('Customer is not ready to buy. Do not hard-close; answer, then ask one clarifying question.');
  if (selling && v.purchase_readiness >= 0.7) g.push('Customer is ready. Offer to proceed with the recommended package.');
  if (v.together_seating >= 0.6) g.push(customer.party > 1 ? `Confirm adjacent seats for the party of ${customer.party}.` : 'Customer wants to sit with a companion. Confirm you can seat them together.');

  const blockedIds = new Set(blocked.map((b) => b.id));
  const has = (r, id) => r && (r.fare === id || r.payment === id || r.addons.includes(id) || (BY_ID[r.fare].covers || []).includes(id));
  const bestWith = (id) => ranking.find((r) => r.fare !== 'no_offer' && has(r, id));

  // If the customer raised something specific, hand the agent the best real package that contains
  // it — priced as a package — so it never has to improvise a combination of its own.
  const also = [];
  for (const [id, signal] of Object.entries(ASKED_BY)) {
    if ((v[signal] ?? 0) < 0.6) continue;
    if (blockedIds.has(id)) { g.push(`Customer raised ${BY_ID[id].short}: ${blocked.find((b) => b.id === id).reason} Tell them so plainly.`); continue; }
    if (!selling || has(recommended, id)) continue;
    const b = bestWith(id);
    if (b && !also.some((a) => a.package === b.name)) also.push({ ...brief(b), note: `Customer raised ${BY_ID[id].short}. This is the best package that has it; state its real price.` });
  }
  const cabinAsk = signals.requested_cabin?.pick;
  if (cabinAsk && cabinAsk !== 'none' && (signals.requested_cabin.probabilities[cabinAsk] ?? 0) >= 0.6 && blockedIds.has(cabinAsk)) {
    g.push(`Customer asked for ${BY_ID[cabinAsk].name}: ${blocked.find((b) => b.id === cabinAsk).reason} Tell them so plainly.`);
  }

  if (selling && recommended) {
    const added = recommended.parts.filter((p) => p.group !== 'fare').map((p) => p.name);
    g.push(added.length
      ? `The recommended package is ${BY_ID[recommended.fare].name} with these added: ${added.join(', ')}. Present it as ONE package at ONE price (quote_this_price). Nothing else is added.`
      : `The recommended package is the ${BY_ID[recommended.fare].name} fare on its own. Nothing is added to it. You may describe what the fare already includes.`);
  }
  g.push('Only quote packages and prices that appear in this context. Never invent fares, policies or combinations, and never do price arithmetic of your own.');

  return {
    decision_cycle: cycle,
    signal_source: jevOn ? 'JEV conversational signals + customer record' : 'customer record only (JEV off)',
    customer: { name: customer.name, loyalty_tier: customer.tier, miles_balance: customer.miles, party_size: customer.party,
      main_cabin_fare_usd: customer.baseFare, currently_holds: `a Main Cabin ticket on this trip ($${customer.baseFare} per traveler), bought 3 days ago` },
    flight,
    interpreted_state: {
      primary_intent: signals.primary_intent.pick, intent_confidence: signals.primary_intent.confidence,
      trip_priority: signals.trip_priority.pick, priority_confidence: signals.trip_priority.confidence,
      cabin_asked_for: signals.requested_cabin?.pick ?? null,
      price_sensitivity: `${level(v.price_sensitivity)} (${v.price_sensitivity})`,
      comfort_preference: `${level(v.comfort_preference)} (${v.comfort_preference})`,
      disruption_concern: `${level(v.disruption_concern)} (${v.disruption_concern})`,
      purchase_readiness: `${level(v.purchase_readiness)} (${v.purchase_readiness})`,
      upgrade_propensity: `${level(v.upgrade_propensity)} (${v.upgrade_propensity})`,
      asked_for: Object.entries(ASKED_BY).filter(([, k]) => (v[k] ?? 0) >= 0.6).map(([id]) => BY_ID[id].short),
    },
    packages_considered: ranking.length,
    booking,
    recommended_action: brief(top[0]),
    secondary_option: noSale ? null : brief(top[1]),
    third_option: noSale ? null : brief(top[2]),
    change_since_last_cycle: previousTop && top[0] && previousTop !== top[0].name
      ? `Top recommendation changed: ${previousTop} -> ${top[0].name}.` : 'Top recommendation unchanged.',
    also_available_if_asked: also,
    not_available_to_this_customer: blocked.map((b) => ({ item: b.name, reason: b.reason })),
    guardrails: g,
  };
}
