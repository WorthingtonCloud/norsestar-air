// The question set sent to Jev each decision cycle, and the state it judges.
// Primitive is chosen by the SHAPE of the judgment:
//   noul   - an independent yes/no fact about the customer
//   choice - one pick from an unordered set (returns the full distribution)
//   score  - a position on an ordered ladder of described situations
import { askJev } from './jev.mjs';
import { config } from './config.mjs';

const CURRENT = 'Judge the customer\'s CURRENT position across the whole conversation. A statement in `earlier_customer_messages` still holds unless a later message contradicts or softens it; where they conflict, `latest_customer_message` wins.';
const HOLDS = 'Judge the customer\'s CURRENT position: something said in `earlier_customer_messages` still holds unless a later message withdraws it.';
const FALLBACK = 'If the conversation gives no signal at all, judge from `customer_profile`.';

export const QUESTIONS = {
  // ---------- NOUL: independent propositions ----------
  business_travel: {
    label: 'Traveling for business', type: 'noul',
    instructions: 'Is the customer traveling for business or work on this trip?',
    criteria: { true: 'Mentions a meeting, client, conference, work trip or employer paying.', false: 'Leisure, family or personal trip, or nothing said about the purpose.' },
  },
  wants_miles: {
    label: 'Wants to use miles', type: 'noul', group: 'requests',
    instructions: 'Has the customer expressed interest in using their miles or loyalty benefits on this trip?',
    criteria: { true: 'Asks about paying or upgrading with miles, mentions their miles balance, or asks about status benefits.', false: 'No mention of miles, points, status or loyalty benefits.' },
  },
  needs_bags: {
    label: 'Baggage sensitive', type: 'noul',
    instructions: `Will the customer likely check a bag on this trip, or do they care about baggage fees? ${FALLBACK} Use \`checked_baggage_frequency\`.`,
    criteria: { true: 'Mentions luggage, suitcases, checked bags, bag fees or bulky gear such as golf clubs or skis, or the profile shows they usually or always check bags.', false: 'Says they travel light or carry-on only, or the profile shows they never or only sometimes check bags.' },
  },
  together_seating: {
    label: 'Needs seats together', type: 'noul',
    instructions: 'Is the customer traveling with someone and wanting to sit together?',
    criteria: { true: 'Mentions a spouse, partner, family or companion on this trip and wants adjacent seats, or a travel party larger than one where seating together clearly matters.', false: 'Traveling alone, or says seat location does not matter.' },
  },
  flexibility_need: {
    label: 'Values schedule flexibility', type: 'noul',
    instructions: 'Is the customer unsure about their plans for this trip, so that being able to change it later matters to them?',
    criteria: { true: 'Says plans or dates might change, the return is open-ended, or asks what happens if they need to move or change the flight.', false: 'Plans sound fixed, or nothing said about changing the trip. Wanting to cancel or refund a trip outright is not a need for flexibility.' },
  },
  wants_nonstop: {
    label: 'Asked for a nonstop', type: 'noul', group: 'requests',
    instructions: 'Has the customer asked for a direct or nonstop flight, or asked to avoid connections or layovers?',
    criteria: { true: 'Explicitly asks for a direct or nonstop flight, or says they do not want a connection, layover or stop.', false: 'No request about routing, or says connections are fine.' },
  },
  delay_complaint: {
    label: 'Complaining about past disruptions', type: 'noul',
    instructions: 'Has the customer complained in this conversation about past delays, cancellations or poor reliability with the airline?',
    criteria: { true: 'Explicitly voices frustration about earlier delayed or canceled flights with this airline.', false: 'No complaint voiced in the conversation, even if the profile shows past delays.' },
  },

  confirms_purchase: {
    label: 'Just said yes', type: 'noul',
    instructions: 'Does `latest_customer_message` accept the offer made in `last_agent_message`?',
    criteria: { true: 'Says yes, book it, go ahead, let us do it, sounds good, or otherwise agrees to buy what was just offered.', false: 'Still asking, comparing, objecting or changing the request, or `last_agent_message` made no offer.' },
  },
  special_assistance: {
    label: 'Needs special assistance', type: 'noul',
    instructions: 'Is the customer asking for special assistance for themselves or someone in their party?',
    criteria: { true: 'Asks for a wheelchair or mobility help, a medical or disability accommodation, or help for a child or elderly person traveling alone.', false: 'No assistance request. Wanting a nicer seat is not an assistance request.' },
  },
  traveling_with_pet: {
    label: 'Bringing a pet', type: 'noul',
    instructions: `Is the customer bringing a pet on this trip? ${HOLDS}`,
    criteria: { true: 'Says they are bringing a dog, cat or other pet, or asks whether a pet can come in the cabin.', false: 'No pet mentioned, or they have said the pet is not coming.' },
  },

  // ---------- NOUL: things asked for by name. Each can be withdrawn by a later message. ----------
  asked_legroom: {
    label: 'Asked for legroom', type: 'noul', group: 'requests',
    instructions: `Does the customer currently want more legroom? ${HOLDS}`,
    criteria: { true: 'Asks for extra legroom, more leg space or an exit row, or says they are tall or have knee or back trouble in a standard seat.', false: 'Never raised legroom, or has since said to drop it.' },
  },
  wants_seat_choice: {
    label: 'Asked for a specific seat', type: 'noul', group: 'requests',
    instructions: `Does the customer currently want a particular seat, or to choose their seats? ${HOLDS}`,
    criteria: { true: 'Asks for a window, an aisle, a seat near the front or a specific seat, asks to pick seats, or wants to sit next to a companion.', false: 'Has not raised where they sit, or says any seat is fine.' },
  },
  wants_lounge: {
    label: 'Asked for lounge access', type: 'noul', group: 'requests',
    instructions: `Does the customer currently want airport lounge access? ${HOLDS}`,
    criteria: { true: 'Asks about a lounge, or for somewhere comfortable to wait, relax, eat or work at the airport, including during a long layover.', false: 'Never raised it, or has since said to drop the lounge.' },
  },
  wants_wifi: {
    label: 'Asked for Wi-Fi', type: 'noul', group: 'requests',
    instructions: `Does the customer currently want internet access during the flight? ${HOLDS}`,
    criteria: { true: 'Asks about Wi-Fi or internet on board, or says they need to work online, send email or stream during the flight.', false: 'Never raised it, or has since said they do not need it.' },
  },
  declines_extras: {
    label: 'Refusing extras', type: 'noul', group: 'requests',
    instructions: `Has the customer said they do not want add-ons, extras or upgrades? ${HOLDS}`,
    criteria: { true: 'Says no extras, no add-ons, stop selling, just the ticket, or just the basic fare.', false: 'Has not refused extras, or has since asked for one.' },
  },

  // ---------- CHOICE: pick one from a set ----------
  primary_intent: {
    label: 'Primary current intent', type: 'choice',
    instructions: `What is the customer mainly trying to do right now? ${CURRENT}`,
    criteria: {
      book_flight: 'Book or plan a flight; general shopping for a trip.',
      upgrade: 'Get a better seat or cabin than standard.',
      reduce_cost: 'Pay less; find the cheapest way to travel.',
      use_loyalty_benefits: 'Use miles, points or status benefits.',
      change_itinerary: 'Change routing, timing or connections of the trip, including avoiding a connection.',
      service_complaint: 'Complain about a past bad experience with the airline.',
      cancel_or_refund: 'Cancel this trip, or get money back for a booked or past flight.',
      ask_information: 'Ask a factual question about the flight, the airline\'s services or its rules, such as schedule, Wi-Fi, food, pets, baggage rules or assistance, without asking to buy or change anything.',
      other: 'A greeting, small talk, or something unrelated to air travel.',
    },
  },
  trip_priority: {
    label: 'Primary trip priority', type: 'choice',
    instructions: `Which single thing matters most to the customer for this trip right now? ${CURRENT}`,
    criteria: {
      lowest_cost: 'Paying as little as possible.',
      comfort: 'A more comfortable seat, more space or a better cabin.',
      reliability: 'Arriving on time; avoiding delays and risky connections.',
      flexibility: 'Being able to change or cancel plans.',
      loyalty_optimization: 'Getting the most from miles or status.',
      unclear: 'Not enough information yet to tell.',
    },
  },

  requested_cabin: {
    label: 'Cabin asked for by name', type: 'choice',
    instructions: `Which cabin or fare does the customer currently want, by name or by an unmistakable description? ${CURRENT} When the customer says "that" or "it", they mean what \`last_agent_message\` offered.`,
    criteria: {
      basic_economy: 'Asks for Basic Economy, the most basic or bare-bones ticket, or the very cheapest fare available.',
      main_cabin: 'Asks for Main Cabin, regular economy or standard coach.',
      premium_economy: 'Asks for Premium Economy, or for a step up from economy that is below First or business class.',
      first_class: 'Asks for First Class, business class, or the best or top cabin.',
      none: 'Has not asked for a specific cabin or fare; has only described preferences, or asked about something else.',
    },
  },

  party_size_stated: {
    label: 'Travelers mentioned', type: 'choice',
    instructions: 'How many people, in total, has the customer said are traveling on this trip, counting the customer? Count lap infants too.',
    criteria: {
      one: 'Says they are traveling alone.',
      two: 'Mentions exactly one companion, such as a wife, husband, partner, friend or one child.',
      three: 'Mentions two companions, or says there are three of them.',
      four: 'Mentions three companions, or says there are four of them.',
      five_or_more: 'Mentions four or more companions, or a group of five or more.',
      not_stated: 'Has not said who, if anyone, is traveling with them.',
    },
  },

  // ---------- SCORE: ordered ladders ----------
  price_sensitivity: {
    label: 'Price sensitivity', type: 'score',
    instructions: `How much extra money is the customer willing to spend on this trip beyond the cheapest fare? ${CURRENT} ${FALLBACK} Use \`typical_cabin\` and \`average_ticket_spend_usd\`.`,
    criteria: [
      'Price is not a factor; would pay several hundred dollars more without hesitation.',
      'Will pay a moderate premium, around one hundred dollars, for something they value.',
      'Wants to keep cost down; would accept only a small extra charge.',
      'Wants the cheapest possible option and rejects any extra cost.',
    ],
  },
  comfort_preference: {
    label: 'Comfort preference', type: 'score',
    instructions: `How much does the customer care about seat comfort and space on this trip? ${CURRENT} ${FALLBACK} Use \`typical_cabin\`.`,
    criteria: [
      'Says seat and comfort do not matter at all.',
      'Standard seat is fine; no comfort wishes expressed.',
      'Would like a nicer seat or more room if reasonable.',
      'Comfort is a main requirement; wants a premium seat or cabin.',
    ],
  },
  disruption_concern: {
    label: 'Disruption concern', type: 'score',
    instructions: `How worried is the customer about delays, missed connections or arriving late on this trip? ${CURRENT}`,
    criteria: [
      'No concern about timing or delays expressed.',
      'Mild preference to arrive on time.',
      'Clearly worried about delays or connections.',
      'Arriving on time is critical; a delay would cause serious harm such as missing an important event.',
    ],
  },
  purchase_readiness: {
    label: 'Purchase readiness', type: 'score',
    instructions: `How close is the customer to committing to a purchase right now? ${CURRENT}`,
    criteria: [
      'Not shopping; venting, complaining or asking something unrelated.',
      'Exploring; asking open questions with no specific option in mind.',
      'Comparing specific options or asking about a specific price or upgrade.',
      'Ready to buy; has said what they want or asked to proceed.',
    ],
  },
  upgrade_propensity: {
    label: 'Upgrade propensity', type: 'score',
    instructions: `How likely is the customer to accept an offer of a better seat or cabin on this trip? ${CURRENT} ${FALLBACK} Use \`upgrades_purchased_last_12_months\`.`,
    criteria: [
      'Has refused upgrades or said they do not care where they sit.',
      'No interest shown in upgrades.',
      'Open to an upgrade if the price or miles cost is reasonable.',
      'Actively asking for an upgrade or a better cabin.',
    ],
  },
};

