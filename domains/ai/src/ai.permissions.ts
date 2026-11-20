import { defineRbacFeature } from '@platform/auth';

/** AI permissions, declared to the RBAC registry by AiApiModule (spec §6). */
export const AiPermission = {
  /** Own conversations: create, list, read, delete, and send messages to the model. */
  Chat: 'ai:chat',
} as const;
export type AiPermission = (typeof AiPermission)[keyof typeof AiPermission];
export const AI_RBAC = defineRbacFeature({
  name: 'ai',
  permissions: Object.values(AiPermission),
  // Members and above (admins and owners hold every member grant).
  grants: { member: [AiPermission.Chat] },
});
