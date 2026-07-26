// SPDX-License-Identifier: AGPL-3.0-only
// Hand-authored, stable. Public entry point for @loombre/sdk.

export {
  LoombreClient,
  LoombreApiError,
  type LoombreClientOptions,
  type HttpMethod,
  type PathsWithMethod,
  type OperationFor,
  type RequestBodyFor,
  type SuccessResponseFor,
  type RequestOptions,
} from "./client.js";

export type { paths, components, operations, webhooks } from "./generated/types.js";
export { API_OPERATIONS, type ApiOperation, type ApiOperationId } from "./generated/paths.js";
