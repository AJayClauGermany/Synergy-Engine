import type { NetworkManager } from './NetworkManager';
import { SERVER_CLIENT_ID } from './protocol';

export type NamedMessageHandler = (senderClientId: number, data: unknown) => void;

/**
 * Messages that belong to no object: chat, "ready" flags, a countdown. Unity:
 * `CustomMessagingManager`. Data must be plain JSON, in place of NGO's `FastBufferWriter`
 * (and the handler gets the data, in place of a `FastBufferReader`).
 *
 *   manager.customMessagingManager.registerNamedMessageHandler('chat', (sender, text) => show(sender, text));
 *   manager.customMessagingManager.sendNamedMessage('chat', NetworkManager.serverClientId, 'hello'); // client to server
 *   manager.customMessagingManager.sendNamedMessageToAll('chat', 'welcome');                         // server to everyone
 *
 * Clients talk to the server only; the server forwards if others should hear.
 */
export class CustomMessagingManager {
  private readonly handlers = new Map<string, NamedMessageHandler>();

  constructor(private readonly manager: NetworkManager) {}

  /**
   * Replaces any earlier handler for `name`, as NGO does. Returns a function that removes
   * this one (an addition; NGO has only `unregisterNamedMessageHandler`).
   */
  registerNamedMessageHandler(name: string, handler: NamedMessageHandler): () => void {
    this.handlers.set(name, handler);
    return () => {
      if (this.handlers.get(name) === handler) this.handlers.delete(name);
    };
  }

  unregisterNamedMessageHandler(name: string): void {
    this.handlers.delete(name);
  }

  /**
   * Sends to one machine, or to each of a list. Same order as NGO's
   * `SendNamedMessage(messageName, clientId, writer)`: the name, then the client id, then
   * the data. A client may send to the server only (`NetworkManager.serverClientId`, 0);
   * the server to any connected client, or to itself (its own handler runs at once).
   *
   * The arguments in another order are refused with an error that shows this one: the
   * client id must be a whole number of a connected client, and the data must be given.
   * NGO's `NetworkDelivery` parameter is not taken: every message is reliable and in order.
   */
  sendNamedMessage(name: string, clientId: number | readonly number[], ...data: [data: unknown]): void {
    const ids: readonly unknown[] = Array.isArray(clientId) ? clientId : [clientId];
    const order =
      `The arguments are (name, clientId, data), in NGO's order: ` +
      `sendNamedMessage('${name}', NetworkManager.serverClientId, data).`;
    for (const id of ids) {
      if (typeof id !== 'number' || !Number.isInteger(id) || id < 0) {
        throw new TypeError(`sendNamedMessage('${name}', ...): ${describe(id)} is not a client id. ${order}`);
      }
    }
    if ((data as readonly unknown[]).length === 0) {
      throw new TypeError(`sendNamedMessage('${name}', ${describe(clientId)}) was given no data. ${order}`);
    }
    const manager = this.manager;
    for (const id of ids as readonly number[]) {
      if (!manager.isServer && id !== SERVER_CLIENT_ID) {
        throw new Error(
          `sendNamedMessage('${name}', ${id}, ...): a client can only send messages to the server (client 0). ${order}`,
        );
      }
    }
    for (const id of ids as readonly number[]) {
      if (manager.isServer && !manager.connectedClientsIds.includes(id)) {
        // As NGO does: a client that has just left is not an error worth stopping a script
        // for. The message still names the order, in case the arguments were swapped.
        console.warn(
          `sendNamedMessage('${name}', ${id}, ...): client ${id} is not connected ` +
            `(connected: ${manager.connectedClientsIds.join(', ') || 'none'}), so nothing was sent. ${order}`,
        );
        continue;
      }
      manager._sendNamed(name, data[0], id);
    }
  }

  /** Server only: sends to every connected client (not to the host's own handler). */
  sendNamedMessageToAll(name: string, data: unknown): void {
    for (const id of this.manager.connectedClientsIds) {
      if (id !== SERVER_CLIENT_ID) this.manager._sendNamed(name, data, id);
    }
  }

  /** @internal */
  _deliver(name: string, sender: number, data: unknown): void {
    this.handlers.get(name)?.(sender, data);
  }
}

function describe(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
