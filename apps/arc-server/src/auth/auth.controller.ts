import { Body, Controller, Post } from "@nestjs/common";
import { IsEmail } from "class-validator";
import { AuthService } from "./auth.service";

class DevLoginDto {
  @IsEmail()
  email!: string;
}

@Controller("auth")
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post("dev-login")
  devLogin(@Body() body: DevLoginDto) {
    return this.auth.devLogin(body.email);
  }
}
