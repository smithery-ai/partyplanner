// Public API of @workflow/integrations-oauth.
//
// Two connection primitives, distinguished by where credentials live:
//
//   createConnection({ providerId, tokenSchema })
//     → Brokered. Provider spec + client_id/secret live on the Hylo backend.
//       Worker code never sees credentials. Used for Hylo-curated providers
//       (Spotify, Notion, ...). Integration packages ship pre-built atoms
//       built on this primitive.
//
//   createCustomConnection({ providerSpec, clientId, clientSecret, ... })
//     → Self-hosted. Worker holds the spec and the credentials. Used for
//       OAuth providers Hylo doesn't curate (your own GitHub app, internal
//       SSO, etc.). Pair with `createOAuthCallbackRoute` mounted on the
//       worker app.

// Brokered connection primitive.
export type { BrokerCredentials, CreateConnectionOptions } from "./atom";
export { createConnection, defaultAppBaseUrl, defaultBroker } from "./atom";
// Self-hosted connection primitive + the callback route it pairs with.
export type { CreateCustomConnectionOptions } from "./custom";
export { createCustomConnection } from "./custom";
// Worker-side handoff routes for the brokered flow.
export type { OAuthHandoffRoutesOptions } from "./handoff";
export { createOAuthHandoffRoutes } from "./handoff";
export type {
  OAuthCallbackRouteOptions,
  OAuthStatePayload,
} from "./legacy";
export {
  createOAuthCallbackRoute,
  signOAuthState,
  verifyOAuthState,
} from "./legacy";
// Provider spec — needed by integration packages (to register with the
// broker) and by `createCustomConnection` users.
export type {
  AuthorizeParamsContext,
  OAuthProviderSpec,
  TokenRequestContext,
} from "./provider";
export { defaultAuthorizeParams, defaultTokenRequest } from "./provider";
