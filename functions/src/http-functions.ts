import { onRequest } from 'firebase-functions/v2/https';
import { app } from './express-app';

// Create HTTP functions like parent project
const httpFunctionOptions = {
  api: {
    memory: '512MiB' as const,
    maxInstances: 10,
    invoker: 'private' as const,
    concurrency: 1000,
  },
};

// Export the HTTP function directly
export const api = onRequest(httpFunctionOptions.api, app);