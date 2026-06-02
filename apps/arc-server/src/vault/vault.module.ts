import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import {
  UserEntity,
  VaultAuditLogEntity,
  VaultDeviceEntity,
  VaultEntity,
  VaultFolderEntity,
  VaultHeadEntity,
  VaultItemEntity,
  VaultKeyGrantEntity,
  VaultMembershipEntity,
  VaultUserKeysEntity,
  VaultUserPasskeyEntity,
} from "../database/entities";
import { PasskeyService } from "./passkey.service";
import { VaultController } from "./vault.controller";
import { VaultService } from "./vault.service";

@Module({
  imports: [
    TypeOrmModule.forFeature([
      UserEntity,
      VaultUserKeysEntity,
      VaultEntity,
      VaultMembershipEntity,
      VaultKeyGrantEntity,
      VaultItemEntity,
      VaultDeviceEntity,
      VaultHeadEntity,
      VaultAuditLogEntity,
      VaultFolderEntity,
      VaultUserPasskeyEntity,
    ]),
  ],
  controllers: [VaultController],
  providers: [VaultService, PasskeyService],
})
export class VaultModule {}