export const PRIMITIVES = ['noul', 'choice', 'score'];

// Only what helps the judgment goes in: Jev's accuracy falls as irrelevant state grows.
export function buildState(customer, messages) {
  const mine = messages.filter((m) => m.role === 'customer').map((m) => m.text);
  const agent = messages.filter((m) => m.role === 'agent').map((m) => m.text);
  return {
    latest_customer_message: mine[mine.length - 1] || '',
    earlier_customer_messages: mine.slice(0, -1).slice(-8),
    last_agent_message: agent[agent.length - 1] || '',
    customer_profile: {
      loyalty_tier: customer.tier,
      miles_balance: customer.miles,
      flights_last_12_months: customer.flights12,
      average_ticket_spend_usd: customer.avgSpend,
      typical_cabin: customer.cabin,
      checked_baggage_frequency: customer.bags,
      upgrades_purchased_last_12_months: customer.upgrades,
      delays_or_cancellations_last_6_months: customer.disruptions,
      travel_party_size: customer.party,
      current_itinerary: `${customer.home} to ${customer.destination}, ${customer.stops}`,
    },
  };
}

const wire = ({ type, instructions, criteria }) => ({ type, instructions, criteria });

// One decision cycle's worth of Jev calls, sent in parallel. per_primitive = one call per kind of
// question, so each one's latency is visible; single = one call with every question (cheapest).
// The yes/no questions are split in two so the trace reads as "the situation" and "the requests".
export const CALL_GROUPS = [
  { name: 'situation', primitive: 'noul', title: 'Yes / no — the situation', pick: (q) => q.type === 'noul' && q.group !== 'requests' },
  { name: 'requests', primitive: 'noul', title: 'Yes / no — what they asked for', pick: (q) => q.type === 'noul' && q.group === 'requests' },
  { name: 'choice', primitive: 'choice', title: 'Pick one', pick: (q) => q.type === 'choice' },
  { name: 'score', primitive: 'score', title: 'Rate it on a ladder', pick: (q) => q.type === 'score' },
];

