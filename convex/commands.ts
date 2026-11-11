import { ConvexError, v } from 'convex/values';
import { mutation, query } from './_generated/server';
import { findRoom } from './rooms';

const entry = v.object({ seq: v.number(), playerId: v.string(), command: v.any() });

/**
 * Appends a command to the room's log and returns its sequence number. Convex runs
 * mutations as serialisable transactions, so two players submitting at once still get
 * distinct, gap-free numbers: the database is the referee for ordering.
 *
 * To make the server enforce your game's rules too, validate `args.command` here
 * (rebuild the state from the log, or store a snapshot on the room) and throw a
 * `ConvexError` for illegal moves.
 */
export const submit = mutation({
  args: { code: v.string(), playerId: v.string(), command: v.any() },
  returns: v.number(),
  handler: async (ctx, args) => {
    const room = await findRoom(ctx, args.code);
    if (!room) throw new ConvexError(`No open room with code ${args.code}.`);
    if (!room.players.some((player) => player.id === args.playerId)) {
      throw new ConvexError('You are not a player in this room.');
    }
    const seq = room.nextSeq;
    await ctx.db.insert('commands', { roomId: room._id, seq, playerId: args.playerId, command: args.command });
    await ctx.db.patch(room._id, { nextSeq: seq + 1, updatedAt: Date.now() });
    return seq;
  },
});

/**
 * Commands with a sequence number greater than `after`, in order (at most 500 per call).
 * Subscribing to this is what keeps every player's game in step, and replaying it from
 * the start is how a player resumes a match later.
 */
export const list = query({
  args: { code: v.string(), after: v.optional(v.number()) },
  returns: v.array(entry),
  handler: async (ctx, args) => {
    const room = await findRoom(ctx, args.code);
    if (!room) return [];
    const rows = await ctx.db
      .query('commands')
      .withIndex('by_room_seq', (q) => q.eq('roomId', room._id).gt('seq', args.after ?? -1))
      .take(500);
    return rows.map(({ seq, playerId, command }) => ({ seq, playerId, command }));
  },
});
