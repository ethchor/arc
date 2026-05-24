import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import {
  VaultAuditLogEntity,
  VaultDeviceEntity,
  VaultEntity,
  VaultHeadEntity,
  VaultItemEntity,
  VaultKeyGrantEntity,
  VaultMembershipEntity,
  VaultUserKeysEntity,
} from "../database/entities";
import { VaultController } from "./vault.controller";
import { VaultService } from "./vault.service";

@Module({
  imports: [
    TypeOrmModule.forFeature([
      VaultUserKeysEntity,
      VaultEntity,
      VaultMembershipEntity,
      VaultKeyGrantEntity,
      VaultItemEntity,
      VaultDeviceEntity,
      VaultHeadEntity,
      VaultAuditLogEntity,
    ]),
  ],
  controllers: [VaultController],
  providers: [VaultService],
})
export class VaultModule {}
