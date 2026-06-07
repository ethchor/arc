export type {
  PluginKind,
  PluginMeta,
  Capability,
  Scope,
  IssueRequest,
  IssuedSecret,
  LeaseInfo,
  SecretsPlugin,
  LoginRequest,
  AuthResult,
  AuthPlugin,
  StoragePlugin,
  Plugin,
} from "./types";
export { PluginHost, PluginError, scopeAllows } from "./host";
export { RemoteSecretsPlugin, RemotePluginError } from "./remote";
export type { RemoteProcessSpec } from "./remote";
