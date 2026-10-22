// Advisory ids: "tcs_" + a 26-char ULID in Crockford base32 (48-bit ms time,
// then 80 random bits). Matches the schema pattern ^tcs_[0-9A-HJKMNP-TV-Z]{26}$.
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function newAdvisoryId(now: Date): string {
  let time = now.getTime();
  let timePart = "";
  for (let i = 0; i < 10; i++) {
    timePart = CROCKFORD[time % 32] + timePart;
    time = Math.floor(time / 32);
  }
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  let rand = 0n;
  for (const b of bytes) rand = (rand << 8n) | BigInt(b);
  let randPart = "";
  for (let i = 0; i < 16; i++) {
    randPart = CROCKFORD[Number(rand & 31n)] + randPart;
    rand >>= 5n;
  }
  return `tcs_${timePart}${randPart}`;
}
