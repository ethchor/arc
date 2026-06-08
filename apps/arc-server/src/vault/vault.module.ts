import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import {
  UserEntity,
  VaultAttachmentEntity,
  VaultAuditLogEntity,
  VaultDeviceEntity,
  VaultEntity,
  VaultFolderEntity,
  VaultHeadEntity,
  VaultItemEntity,
  VaultItemShareEntity,
  VaultKeyGrantEntity,
  VaultMembershipEntity,
  VaultUserKeysEntity,
  VaultUserPasskeyEntity,
} from "../database/entities";
import { BlobModule } from "../blob/blob.module";
import { DevicesAutoRevokeService } from "./devices-auto-revoke.service";
import { PasskeyService } from "./passkey.service";
import { VaultController } from "./vault.controller";
import { VaultService } from "./vault.service";

@Module({
  imports: [
    BlobModule,
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
      VaultAttachmentEntity,
      VaultItemShareEntity,
    ]),
  ],
  controllers: [VaultController],
  providers: [VaultService, PasskeyService, DevicesAutoRevokeService],
  exports: [DevicesAutoRevokeService, PasskeyService],
})
export class VaultModule {}
