import type { Principal } from '@platform/common';
import { z } from 'zod';
import { AI_TOOL_LIMITS } from '../../ai.constants.js';
import type { JsonValue } from '../../domain/ai.types.js';
import type { AiToolSources } from './ai-tool-sources.js';
import { clipText } from './tool-output.js';

/** The tools the model may call. Read-only, and only ever about the caller. */
export const AiToolName = {
  GetMyProfile: 'get_my_profile',
  ListMyNotifications: 'list_my_notifications',
  ListMyPayments: 'list_my_payments',
} as const;
export type AiToolName = (typeof AiToolName)[keyof typeof AiToolName];
export const AI_TOOL_NAMES: readonly AiToolName[] = Object.values(AiToolName);

/** Codes of the `{ error: { code, message } }` a tool returns to the model instead of throwing. */
export const AiToolErrorCode = {
  /** No principal in the context: the tool did not run. */
  PRINCIPAL_MISSING: 'PRINCIPAL_MISSING',
  /** The context's principal is not the caller the tools were built for. */
  TOOL_CALLER_MISMATCH: 'TOOL_CALLER_MISMATCH',
  /** The caller lacks the tool's permission (`AiTool.permission`). */
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  /** The port failed for a reason the model is not told (logged by name only). */
  TOOL_FAILED: 'TOOL_FAILED',
} as const;

/** The caller a tool reads for: the request's principal, always with an active tenant. */
export type AiToolCaller = Principal & { readonly tenantId: string };

/** What a tool runs with. The caller comes from the principal, never from the model's input. */
export interface AiToolContext {
  readonly sources: AiToolSources;
  readonly caller: AiToolCaller;
}

/** One tool, type-erased for the registry (`run` gets input the SDK validated with `inputSchema`). */
export interface AiTool {
  readonly description: string;
  /** Strict: no field beyond the listed ones (no tenant, user or other id ever). */
  readonly inputSchema: z.ZodType;
  /** A permission the caller must hold, as the matching REST route requires it. */
  readonly permission?: string;
  readonly run: (context: AiToolContext, input: unknown) => Promise<JsonValue>;
}

interface AiToolDefinition<INPUT> extends Omit<AiTool, 'inputSchema' | 'run'> {
  readonly inputSchema: z.ZodType<INPUT>;
  readonly run: (context: AiToolContext, input: INPUT) => Promise<JsonValue>;
}

const defineTool = <INPUT>(definition: AiToolDefinition<INPUT>): AiTool => ({
  ...definition,
  run: (context, input) => definition.run(context, input as INPUT),
});

const listInput = z.strictObject({
  limit: z
    .int()
    .min(1)
    .max(AI_TOOL_LIMITS.MAX_ITEMS)
    .optional()
    .describe(`How many, newest first (default ${AI_TOOL_LIMITS.DEFAULT_ITEMS}).`),
});

const text = (value: string): string => clipText(value, AI_TOOL_LIMITS.TEXT_MAX_CHARS);
const isoOf = (value: Date | undefined): string | null =>
  value instanceof Date ? value.toISOString() : null;

/**
 * The tool registry. Each tool reads through `AiToolSources` (the owners' ports) with the caller's
 * own tenant and user, and returns a JSON projection of the fields a user would see about
 * themselves (no Stripe, price or deep-link ids), free text clipped.
 */
export const AI_TOOLS: Readonly<Record<AiToolName, AiTool>> = {
  [AiToolName.GetMyProfile]: defineTool({
    description:
      "The signed-in user's own profile: id, email, display name, and roles in the active workspace.",
    inputSchema: z.strictObject({}),
    run: async ({ sources, caller }) => {
      const user = await sources.getUser(caller.userId);
      return {
        id: user.id,
        email: user.email,
        displayName: text(user.displayName),
        roles: [...caller.roles],
        memberSince: isoOf(user.createdAt),
      };
    },
  }),
  [AiToolName.ListMyNotifications]: defineTool({
    description: "The signed-in user's own notifications in the active workspace, newest first.",
    inputSchema: listInput,
    permission: 'notifications:read',
    run: async ({ sources, caller }, { limit }) => {
      const page = await sources.listNotifications({
        tenantId: caller.tenantId,
        userId: caller.userId,
        limit: limit ?? AI_TOOL_LIMITS.DEFAULT_ITEMS,
      });
      return {
        items: page.items.map((notification) => ({
          id: notification.id,
          type: notification.type,
          title: text(notification.title),
          body: text(notification.body),
          read: notification.read,
          createdAt: isoOf(notification.createdAt),
        })),
        hasMore: page.nextPageState !== undefined && page.nextPageState !== '',
      };
    },
  }),
  [AiToolName.ListMyPayments]: defineTool({
    description:
      "The signed-in user's own payments in the active workspace, newest first. amountTotal is " +
      'in minor currency units (e.g. cents).',
    inputSchema: listInput,
    run: async ({ sources, caller }, { limit }) => {
      const list = await sources.listPayments({
        tenantId: caller.tenantId,
        userId: caller.userId,
        limit: limit ?? AI_TOOL_LIMITS.DEFAULT_ITEMS,
      });
      return {
        items: list.items.map((payment) => ({
          id: payment.id,
          status: payment.status,
          amountTotal: payment.amountTotal,
          currency: payment.currency,
          quantity: payment.quantity,
          createdAt: isoOf(payment.createdAt),
        })),
        hasMore: list.nextCursor !== undefined && list.nextCursor !== '',
      };
    },
  }),
};
