import { ForbiddenException, Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { JwtService } from "@nestjs/jwt";
import { Repository } from "typeorm";
import { UserEntity } from "../database/entities";

@Injectable()
export class AuthService {
  constructor(
    @InjectRepository(UserEntity) private readonly users: Repository<UserEntity>,
    private readonly jwt: JwtService,
  ) {}

  /**
   * Dev-only stand-in for OAuth (which authorizes *sync*, not vault unlock — docs/06 §6.1).
   * In production this is replaced by Google OAuth; the endpoint is disabled when
   * NODE_ENV=production.
   */
  async devLogin(email: string): Promise<{ accessToken: string; userId: number }> {
    if (process.env.NODE_ENV === "production") {
      throw new ForbiddenException("dev-login is disabled in production");
    }
    let user = await this.users.findOne({ where: { email } });
    if (!user) {
      user = await this.users.save(this.users.create({ email }));
    }
    const accessToken = await this.jwt.signAsync({ sub: user.id, email: user.email });
    return { accessToken, userId: user.id };
  }
}
