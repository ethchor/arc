import "reflect-metadata";

// MED-C (supply-chain audit): the `dev-login` endpoint now requires explicit opt-in via
// `ARC_ENABLE_DEV_LOGIN=true` in addition to non-production NODE_ENV. The e2e suite
// drives the server via `dev-login` to mint test JWTs, so set the opt-in once here.
// Per-test code that wants to assert the OFF behavior can override this with
// `delete process.env.ARC_ENABLE_DEV_LOGIN` (or set it to anything other than "true").
process.env.ARC_ENABLE_DEV_LOGIN = "true";
