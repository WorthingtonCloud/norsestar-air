// Believable fake customers. Pick an archetype, then jitter the numbers.
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const between = (lo, hi, step = 1) => Math.round((lo + Math.random() * (hi - lo)) / step) * step;

const FIRST = ['Astrid', 'Marcus', 'Priya', 'Lena', 'Devon', 'Ingrid', 'Tomás', 'Hannah', 'Kofi', 'Sigrid', 'Mei', 'Anders', 'Rosa', 'Elliot', 'Nadia', 'Bjorn'];
const LAST = ['Lindqvist', 'Okafor', 'Halvorsen', 'Reyes', 'Bergstrom', 'Patel', 'Nakamura', 'Sorensen', 'Whitfield', 'Dahl', 'Castillo', 'Eriksen', 'Novak', 'Thorsen'];
export const AIRPORTS = ['MSP', 'SEA', 'ORD', 'JFK', 'BOS', 'DEN', 'SFO', 'LAX', 'IAD', 'ATL', 'AUS', 'PDX'];
export const TIERS = ['Member', 'Silver', 'Gold', 'Platinum'];
export const CABINS = ['Basic Economy', 'Main Cabin', 'Premium Economy', 'First'];
export const SEATS = ['Window', 'Aisle', 'No preference'];
export const BAGS = ['Never', 'Sometimes', 'Usually', 'Always'];
export const STOPS = ['Nonstop', '1 stop'];

const ARCHETYPES = [
  { tag: 'Budget leisure', tier: ['Member', 'Member', 'Silver'], miles: [0, 14000], flights: [1, 4], spend: [140, 260], cabin: ['Basic Economy', 'Main Cabin'], bags: ['Sometimes', 'Usually'], upgrades: [0, 0], party: [1, 2] },
  { tag: 'Road warrior', tier: ['Gold', 'Platinum'], miles: [60000, 240000], flights: [24, 52], spend: [420, 780], cabin: ['Main Cabin', 'Premium Economy'], bags: ['Never', 'Sometimes'], upgrades: [2, 8], party: [1, 1] },
  { tag: 'Family traveler', tier: ['Member', 'Silver'], miles: [8000, 55000], flights: [2, 6], spend: [220, 380], cabin: ['Main Cabin'], bags: ['Usually', 'Always'], upgrades: [0, 1], party: [3, 5] },
  { tag: 'Premium leisure', tier: ['Silver', 'Gold'], miles: [30000, 120000], flights: [5, 12], spend: [650, 1400], cabin: ['Premium Economy', 'First'], bags: ['Usually', 'Always'], upgrades: [1, 4], party: [2, 2] },
  { tag: 'Occasional business', tier: ['Silver', 'Gold'], miles: [20000, 90000], flights: [8, 18], spend: [340, 560], cabin: ['Main Cabin'], bags: ['Never', 'Sometimes'], upgrades: [0, 3], party: [1, 1] },
];

export function randomCustomer() {
  const a = pick(ARCHETYPES);
  const home = pick(AIRPORTS);
  let destination = pick(AIRPORTS);
  while (destination === home) destination = pick(AIRPORTS);
  return {
    archetype: a.tag,
    name: `${pick(FIRST)} ${pick(LAST)}`,
    account: `NS-${between(10000000, 99999999)}`,
    tier: pick(a.tier),
    miles: between(a.miles[0], a.miles[1], 500),
    flights12: between(a.flights[0], a.flights[1]),
    avgSpend: between(a.spend[0], a.spend[1], 5),
    home, destination,
    stops: Math.random() < 0.6 ? '1 stop' : 'Nonstop',
    baseFare: between(179, 489, 10) - 1,
    cabin: pick(a.cabin),
    seat: pick(SEATS),
    bags: pick(a.bags),
    upgrades: between(a.upgrades[0], a.upgrades[1]),
    disruptions: pick([0, 0, 0, 1, 1, 2, 3]),
    party: between(a.party[0], a.party[1]),
  };
}

export function defaultCustomer() {
  return { archetype: 'Manual', name: 'Erik Lindqvist', account: 'NS-48210377', tier: 'Silver', miles: 42000, flights12: 9, avgSpend: 380,
    home: 'MSP', destination: 'SEA', stops: '1 stop', baseFare: 289, cabin: 'Main Cabin', seat: 'Aisle', bags: 'Sometimes', upgrades: 1, disruptions: 2, party: 1 };
}
