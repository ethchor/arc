import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { AuthMethodsController } from "./auth-methods.controller";
import { AuthMethodsService } from "./auth-methods.service";

/**
 * Auth-method plugins (OIDC, Kubernetes, …) + their login surface. Independent of
 * `EnginesModule` on purpose: it imports only {@link AuthModule} (for the `JwtService` that
 * mints tokens; `GrantsService` is global). AppModule registers this **before**
 * `EnginesModule` so `POST /v1/auth/<mount>/login` is matched ahead of the engines `/v1/*`
 * catch-all.
 */
@Module({
  imports: [AuthModule],
  controllers: [AuthMethodsController],
  providers: [AuthMethodsService],
  exports: [AuthMethodsService],
})
export class AuthMethodsModule {}
