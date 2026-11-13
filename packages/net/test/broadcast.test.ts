import { afterEach, describe, expect, test } from 'bun:test';
import { BroadcastChannelTransport, CommandSession } from '../src';

// BroadcastChannel delivers to every other channel object with the same name, in this
// process too, so a host and its guests can live in one test like windows of one browser.

const open: BroadcastChannelTransport[] = [];
function track(transport: BroadcastChannelTransport): BroadcastChannelTransport {
  open.push(transport);
  return transport;
}

afterEach(() => {
  for (const transport of open.splice(0)) transport.close();
});

/** Waits until `check` holds, letting channel messages arrive meanwhile. */
async function until(check: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('BroadcastChannelTransport', () => {
  test('guests find the host by room code and exchange JSON in order', async () => {
    const host = track(await BroadcastChannelTransport.host({ prefix: 'test-a', roomCode: 'abc123' }));
    expect(host.roomCode).toBe('ABC123');
    expect(host.isHost).toBe(true);
    const joined: string[] = [];
    host.onPeerJoined.add((id) => joined.push(id));

    const guest = track(await BroadcastChannelTransport.join(' abc123 ', { prefix: 'test-a', id: 'player-2' }));
    expect(guest.hostId).toBe(host.localId);
    expect(guest.peers).toEqual([host.localId]);
    await until(() => joined.length === 1);
    expect(joined).toEqual(['player-2']);

    const received: unknown[] = [];
    host.onMessage.add((from, message) => received.push([from, message]));
    for (let i = 0; i < 20; i++) guest.send(host.localId, { n: i, at: new Date(0) });
    await until(() => received.length === 20);
    expect(received.map((entry) => (entry as [string, { n: number }])[1].n)).toEqual([...Array(20).keys()]);
    // It went through JSON, as over a real network: the Date arrived as text.
    expect((received[0] as [string, { at: unknown }])[1].at).toBe('1970-01-01T00:00:00.000Z');
  });

  test('a closed window is noticed by the others', async () => {
    const host = track(await BroadcastChannelTransport.host({ prefix: 'test-b' }));
    const guest = track(await BroadcastChannelTransport.join(host.roomCode, { prefix: 'test-b' }));
    await until(() => host.peers.length === 1);
    const left: string[] = [];
    host.onPeerLeft.add((id) => left.push(id));
    guest.close();
    await until(() => left.length === 1);
    expect(host.peers).toEqual([]);

    // The host leaving ends the room for its guests.
    const second = track(await BroadcastChannelTransport.join(host.roomCode, { prefix: 'test-b' }));
    const lost: string[] = [];
    second.onPeerLeft.add((id) => lost.push(id));
    host.close();
    await until(() => lost.length === 1);
    expect(second.peers).toEqual([]);
  });

  test('a room code is open in one window at a time, and joining nothing says why', async () => {
    track(await BroadcastChannelTransport.host({ prefix: 'test-c', roomCode: 'SAME' }));
    await expect(BroadcastChannelTransport.host({ prefix: 'test-c', roomCode: 'SAME' })).rejects.toThrow(
      /already open/,
    );
    await expect(BroadcastChannelTransport.join('NOPE', { prefix: 'test-c', timeoutMs: 300 })).rejects.toThrow(
      /host it in another window/,
    );
    // Prefixes keep games apart.
    await expect(BroadcastChannelTransport.join('SAME', { prefix: 'other-game', timeoutMs: 300 })).rejects.toThrow();
  });

  test('a guest that starts before its host waits for it', async () => {
    const joining = BroadcastChannelTransport.join('LATE', { prefix: 'test-d' });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const host = track(await BroadcastChannelTransport.host({ prefix: 'test-d', roomCode: 'LATE' }));
    const guest = track(await joining);
    expect(guest.peers).toEqual([host.localId]);
  });

  test('a command session runs over it unchanged', async () => {
    type Command = { type: 'move'; to: number };
    const hostTransport = track(await BroadcastChannelTransport.host({ prefix: 'test-e' }));
    const host = CommandSession.host<Command>(hostTransport);
    const guestTransport = track(await BroadcastChannelTransport.join(hostTransport.roomCode, { prefix: 'test-e' }));
    const guest = CommandSession.join<Command>(guestTransport, guestTransport.hostId);
    const seen: number[] = [];
    guest.onCommand.add((entry) => seen.push(entry.command.to));
    await until(() => guest.players.length === 2);
    guest.submit({ type: 'move', to: 3 });
    host.submit({ type: 'move', to: 5 });
    await until(() => seen.length === 2);
    expect(host.players).toEqual(guest.players);
  });
});
