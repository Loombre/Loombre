// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/controller-ipc/src/index.ts — public package barrel.

export { CONTROLLER_IPC_CONTRACT_VERSION } from "./contract-version.js";

export type { IpcDiscoveryFile, IpcServerStartSemantics } from "./transport.js";
export {
  IPC_BASE_PATH,
  IPC_LOOPBACK_HOST,
  IPC_DISCOVERY_FILENAME,
  IPC_TOKEN_FILENAME,
  IPC_AUTH_HEADER,
  IPC_AUTH_SCHEME,
  IPC_DISCOVERY_FILE_SCHEMA,
  IPC_SERVER_START_SEMANTICS,
} from "./transport.js";

export type { ProcessState, ProcessInfo } from "./process-info.js";
export { PROCESS_STATES, PROCESS_INFO_SCHEMA } from "./process-info.js";

export type { IpcErrorCode, IpcErrorBody } from "./error-body.js";
export { IPC_ERROR_CODES, IPC_ERROR_BODY_SCHEMA } from "./error-body.js";

export type { VersionInfo, IpcStatusResponse } from "./status.js";
export { VERSION_INFO_SCHEMA, IPC_STATUS_RESPONSE_SCHEMA } from "./status.js";

export type {
  IpcServerLifecycleRequest,
  IpcServerActionResponse,
  IpcServerStartRequest,
  IpcServerStartResponse,
  IpcServerStopRequest,
  IpcServerStopResponse,
} from "./server-lifecycle.js";
export {
  IPC_SERVER_LIFECYCLE_REQUEST_SCHEMA,
  IPC_SERVER_ACTION_RESPONSE_SCHEMA,
  IPC_SERVER_START_REQUEST_SCHEMA,
  IPC_SERVER_START_RESPONSE_SCHEMA,
  IPC_SERVER_STOP_REQUEST_SCHEMA,
  IPC_SERVER_STOP_RESPONSE_SCHEMA,
} from "./server-lifecycle.js";

export type { OpenWebTargetRequest, OpenWebTargetResponse } from "./open-web-target.js";
export {
  OPEN_WEB_TARGET_REQUEST_SCHEMA,
  OPEN_WEB_TARGET_RESPONSE_SCHEMA,
} from "./open-web-target.js";

export type { CrashFilesRequest, CrashFileEntry, CrashFilesResponse } from "./crash-files.js";
export {
  CRASH_FILES_REQUEST_SCHEMA,
  CRASH_FILE_ENTRY_SCHEMA,
  CRASH_FILES_RESPONSE_SCHEMA,
} from "./crash-files.js";
