/**
 * Call accounting: how many graph and REST calls an operation spends.
 *
 * The Teamwork Graph throttles at roughly 128 calls per 20 seconds, so the cost of
 * one registry scan is a product fact, not a debugging detail — G0 measured 45
 * calls / 8.0 s for a 12-control registry (see g0-benchmark.md). Counting happens
 * at the two places every call leaves the app: runGraphQL and the REST helpers.
 */

export const counters = {
  graph: 0,
  rest: 0,
  graphRetries: 0,
  startedAt: Date.now(),
};

export function resetCounters(): void {
  counters.graph = 0;
  counters.rest = 0;
  counters.graphRetries = 0;
  counters.startedAt = Date.now();
}

export function noteGraphCall(): void {
  counters.graph += 1;
}

export function noteRestCall(): void {
  counters.rest += 1;
}
