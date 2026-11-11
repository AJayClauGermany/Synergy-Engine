import { cronJobs } from 'convex/server';
import { internal } from './_generated/api';

const crons = cronJobs();

crons.interval('close abandoned rooms', { minutes: 5 }, internal.rooms.closeStale, {});

export default crons;
