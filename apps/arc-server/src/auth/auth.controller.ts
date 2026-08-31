import { Body, Controller, HttpCode, Post } from "@nestjs/common";
import { IsEmail, IsString, MaxLength, MinLength } from "class-validator";
import { AuthService } from "./auth.service";

class DevLoginDto {
  @IsEmail()
  email!: string;
}

class OidcLoginDto {
  /**
   * A compact-JWS OIDC **ID token** from an allowlisted provider. Bounded because an
   * unbounded string here would be parsed before any auth decision is made.
   */
  @IsString()
  @MinLength(16)
  @MaxLength(8192)
  idToken!: string;
}

@Controller("auth")
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post("dev-login")
  devLogin(@Body() body: DevLoginDto) {
    return this.auth.devLogin(body.email);
  }

  /**
   * Production account login (issue #144). Exchanges a verified OIDC ID token for an arc JWT.
   * `200`, not `201` — this authenticates, it does not create a resource from the caller's
   * point of view (an account may be created as a side effect on first login).
   */
  @Post("oidc/login")
  @HttpCode(200)
  oidcLogin(@Body() body: OidcLoginDto) {
    return this.auth.oidcLogin(body.idToken);
  }
}
