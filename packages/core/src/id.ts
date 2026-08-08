/**
 * UUIDv7: time-ordered (SQLite index locality) yet non-semantic. See D6.
 *
 * @remarks
 * **The ordering has to hold inside a millisecond, not just across them.** The
 * first version filled everything after the timestamp with randomness, so two
 * ids minted in the same millisecond sorted arbitrarily — measured, and two
 * hundred ids generated in a loop came back shuffled.
 *
 * That is not academic. `workspace/src/database.ts` sorts a collection's rows
 * by id and calls the result creation order, and `importRows` creates them in a
 * tight loop: a CSV import produced rows in random order within each
 * millisecond, silently, because nothing checks an order it merely assumes.
 *
 * The fix is the one RFC 9562 §6.2 specifies for this: a **dedicated counter**
 * in the twelve bits after the version nibble. It increments while the clock
 * stays on the same millisecond and is re-seeded when the clock moves on.
 *
 * Seeded into the *lower* half of its range, so there is room to increment
 * before overflowing — a counter seeded near the top would run out after a few
 * ids and force the timestamp forward. On overflow the timestamp does borrow a
 * millisecond from the future, which keeps ordering monotonic at the cost of an
 * id that claims to be marginally newer than it is. Four thousand ids in one
 * millisecond is far past anything this editor does.
 *
 * @category Identity
 */

/** The millisecond the counter belongs to. */
let lastMillisecond = -1;
/** Twelve bits of `rand_a`, monotonic within `lastMillisecond`. */
let counter = 0;

const COUNTER_MAX = 0x0fff;

export function uuidv7(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);

  let ts = Date.now();
  if (ts === lastMillisecond) {
    counter += 1;
    if (counter > COUNTER_MAX) {
      // borrow from the next millisecond rather than break the ordering
      lastMillisecond += 1;
      ts = lastMillisecond;
      counter = 0;
    }
  } else {
    if (ts < lastMillisecond) ts = lastMillisecond; // a clock that went backwards
    lastMillisecond = ts;
    // the lower half, so a burst has room to count up without overflowing
    counter = ((bytes[6]! & 0x0f) << 8 | bytes[7]!) & 0x07ff;
  }

  bytes[0] = (ts / 2 ** 40) & 0xff;
  bytes[1] = (ts / 2 ** 32) & 0xff;
  bytes[2] = (ts / 2 ** 24) & 0xff;
  bytes[3] = (ts / 2 ** 16) & 0xff;
  bytes[4] = (ts / 2 ** 8) & 0xff;
  bytes[5] = ts & 0xff;
  // version 7 in the high nibble, the counter in the twelve bits below it
  bytes[6] = 0x70 | ((counter >> 8) & 0x0f);
  bytes[7] = counter & 0xff;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // variant
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
