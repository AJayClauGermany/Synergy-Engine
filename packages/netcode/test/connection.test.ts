import { afterEach, describe, expect, test } from 'bun:test';
import { Vector3 } from '@synergy/engine';
import { NetworkPrefab, SERVER_CLIENT_ID } from '../src';
import { PlayerPrefab, TestNetwork } from './harness';

let net: TestNetwork;
afterEach(() => net.dispose());

describe('connecting', () => {
  test('a host is server and client at once, with a player object of its own', () => {
    net = new TestNetwork();
    const host = net.host();
    const { manager } = host;
    expect([manager.isServer, manager.isClient, manager.isHost, manager.isListening]).toEqual([true, true, true, true]);
    expect(manager.localClientId).toBe(SERVER_CLIENT_ID);
    expect(manager.connectedClientsIds).toEqual([0]);
    const player = manager.spawnManager.getLocalPlayerObject();
    expect(player?.isLocalPlayer).toBe(true);
    expect(player?.isOwner && player.isOwnedByServer).toBe(true);
    expect(host.unit(1).seen).toEqual(['spawn hp=100 owner=0']);
  });

  test('a client connects, is given an id, and both sides get its player object', () => {
    net = new TestNetwork();
    const host = net.host();
    const alice = net.client('alice');
    const connected: string[] = [];
    host.manager.onClientConnectedCallback.add((id) => connected.push(`host saw ${id}`));
    alice.manager.onClientConnectedCallback.add((id) => connected.push(`alice is ${id}`));
    expect(alice.manager.isConnectedClient).toBe(false);
    net.pump();

    expect(alice.manager.isConnectedClient).toBe(true);
    expect([alice.manager.isServer, alice.manager.isClient, alice.manager.isHost]).toEqual([false, true, false]);
    expect(alice.manager.localClientId).toBe(1);
    expect(connected).toEqual(['host saw 1', 'alice is 1']);
    expect(host.manager.connectedClientsIds).toEqual([0, 1]);
    expect(alice.manager.connectedClientsIds).toEqual([1]);

    // Object 1 is the host's player, object 2 is alice's; both machines have both.
    for (const machine of [host, alice]) {
      expect(machine.player(0).networkObjectId).toBe(1);
      expect(machine.player(1).networkObjectId).toBe(2);
    }
    expect(alice.player(1).isLocalPlayer).toBe(true);
    expect(alice.player(0).isLocalPlayer).toBe(false);
    expect(host.player(1).isLocalPlayer).toBe(false);
    expect(host.player(1).ownerClientId).toBe(1);
    expect(alice.player(1).isOwner).toBe(true);
    expect(alice.manager.spawnManager.getLocalPlayerObject()).toBe(alice.object(2));
    expect(host.manager.connectedClients.get(1)?.playerObject).toBe(host.object(2));
  });

  test('the player prefab appears where the approval response says', () => {
    net = new TestNetwork();
    const host = net.host('host', {
      configure: (manager) => {
        manager.networkConfig.connectionApproval = true;
        manager.connectionApprovalCallback = (request, response) => {
          response.approved = true;
          response.position = new Vector3(request.clientNetworkId * 10, 0, 0);
        };
      },
    });
    const alice = net.client('alice');
    net.pump();
    expect(host.object(2).transform.position.x).toBe(10);
    expect(alice.object(2).transform.position.x).toBe(10);
  });

  test('approval can refuse a client, read what it sent, and wait for an answer', async () => {
    net = new TestNetwork();
    const seen: unknown[] = [];
    const host = net.host('host', {
      configure: (manager) => {
        manager.networkConfig.connectionApproval = true;
        manager.connectionApprovalCallback = async (request, response) => {
          seen.push(request.payload);
          await Promise.resolve();
          const payload = request.payload as { password: string };
          response.approved = payload.password === 'open sesame';
          response.reason = 'Wrong password.';
        };
      },
    });
    const intruder = net.create('intruder', { configure: (m) => (m.networkConfig.connectionData = { password: 'nope' }) });
    intruder.run(() => intruder.manager.startClient(intruder.transport, 'host'));
    const friend = net.create('friend', { configure: (m) => (m.networkConfig.connectionData = { password: 'open sesame' }) });
    friend.run(() => friend.manager.startClient(friend.transport, 'host'));
    const stopped: string[] = [];
    intruder.manager.onClientStopped.add(() => stopped.push('intruder stopped'));

    net.pump(2);
    await Promise.resolve();
    await Promise.resolve();
    net.pump();

    expect(seen).toEqual([{ password: 'nope' }, { password: 'open sesame' }]);
    expect(intruder.manager.isListening).toBe(false);
    expect(intruder.manager.disconnectReason).toBe('Wrong password.');
    expect(stopped).toEqual(['intruder stopped']);
    expect(friend.manager.isConnectedClient).toBe(true);
    expect(host.manager.connectedClientsIds).toEqual([0, 1]);
  });

  test('without a player prefab the server spawns players itself when a client connects', () => {
    net = new TestNetwork();
    const host = net.host('host', { configure: (m) => (m.networkConfig.playerPrefab = null) });
    host.manager.onClientConnectedCallback.add((id) => {
      if (id !== 0) host.make(PlayerPrefab).spawnAsPlayerObject(id);
    });
    const alice = net.client('alice', 'host', { configure: (m) => m.networkPrefabs.add(PlayerPrefab) });
    host.manager.networkPrefabs.add(PlayerPrefab);
    net.pump();
    expect(alice.player(1).isLocalPlayer).toBe(true);
  });

  test('a client with different prefabs registered is refused', () => {
    net = new TestNetwork();
    net.host();
    const odd = net.client('odd', 'host', { configure: (m) => m.networkPrefabs.add(new NetworkPrefab('Extra')) });
    net.pump();
    expect(odd.manager.isListening).toBe(false);
    expect(odd.manager.disconnectReason).toMatch(/configuration mismatch/i);
  });

  test('a full server refuses more clients than maxClients', () => {
    net = new TestNetwork();
    const host = net.host('host', { configure: (m) => (m.networkConfig.maxClients = 1) });
    const a = net.client('a');
    net.pump();
    const b = net.client('b');
    net.pump();
    expect(a.manager.isConnectedClient).toBe(true);
    expect(b.manager.isListening).toBe(false);
    expect(b.manager.disconnectReason).toBe('The server is full.');
    expect(host.manager.connectedClientsIds).toEqual([0, 1]);
  });

  test('a client gives up when nobody answers', () => {
    net = new TestNetwork();
    const lonely = net.client('lonely', 'nobody', { configure: (m) => (m.networkConfig.connectTimeout = 1) });
    const failures: string[] = [];
    lonely.manager.onTransportFailure.add((message) => failures.push(message));
    net.pump(40);
    expect(lonely.manager.isListening).toBe(false);
    expect(failures).toEqual(['The server did not answer in time.']);
  });

  test('a dedicated server is a server but not a client, and spawns no player of its own', () => {
    net = new TestNetwork();
    const server = net.server();
    const alice = net.client('alice', 'server');
    net.pump();
    expect([server.manager.isServer, server.manager.isClient, server.manager.isHost]).toEqual([true, false, false]);
    expect(server.manager.connectedClientsIds).toEqual([0, 1]);
    expect(server.manager.spawnManager.getPlayerNetworkObject(0)).toBeNull();
    expect(alice.player(1).isLocalPlayer).toBe(true);
  });

  test('the host can disconnect a client and tell it why', () => {
    net = new TestNetwork();
    const host = net.host();
    const alice = net.client('alice');
    net.pump();
    const left: number[] = [];
    host.manager.onClientDisconnectCallback.add((id) => left.push(id));
    const aliceLeft: number[] = [];
    alice.manager.onClientDisconnectCallback.add((id) => aliceLeft.push(id));

    host.run(() => host.manager.disconnectClient(1, 'Kicked for testing.'));
    net.pump();
    expect(left).toEqual([1]);
    expect(aliceLeft).toEqual([1]);
    expect(alice.manager.disconnectReason).toBe('Kicked for testing.');
    expect(alice.manager.isListening).toBe(false);
    expect(host.manager.connectedClientsIds).toEqual([0]);
    expect(host.has(2)).toBe(false);
  });

  test('when the host shuts down, clients learn the server went away and lose its objects', () => {
    net = new TestNetwork();
    const host = net.host();
    const alice = net.client('alice');
    net.pump();
    const events: string[] = [];
    host.manager.onServerStopped.add((wasHost) => events.push(`server stopped, host=${wasHost}`));
    host.manager.onClientStopped.add((wasHost) => events.push(`host client stopped, host=${wasHost}`));
    alice.manager.onClientDisconnectCallback.add((id) => events.push(`alice ${id} disconnected`));

    host.manager.shutdown();
    expect(host.manager.isListening).toBe(false);
    net.pump();
    host.step();
    expect(events).toEqual(['server stopped, host=true', 'host client stopped, host=true', 'alice 1 disconnected']);
    expect(alice.manager.disconnectReason).toBe('The server shut down.');
    expect(alice.manager.spawnManager.spawnedObjects.size).toBe(0);
    expect(host.manager.spawnManager.spawnedObjects.size).toBe(0);
  });

  test('a transport that drops is treated as a lost connection', () => {
    net = new TestNetwork();
    const host = net.host();
    const alice = net.client('alice');
    net.pump();
    host.transport.close();
    net.pump();
    expect(alice.manager.isListening).toBe(false);
    expect(alice.manager.disconnectReason).toBe('The connection to the server was lost.');
  });

  test('a running manager cannot be started twice', () => {
    net = new TestNetwork();
    const host = net.host();
    expect(() => host.manager.startHost(host.transport)).toThrow(/already running/);
    expect(() => host.manager.startServer(host.transport)).toThrow(/already running/);
  });
});
