// Netcode for GameObjects for Synergy Engine: replicated objects, variables and RPCs on a
// star where one player (or a server) hosts. Import everything from '@synergy/netcode'.
//
// Transports (loopback, PeerJS) and the Convex lobby come from '@synergy/net'; this package
// only needs something that implements its `Transport` interface.

export { NetworkManager, NetworkClient, SpawnManager } from './NetworkManager';
export type {
  NetworkConfig,
  NetworkTime,
  ConnectionApprovalRequest,
  ConnectionApprovalResponse,
} from './NetworkManager';
export { NetworkObject } from './NetworkObject';
export { NetworkBehaviour } from './NetworkBehaviour';
export { NetworkPrefab, NetworkPrefabs } from './NetworkPrefab';
export { NetworkTransform } from './NetworkTransform';
export {
  NetworkVariable,
  NetworkList,
  NetworkVariableBase,
  NetworkVariableReadPermission,
  NetworkVariableWritePermission,
  type NetworkVariableOptions,
  type NetworkListEvent,
} from './NetworkVariable';
export { SendTo, isRecipient, type RpcAudience, type RpcFunction, type RpcOptions } from './Rpc';
export { Serializers, type Serializer } from './Serializers';
export { CustomMessagingManager, type NamedMessageHandler } from './CustomMessaging';
export { SERVER_CLIENT_ID, PROTOCOL_VERSION } from './protocol';
