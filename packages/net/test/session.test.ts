import { describe, expect, test } from 'bun:test';
import { type CommandEntry, CommandSession, LoopbackHub, startTicker } from '../src';

type Command = { type: 'move'; to: number } | { type: 'endTurn' } | { type: 'tick' };

function record(session: CommandSession<Command>): CommandEntry<Command>[] {
  const seen: CommandEntry<Command>[] = [];
  session.onCommand.add((entry) => seen.push(entry));
  return seen;
}

describe('CommandSession', () => {
  test('every player sees the same commands in the same order', () => {
    const hub = new LoopbackHub({ manual: true });
    const host = CommandSession.host<Command>(hub.connect('host'));
    const alice = CommandSession.join<Command>(hub.connect('alice'), 'host');
    const bob = CommandSession.join<Command>(hub.connect('bob'), 'host');
    const logs = [record(host), record(alice), record(bob)];
    hub.flush();
    expect(host.players).toEqual(['host', 'alice', 'bob']);
    expect(bob.players).toEqual(['host', 'alice', 'bob']);
    expect(alice.isHost).toBe(false);

    // Submitted "at the same time" from three machines.
    bob.submit({ type: 'move', to: 3 });
    host.submit({ type: 'endTurn' });
    alice.submit({ type: 'move', to: 7 });
    hub.flush();

    expect(logs[0]?.length).toBe(3);
    expect(logs[0]?.map((entry) => entry.seq)).toEqual([0, 1, 2]);
    expect(logs[1]).toEqual(logs[0] as CommandEntry<Command>[]);
    expect(logs[2]).toEqual(logs[0] as CommandEntry<Command>[]);
    expect(new Set(logs[0]?.map((entry) => entry.playerId))).toEqual(new Set(['host', 'alice', 'bob']));
  });

  test('a late joiner is caught up with everything that happened before', () => {
    const hub = new LoopbackHub({ manual: true });
    const host = CommandSession.host<Command>(hub.connect('host'));
    host.submit({ type: 'move', to: 1 });
    host.submit({ type: 'endTurn' });
    const late = CommandSession.join<Command>(hub.connect('late'), 'host');
    const seen = record(late);
    hub.flush();
    expect(seen.map((entry) => entry.command)).toEqual([{ type: 'move', to: 1 }, { type: 'endTurn' }]);
    host.submit({ type: 'move', to: 2 });
    hub.flush();
    expect(seen.length).toBe(3);
    expect(late.log).toEqual(host.log);
  });

  test('the host validates commands and tells the sender why one was refused', () => {
    const hub = new LoopbackHub({ manual: true });
    const host = CommandSession.host<Command>(hub.connect('host'), {
      validate: ({ playerId }, log) => {
        const turnOf = log.filter((entry) => entry.command.type === 'endTurn').length % 2 === 0 ? 'host' : 'guest';
        return playerId === turnOf ? undefined : 'Not your turn.';
      },
    });
    const guest = CommandSession.join<Command>(hub.connect('guest'), 'host');
    const rejected: string[] = [];
    guest.onRejected.add((_command, reason) => rejected.push(reason));
    hub.flush();

    guest.submit({ type: 'move', to: 5 });
    hub.flush();
    expect(rejected).toEqual(['Not your turn.']);
    expect(host.log.length).toBe(0);

    host.submit({ type: 'endTurn' });
    guest.submit({ type: 'move', to: 5 });
    hub.flush();
    expect(host.log.map((entry) => entry.playerId)).toEqual(['host', 'guest']);
  });

  test('players leaving, a full session and the host leaving', () => {
    const hub = new LoopbackHub({ manual: true });
    const host = CommandSession.host<Command>(hub.connect('host'), { maxPlayers: 2 });
    const guest = CommandSession.join<Command>(hub.connect('guest'), 'host');
    const extra = CommandSession.join<Command>(hub.connect('extra'), 'host');
    const closed: string[] = [];
    extra.onClosed.add((reason) => closed.push(`extra: ${reason}`));
    guest.onClosed.add((reason) => closed.push(`guest: ${reason}`));
    hub.flush();
    expect(host.players).toEqual(['host', 'guest']);
    expect(closed).toEqual(['extra: The session is full.']);

    // Messages from someone who is not in the session are ignored.
    hub.connect('stranger').send('host', { t: 'submit', command: { type: 'endTurn' } });
    hub.flush();
    expect(host.log.length).toBe(0);

    host.close();
    hub.flush();
    expect(closed).toContain('guest: The host left the session.');
    expect(() => guest.submit({ type: 'endTurn' })).toThrow(/closed/);
  });

  test('a listener that submits does not reorder what other listeners see', () => {
    const hub = new LoopbackHub({ manual: true });
    const host = CommandSession.host<Command>(hub.connect('host'));
    const guest = CommandSession.join<Command>(hub.connect('guest'), 'host');
    hub.flush();
    // An "AI" on the host replies to every endTurn from inside the listener.
    host.onCommand.add((entry) => {
      if (entry.command.type === 'endTurn') host.submit({ type: 'move', to: 9 });
    });
    const hostSeen = record(host);
    const guestSeen = record(guest);
    guest.submit({ type: 'endTurn' });
    hub.flush();
    expect(hostSeen.map((entry) => entry.seq)).toEqual([0, 1]);
    expect(hostSeen).toEqual(guestSeen);

    const solo = CommandSession.local<Command>();
    solo.onCommand.add((entry) => {
      if (entry.command.type === 'endTurn') solo.submit({ type: 'move', to: 1 });
    });
    const soloSeen = record(solo);
    solo.submit({ type: 'endTurn' });
    expect(soloSeen.map((entry) => entry.command.type)).toEqual(['endTurn', 'move']);
  });

  test('malformed submissions are ignored and a failing listener loses no messages', () => {
    const hub = new LoopbackHub({ manual: true });
    const host = CommandSession.host<Command>(hub.connect('host'));
    const guestTransport = hub.connect('guest');
    const guest = CommandSession.join<Command>(guestTransport, 'host');
    hub.flush();
    guestTransport.send('host', { t: 'submit' });
    hub.flush();
    expect(host.log.length).toBe(0);

    let fail = true;
    const seen = record(guest);
    guest.onCommand.add(() => {
      if (fail) {
        fail = false;
        throw new Error('listener bug');
      }
    });
    host.submit({ type: 'move', to: 1 });
    host.submit({ type: 'move', to: 2 });
    expect(() => hub.flush()).toThrow(/listener bug/);
    hub.flush();
    expect(seen.map((entry) => entry.seq)).toEqual([0, 1]);
  });

  test('a local session works with no network at all', async () => {
    const session = CommandSession.local<Command>();
    const seen = record(session);
    session.submit({ type: 'endTurn' });
    expect(seen).toEqual([{ seq: 0, playerId: 'local', command: { type: 'endTurn' } }]);
  });

  test('loopback delivers on a microtask by default and copies messages', async () => {
    const hub = new LoopbackHub();
    const a = hub.connect('a');
    const b = hub.connect('b');
    const received: unknown[] = [];
    b.onMessage.add((_from, message) => received.push(message));
    const payload = { nested: { value: 1 } };
    a.send('b', payload);
    payload.nested.value = 2;
    expect(received).toEqual([]);
    await Promise.resolve();
    expect(received).toEqual([{ nested: { value: 1 } }]);
    expect(a.peers).toEqual(['b']);
  });

  test('a ticker gives simultaneous play a shared clock that only the host drives', async () => {
    const hub = new LoopbackHub();
    const host = CommandSession.host<Command>(hub.connect('host'));
    const guest = CommandSession.join<Command>(hub.connect('guest'), 'host');
    // Each machine keeps its own state: how many ticks have passed, and when a move landed.
    const worlds = [host, guest].map((session) => {
      const world = { tick: 0, movedAtTick: -1 };
      session.onCommand.add(({ command }) => {
        if (command.type === 'tick') world.tick++;
        else if (command.type === 'move') world.movedAtTick = world.tick;
      });
      return world;
    });
    const stops = [startTicker(host, 5, { type: 'tick' }), startTicker(guest, 5, { type: 'tick' })];
    await new Promise((resolve) => setTimeout(resolve, 30));
    guest.submit({ type: 'move', to: 1 });
    await new Promise((resolve) => setTimeout(resolve, 30));
    for (const stop of stops) stop();
    await new Promise((resolve) => setTimeout(resolve, 15));

    expect(worlds[0]?.tick).toBeGreaterThanOrEqual(3);
    // The guest never sent ticks, yet both sides agree on the clock and on when the move happened.
    expect(host.log.filter((entry) => entry.command.type === 'tick').every((entry) => entry.playerId === 'host')).toBe(
      true,
    );
    expect(worlds[1]).toEqual(worlds[0] as (typeof worlds)[0]);
    expect(worlds[0]?.movedAtTick).toBeGreaterThan(0);

    const ticks = worlds[0]?.tick;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(worlds[0]?.tick).toBe(ticks as number);
  });
});