export async function interpret(customer, messages) {
  const state = buildState(customer, messages);
  const groups = config.JEV_CALL_MODE === 'single'
    ? [{ name: 'all', primitive: 'all', title: 'All questions', ids: Object.keys(QUESTIONS) }]
    : CALL_GROUPS.map((g) => ({ ...g, ids: Object.keys(QUESTIONS).filter((id) => g.pick(QUESTIONS[id])) }));

  const t0 = performance.now();
  const calls = await Promise.all(groups.map(async ({ name, primitive, title, ids }) => {
    const r = await askJev(state, Object.fromEntries(ids.map((id) => [id, wire(QUESTIONS[id])])));
    return {
      name, primitive, title, latency_ms: r.latency_ms, cost: r.cost, cost_basis: r.cost_basis,
      model: r.model, provider: r.provider, usage: r.usage, attempts: r.attempts, raw: r.raw,
      questions: ids.map((id) => ({ id, ...QUESTIONS[id], answer: r.raw.answers?.[id] ?? null })),
    };
  }));
  const wall_ms = performance.now() - t0;

  const answers = Object.assign({}, ...calls.map((c) => c.raw.answers || {}));
  return {
    state, calls, answers, wall_ms,
    sum_call_ms: calls.reduce((a, c) => a + c.latency_ms, 0),
    cost: calls.every((c) => c.cost != null) ? calls.reduce((a, c) => a + c.cost, 0) : null,
    cost_basis: calls[0]?.cost_basis,
    call_mode: config.JEV_CALL_MODE,
  };
}
