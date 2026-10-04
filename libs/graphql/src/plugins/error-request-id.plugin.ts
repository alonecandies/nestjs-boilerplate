import type { ApolloServerPlugin, GraphQLRequestListener, GraphQLResponse } from '@apollo/server';
import { Plugin } from '@nestjs/apollo';
import { isEmpty } from 'lodash-es';
import type { GqlContext } from '../context/gql-context.js';

/**
 * Adds `extensions.requestId` to every error of an HTTP GraphQL response. It is the same id as the
 * `x-request-id` header and the log lines, so a support ticket can quote it. It lives in a plugin
 * because Apollo's `formatError` has no access to the request context.
 */
export function attachRequestId(response: GraphQLResponse, requestId: string | undefined): void {
  if (requestId === undefined || response.body.kind !== 'single') return;
  const { singleResult } = response.body;
  if (singleResult.errors === undefined || isEmpty(singleResult.errors)) return;
  response.body.singleResult = {
    ...singleResult,
    errors: singleResult.errors.map((error) => ({
      ...error,
      extensions: { ...error.extensions, requestId },
    })),
  };
}

@Plugin()
export class ErrorRequestIdPlugin implements ApolloServerPlugin<GqlContext> {
  async requestDidStart(): Promise<GraphQLRequestListener<GqlContext>> {
    return {
      async willSendResponse({ response, contextValue }) {
        const id = contextValue.req?.id;
        attachRequestId(response, id === undefined ? undefined : String(id));
      },
    };
  }
}
