/**
 * Contract test for the distance-default sentinel shared by the two vector
 * call sites (src/server/handlers.ts, src/server/vector-handlers.ts).
 *
 * Those two lines drifted apart: the hybrid path defaulted a missing distance
 * to 0 and the /api/similar path to 1. Under `1 / (1 + distance / 100)` every
 * score sat at ~0.99 and the difference was invisible; once distances map to
 * a real 0-1 spread, a default of 0 means a document with NO distance scores
 * a perfect 1.0 and outranks every measured hit.
 *
 * Both now use `?? 2` — unknown distance scores 0. `??` is load-bearing:
 * `|| 2` would also swallow a genuine distance of 0 (an exact duplicate),
 * turning the best possible match into the worst.
 */
import { describe, test, expect } from 'bun:test';
import { normalizeVectorDistance } from '../search-quality.ts';

const pick = (distances: Array<number | null | undefined> | undefined, i: number) =>
  normalizeVectorDistance(distances?.[i] ?? 2);

describe('distance default sentinel', () => {
  test('missing, short-array, and null distances score 0 — never a perfect 1.0', () => {
    expect(pick(undefined, 0)).toBe(0);
    expect(pick([0.5], 1)).toBe(0);
    expect(pick([null], 0)).toBe(0);
    expect(pick([undefined], 0)).toBe(0);
  });

  test('a genuine zero distance keeps its perfect score (the || regression)', () => {
    expect(pick([0], 0)).toBe(1);
  });

  test('a real distance is unaffected by the sentinel', () => {
    expect(pick([0.26], 0)).toBeCloseTo(0.87, 5);
  });
});
