// A believable itinerary for any pair of airports, worked out in code so the agent never has to
// invent a departure time. Deterministic: the same customer always gets the same flights.
//
// Block time comes from great-circle distance; clock times respect each airport's UTC offset
// (summer offsets; the demo has no calendar). A connection goes through whichever NorseStar hub
// adds the least flying.

// [lat, lon, UTC offset in hours, city]
export const AIRPORT_INFO = {
  MSP: [44.88, -93.22, -5, 'Minneapolis–St. Paul'], SEA: [47.45, -122.31, -7, 'Seattle'], ORD: [41.98, -87.90, -5, 'Chicago'],
  JFK: [40.64, -73.78, -4, 'New York'], BOS: [42.36, -71.01, -4, 'Boston'], DEN: [39.86, -104.67, -6, 'Denver'],
  SFO: [37.62, -122.38, -7, 'San Francisco'], LAX: [33.94, -118.41, -7, 'Los Angeles'], IAD: [38.95, -77.46, -4, 'Washington, D.C.'],
  ATL: [33.64, -84.43, -4, 'Atlanta'], AUS: [30.19, -97.67, -5, 'Austin'], PDX: [45.59, -122.60, -7, 'Portland'],
};
const HUBS = ['MSP', 'DEN', 'ORD', 'ATL'];

const rad = (d) => (d * Math.PI) / 180;
function miles(a, b) {
  const [la1, lo1] = AIRPORT_INFO[a], [la2, lo2] = AIRPORT_INFO[b];
  const h = Math.sin(rad(la2 - la1) / 2) ** 2 + Math.cos(rad(la1)) * Math.cos(rad(la2)) * Math.sin(rad(lo2 - lo1) / 2) ** 2;
  return 3959 * 2 * Math.asin(Math.sqrt(h));
}
const blockMin = (a, b) => Math.round((miles(a, b) / 8.1 + 38) / 5) * 5; // ~485 mph plus taxi, climb and descent
const clock = (min) => {
  const m = ((Math.round(min) % 1440) + 1440) % 1440, h = Math.floor(m / 60);
  return `${h % 12 || 12}:${String(m % 60).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
};
const dur = (min) => `${Math.floor(min / 60)}h ${String(min % 60).padStart(2, '0')}m`;
const hash = (s) => [...s].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7);

function leg(from, to, departLocalMin, number) {
  const block = blockMin(from, to);
  const arrive = departLocalMin + block + (AIRPORT_INFO[to][2] - AIRPORT_INFO[from][2]) * 60;
  return { flight: `NS ${number}`, from, to, departs: clock(departLocalMin), arrives: clock(arrive), duration: dur(block), block, arriveMin: arrive };
}

export function itineraryFor(c) {
  const from = AIRPORT_INFO[c.home] ? c.home : 'MSP';
  const to = AIRPORT_INFO[c.destination] && c.destination !== from ? c.destination : (from === 'SEA' ? 'MSP' : 'SEA');
  const h = hash(from + to);

  const nonstop = leg(from, to, 7 * 60 + 5 + (h % 5) * 10, 100 + (h % 800));
  const hub = HUBS.filter((x) => x !== from && x !== to).sort((a, b) => (miles(from, a) + miles(a, to)) - (miles(from, b) + miles(b, to)))[0];
  const layover = 55 + (h % 4) * 15;
  const first = leg(from, hub, 8 * 60 + 15 + (h % 4) * 15, 1000 + (h % 900));
  const second = leg(hub, to, first.arriveMin + layover, 2000 + (h % 900));
  const connecting = { via: hub, via_city: AIRPORT_INFO[hub][3], layover: dur(layover), legs: [first, second], departs: first.departs, arrives: second.arrives,
    total_time: dur(first.block + layover + second.block) };
  const strip = ({ block, arriveMin, ...rest }) => rest;
  connecting.legs = connecting.legs.map(strip);

  const booked = c.stops === 'Nonstop' ? 'nonstop' : 'connecting';
  return {
    route: `${from} (${AIRPORT_INFO[from][3]}) to ${to} (${AIRPORT_INFO[to][3]})`,
    currently_quoted: booked === 'nonstop' ? `nonstop ${nonstop.flight}, departs ${nonstop.departs}, arrives ${nonstop.arrives}`
      : `one stop via ${connecting.via_city}, departs ${connecting.departs}, arrives ${connecting.arrives} (${connecting.total_time})`,
    connecting_option: booked === 'connecting' ? connecting : undefined,
    nonstop_option: strip(nonstop),
    other_departures_today: [clock(12 * 60 + 40 + (h % 3) * 10), clock(17 * 60 + 25 + (h % 3) * 10)].map((t) => `nonstop at ${t}`),
    aircraft: miles(from, to) > 1400 ? 'Airbus A321neo' : 'Airbus A220-300',
    all_times_local: true,
  };
}
