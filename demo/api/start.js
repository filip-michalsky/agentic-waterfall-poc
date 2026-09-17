import { waitUntil } from '@vercel/functions';
import { read, write, archive } from '../lib/store.js';
import { createStartHandler } from '../lib/start.js';
import { runDemo } from '../lib/runner.js';

export default createStartHandler({ read, write, launch: (snapshot) => waitUntil(runDemo(snapshot, { read, write, archive })) });
