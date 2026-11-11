import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';

export const roomStatus = v.union(v.literal('open'), v.literal('playing'), v.literal('closed'));

export default defineSchema({
  /** A lobby entry: who is playing together, and how to reach the host. */
  rooms: defineTable({
    /** Short code players share to join. */
    code: v.string(),
    name: v.string(),
    status: roomStatus,
    /** Player id of the creator. */
    hostId: v.string(),
    /** The host's PeerJS room code, when the game uses WebRTC for gameplay. */
    peerCode: v.optional(v.string()),
    maxPlayers: v.number(),
    players: v.array(v.object({ id: v.string(), name: v.string(), lastSeen: v.number() })),
    /** Sequence number the next command will get. */
    nextSeq: v.number(),
    /** Updated by heartbeats; rooms that go quiet are closed by a cron job. */
    updatedAt: v.number(),
  })
    .index('by_code', ['code'])
    .index('by_status', ['status', 'updatedAt']),

  /** The ordered command log of a room: persistent, server-sequenced gameplay. */
  commands: defineTable({
    roomId: v.id('rooms'),
    seq: v.number(),
    playerId: v.string(),
    /** Game-defined payload. Validate its shape in your own rules code. */
    command: v.any(),
  }).index('by_room_seq', ['roomId', 'seq']),
});
