import { ConvexError, v } from 'convex/values';
import type { Doc } from './_generated/dataModel';
import { internalMutation, mutation, type MutationCtx, query, type QueryCtx } from './_generated/server';
import { roomStatus } from './schema';

// SECURITY NOTE: player ids are chosen by the client and are not authenticated. That is
// fine for prototypes shared with people you trust. Before a public launch, add Convex
// Auth and derive the player from `ctx.auth.getUserIdentity()` instead of an argument.

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
/** Rooms with no heartbeat for this long are closed. */
const STALE_AFTER_MS = 2 * 60 * 1000;

const roomView = v.object({
  code: v.string(),
  name: v.string(),
  status: roomStatus,
  hostId: v.string(),
  peerCode: v.optional(v.string()),
  maxPlayers: v.number(),
  players: v.array(v.object({ id: v.string(), name: v.string() })),
});

function view(room: Doc<'rooms'>) {
  return {
    code: room.code,
    name: room.name,
    status: room.status,
    hostId: room.hostId,
    peerCode: room.peerCode,
    maxPlayers: room.maxPlayers,
    players: room.players.map(({ id, name }) => ({ id, name })),
  };
}

/** The newest room with this code that is still in use. */
export async function findRoom(ctx: QueryCtx | MutationCtx, code: string): Promise<Doc<'rooms'> | null> {
  const rooms = await ctx.db
    .query('rooms')
    .withIndex('by_code', (q) => q.eq('code', code.trim().toUpperCase()))
    .order('desc')
    .take(5);
  return rooms.find((room) => room.status !== 'closed') ?? null;
}

async function requireRoom(ctx: MutationCtx, code: string): Promise<Doc<'rooms'>> {
  const room = await findRoom(ctx, code);
  if (!room) throw new ConvexError(`No open room with code ${code}.`);
  return room;
}

/** Creates a room and returns it. The caller becomes its host and first player. */
export const create = mutation({
  args: {
    name: v.string(),
    playerId: v.string(),
    playerName: v.string(),
    peerCode: v.optional(v.string()),
    maxPlayers: v.optional(v.number()),
  },
  returns: roomView,
  handler: async (ctx, args) => {
    let code = '';
    for (let attempt = 0; attempt < 10; attempt++) {
      code = Array.from({ length: 6 }, () => CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]).join('');
      if (!(await findRoom(ctx, code))) break;
    }
    const now = Date.now();
    const id = await ctx.db.insert('rooms', {
      code,
      name: args.name.slice(0, 60),
      status: 'open',
      hostId: args.playerId,
      peerCode: args.peerCode,
      maxPlayers: Math.max(1, Math.min(args.maxPlayers ?? 8, 64)),
      players: [{ id: args.playerId, name: args.playerName.slice(0, 40), lastSeen: now }],
      nextSeq: 0,
      updatedAt: now,
    });
    return view((await ctx.db.get(id)) as Doc<'rooms'>);
  },
});

/** Adds the caller to a room (or refreshes them if they are already in it). */
export const join = mutation({
  args: { code: v.string(), playerId: v.string(), playerName: v.string() },
  returns: roomView,
  handler: async (ctx, args) => {
    const room = await requireRoom(ctx, args.code);
    const now = Date.now();
    const existing = room.players.some((player) => player.id === args.playerId);
    if (!existing && room.players.length >= room.maxPlayers) throw new ConvexError('This room is full.');
    const players = existing
      ? room.players.map((player) => (player.id === args.playerId ? { ...player, lastSeen: now } : player))
      : [...room.players, { id: args.playerId, name: args.playerName.slice(0, 40), lastSeen: now }];
    await ctx.db.patch(room._id, { players, updatedAt: now });
    return view({ ...room, players });
  },
});

/** Removes the caller. The room closes when its host leaves or nobody is left. */
export const leave = mutation({
  args: { code: v.string(), playerId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const room = await findRoom(ctx, args.code);
    if (!room) return null;
    const players = room.players.filter((player) => player.id !== args.playerId);
    const closing = players.length === 0 || args.playerId === room.hostId;
    await ctx.db.patch(room._id, {
      players,
      status: closing ? 'closed' : room.status,
      updatedAt: Date.now(),
    });
    return null;
  },
});

/** Call every 20-30 seconds while in a room so it is not treated as abandoned. */
export const heartbeat = mutation({
  args: { code: v.string(), playerId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const room = await findRoom(ctx, args.code);
    if (!room) return null;
    const now = Date.now();
    await ctx.db.patch(room._id, {
      players: room.players.map((player) => (player.id === args.playerId ? { ...player, lastSeen: now } : player)),
      updatedAt: now,
    });
    return null;
  },
});

/** Host only: mark the room as playing (hides it from the open list) or closed. */
export const setStatus = mutation({
  args: { code: v.string(), playerId: v.string(), status: roomStatus },
  returns: v.null(),
  handler: async (ctx, args) => {
    const room = await requireRoom(ctx, args.code);
    if (room.hostId !== args.playerId) throw new ConvexError('Only the host can change the room status.');
    await ctx.db.patch(room._id, { status: args.status, updatedAt: Date.now() });
    return null;
  },
});

export const get = query({
  args: { code: v.string() },
  returns: v.union(roomView, v.null()),
  handler: async (ctx, args) => {
    const room = await findRoom(ctx, args.code);
    return room ? view(room) : null;
  },
});

/** Rooms waiting for players, newest activity first. Subscribe to this for a live lobby. */
export const listOpen = query({
  args: {},
  returns: v.array(roomView),
  handler: async (ctx) => {
    const rooms = await ctx.db
      .query('rooms')
      .withIndex('by_status', (q) => q.eq('status', 'open'))
      .order('desc')
      .take(50);
    return rooms.map(view);
  },
});

/** Run by a cron job: closes rooms whose players stopped sending heartbeats. */
export const closeStale = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const cutoff = Date.now() - STALE_AFTER_MS;
    for (const status of ['open', 'playing'] as const) {
      const stale = await ctx.db
        .query('rooms')
        .withIndex('by_status', (q) => q.eq('status', status).lt('updatedAt', cutoff))
        .take(100);
      for (const room of stale) await ctx.db.patch(room._id, { status: 'closed' });
    }
    return null;
  },
});
