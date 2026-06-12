import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { JwtModule } from "@nestjs/jwt";
import { PassportModule } from "@nestjs/passport";
import { UserEntity, VaultAgentEntity } from "../database/entities";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { JwtStrategy } from "./jwt.strategy";
import { getJwtSecret } from "./jwt.constants";

@Module({
  imports: [
    // HIGH-C (audit): JwtStrategy needs the agents repo so it can compare the JWT's
    // `agentTokenEpoch` claim against `vault_agents.tokenEpoch` on every agent-token
    // request; mismatched epoch = revoked since issuance.
    TypeOrmModule.forFeature([UserEntity, VaultAgentEntity]),
    PassportModule,
    JwtModule.register({ secret: getJwtSecret(), signOptions: { expiresIn: "1h" } }),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtStrategy],
  exports: [JwtModule, PassportModule],
})
export class AuthModule {}
