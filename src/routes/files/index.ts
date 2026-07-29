/** /api/files router tree — one file per endpoint.
 * Exposes /api/{graph,context,file,read,doc/:id,logs}. */
import { Elysia } from 'elysia';
import { graphRoute } from './graph.ts';
import { contextRoute } from './context.ts';
import { fileRoute } from './file.ts';
import { readRoute } from './read.ts';
import { docRoute } from './doc.ts';
import { logsRoute } from './logs.ts';

export const filesRouter = new Elysia()
  .use(graphRoute)
  .use(contextRoute)
  .use(fileRoute)
  .use(readRoute)
  .use(docRoute)
  .use(logsRoute);
