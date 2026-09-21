// One decision cycle: utterance -> JEV -> customer decision state -> engine -> agent context.
// Runs on the server (server.mjs) and, in the bring-your-own-key build, in the visitor's browser.
import { interpret } from './questions.mjs';
import { priorSignals, signalsFromJev, scoreOffers, buildAgentContext, statedParty } from '../shared/engine.mjs';
import { itineraryFor } from '../shared/flight.mjs';

export async function decide({ customer, messages, weights, jevOn, cycle, previousTop }) {
  const t0 = performance.now();
  let jev = null, party_update = null;
  let signals = priorSignals(customer);
  if (jevOn) {
    jev = await interpret(customer, messages);                 // 1. probabilistic interpretation
    signals = signalsFromJev(jev.answers);                     // 2. structured customer decision state
    // The customer said who is traveling. The record is updated to match, so prices, miles and
    // eligibility are worked out for the real party.
    const heard = statedParty(signals);
    if (heard && heard !== customer.party) { party_update = { from: customer.party, to: heard }; customer = { ...customer, party: heard }; }
  }
  const engine = scoreOffers(customer, signals, weights, { offered: previousTop });      // 3. deterministic business policy
  const context = buildAgentContext({ cycle, customer, signals, ranking: engine.ranking, blocked: engine.blocked, previousTop, jevOn, flight: itineraryFor(customer) }); // 4. what the LLM will be told
  // The browser runs the same engine module, so it rebuilds the full ranking itself from `signals`.
  // Only the head of the list crosses the wire; the full set is several hundred rows with their terms.
  return { jev, signals, party_update, engine: { ...engine, ranking: engine.ranking.slice(0, 12) }, context, decide_ms: performance.now() - t0 };
}
