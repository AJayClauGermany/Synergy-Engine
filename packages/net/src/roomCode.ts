// No 0/O or 1/I, so codes survive being read out loud.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** A short code players can share to find each other. */
export function makeRoomCode(length = 6): string {
  const random = crypto.getRandomValues(new Uint8Array(length));
  return [...random].map((value) => CODE_ALPHABET[value % CODE_ALPHABET.length]).join('');
}

/** A code as typed by a player: no surrounding spaces, upper case. */
export function normalizeRoomCode(code: string): string {
  return code.trim().toUpperCase();
}
