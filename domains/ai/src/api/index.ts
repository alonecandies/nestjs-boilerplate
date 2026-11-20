/**
 * @domain/ai/api — the edge surface of the ai context. For now the record shapes and their value
 * lists (roles, statuses, outcomes); the API module, port and presentation join it with the chat
 * API. No persistence is reachable from here (scripts/check-api-subpaths.mjs).
 */
export * from '../domain/ai.types.js';
