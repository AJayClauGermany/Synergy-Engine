import type { NetworkBehaviour } from './NetworkBehaviour';
import { SERVER_CLIENT_ID } from './protocol';

/**
 * Who runs an RPC. Unity: `SendTo` in `[Rpc(SendTo.X)]` (Netcode for GameObjects 2.x).
 *
 * The host is the server and also a client. "Clients" below include the host only where
 * noted. The caller runs the RPC itself, immediately, when it is part of the audience.
 */
export enum SendTo {
  /** The client that owns the object. */
  Owner = 'owner',
  /** Every client except the owner (and the server, if it is not a client of the object). */
  NotOwner = 'notOwner',
  /** The server (the host, when one player hosts). */
  Server = 'server',
  /** Everyone except the server. A host counts as the server, so it is skipped. */
  NotServer = 'notServer',
  /** Only the caller, locally. */
  Me = 'me',
  /** Everyone except the caller. */
  NotMe = 'notMe',
  /** The server and every client. */
  Everyone = 'everyone',
  /** Every connected client, and the host (as a client), but not a dedicated server. */
  ClientsAndHost = 'clientsAndHost',
  /** The clients named at the call: `this.someRpc.sendTo([2, 3], ...args)`. */
  SpecifiedInParams = 'specified',
}

/** The facts that decide whether one client is in an RPC's audience. */
export interface RpcAudience {
  /** Who made the call. */
  sender: number;
  /** Who owns the object the RPC belongs to. */
  owner: number;
  /** True when the server is also playing (a host), false for a dedicated server. */
  hostIsClient: boolean;
  /** Clients named by `sendTo(...)`. */
  targets?: readonly number[];
}

/** Whether `clientId` receives an RPC sent with `mode`. One rule, used by callers and by the server relaying for them. */
export function isRecipient(mode: SendTo, clientId: number, audience: RpcAudience): boolean {
  switch (mode) {
    case SendTo.Owner:
      return clientId === audience.owner;
    case SendTo.NotOwner:
      return clientId !== audience.owner;
    case SendTo.Server:
      return clientId === SERVER_CLIENT_ID;
    case SendTo.NotServer:
      return clientId !== SERVER_CLIENT_ID;
    case SendTo.Me:
      return clientId === audience.sender;
    case SendTo.NotMe:
      return clientId !== audience.sender;
    case SendTo.Everyone:
      return true;
    case SendTo.ClientsAndHost:
      return clientId !== SERVER_CLIENT_ID || audience.hostIsClient;
    case SendTo.SpecifiedInParams:
      return audience.targets?.includes(clientId) ?? false;
  }
}

export interface RpcOptions {
  /**
   * `SendTo.Server` only: refuse the call unless the caller owns the object.
   * `serverRpc` defaults to true (Unity's `[ServerRpc]`); `rpc(SendTo.Server, ...)` to false.
   */
  requireOwnership?: boolean;
}

/**
 * A callable RPC. Call it like a method; `sendTo` picks the clients when the RPC was
 * declared with `SendTo.SpecifiedInParams`, or overrides a `clientRpc`'s audience.
 */
export type RpcFunction<A extends unknown[]> = ((...args: A) => void) & {
  sendTo(clientIds: readonly number[], ...args: A): void;
};

const RPC = Symbol('synergy.rpc');

/** @internal What the network layer knows about one RPC. */
export interface RpcDefinition {
  /** The field name, filled in when the object spawns. */
  name: string;
  mode: SendTo;
  requireOwnership: boolean;
  /** A ClientRpc: only the server may call it. */
  serverOnly: boolean;
  handler: (...args: unknown[]) => void;
  behaviour: NetworkBehaviour;
}

/** @internal */
export function createRpc<A extends unknown[]>(
  behaviour: NetworkBehaviour,
  mode: SendTo,
  handler: (...args: A) => void,
  options: { requireOwnership: boolean; serverOnly: boolean },
): RpcFunction<A> {
  const definition: RpcDefinition = {
    name: '',
    mode,
    requireOwnership: options.requireOwnership,
    serverOnly: options.serverOnly,
    handler: handler as (...args: unknown[]) => void,
    behaviour,
  };
  const call = ((...args: A) => behaviour._invokeRpc(definition, args, undefined)) as RpcFunction<A>;
  call.sendTo = (clientIds, ...args) => behaviour._invokeRpc(definition, args, clientIds);
  Object.defineProperty(call, RPC, { value: definition });
  return call;
}

/** @internal The definition behind an RPC field, or null if the value is not one. */
export function rpcDefinitionOf(value: unknown): RpcDefinition | null {
  if (typeof value !== 'function') return null;
  return (value as { [RPC]?: RpcDefinition })[RPC] ?? null;
}
