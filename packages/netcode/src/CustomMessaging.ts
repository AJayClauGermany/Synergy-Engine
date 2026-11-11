import type { NetworkManager } from './NetworkManager';
import { SERVER_CLIENT_ID } from './protocol';

export type NamedMessageHandler = (senderClientId: number, data: unknown) => void;

/**
 * Messages that belong to no object: chat, "ready" flags, a countdown. Unity:
 * `CustomMessagingManager`. Data must be plain JSON.
 *
 *   manager.customMessagingManager.registerNamedMessageHandler('chat', (sender, text) => show(sender, text));
 *   manager.customMessagingManager.sendNamedMessage('chat', 'hello');          // client to server
 *   manager.customMessagingManager.sendNamedMessageToAll('chat', 'welcome');   // server to everyone
 *
 * Clients talk to the server only; the server forwards if others should hear.
 */
export class CustomMessagingManager {
  private readonly handlers = new Map<string, NamedMessageHandler>();

  constructor(private readonly manager: NetworkManager) {}

  /** Replaces any earlier handler for `name`. Returns a function that removes this one. */
  registerNamedMessageHandler(name: string, handler: NamedMessageHandler): () => void {
    this.handlers.set(name, handler);
    return () => {
      if (this.handlers.get(name) === handler) this.handlers.delete(name);
    };
  }

  unregisterNamedMessageHandler(name: string): void {
    this.handlers.delete(name);
  }

  /** Sends to one machine. A client can only send to the server (the default). */
  sendNamedMessage(name: string, data: unknown, targetClientId: number = SERVER_CLIENT_ID): void {
    this.manager._sendNamed(name, data, targetClientId);
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
