import {
  Body,
  Controller,
  HttpCode,
  Logger,
  NotFoundException,
  Param,
  Post,
  UnauthorizedException,
} from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { GrantsService } from "../grants/grants.service";
import { AuthMethodsService } from "./auth-methods.service";

/**
 * Login surface for auth-method plugins (OIDC, Kubernetes, …). `POST /v1/auth/<mount>/login`
 * resolves the mounted auth method, runs its `login()` against the presented credentials,
 * binds the resolved policies to the identity in the grants store, and mints an arc JWT the
 * caller then uses on `/v1/*` like any other token.
 *
 * Unauthenticated by design — this is how a caller *obtains* a token. The plugin's own
 * verification (JWKS signature / TokenReview) is the trust anchor; arc never grants more than
 * the role's policies, which come from operator config, never from the presented token.
 *
 * This controller lives in {@link AuthMethodsModule}, registered before `EnginesModule`, so its
 * route is matched ahead of the engines `/v1/*` catch-all.
 */
@Controller()
export class AuthMethodsController {
  private readonly logger = new Logger(AuthMethodsController.name);

  constructor(
    private readonly methods: AuthMethodsService,
    private readonly grants: GrantsService,
    private readonly jwt: JwtService,
  ) {}

  @Post("v1/auth/:mount/login")
  @HttpCode(200)
  async login(@Param("mount") mount: string, @Body() body: Record<string, unknown>) {
    const plugin = this.methods.resolve(mount);
    if (!plugin) {
      throw new NotFoundException({ errors: [`no auth method mounted at "auth/${mount}/"`] });
    }

    let result;
    try {
      result = await plugin.login({ mount: `auth/${mount}/`, credentials: body ?? {} });
    } catch (err) {
      // Any verification / binding failure is an auth failure, not a server error.
      throw new UnauthorizedException({ errors: [(err as Error).message] });
    }

    // Bind the role's policies to the resolved identity so the existing CapabilityGuard
    // authorizes the minted token. `attach` is idempotent; a policy name the operator hasn't
    // created yet is logged and skipped rather than failing the whole login.
    for (const policyName of result.policies) {
      try {
        await this.grants.attach(result.identityId, policyName);
      } catch (err) {
        this.logger.warn(
          `auth/${mount}: could not attach policy "${policyName}" to ${result.identityId}: ${(err as Error).message}`,
        );
      }
    }

    const token = await this.jwt.signAsync(
      { sub: result.identityId, email: result.alias ?? result.identityId, authMount: mount },
      { expiresIn: result.tokenTtlSeconds },
    );

    return {
      data: {
        token,
        identityId: result.identityId,
        policies: result.policies,
        tokenTtlSeconds: result.tokenTtlSeconds,
        metadata: result.metadata ?? {},
      },
    };
  }
}
