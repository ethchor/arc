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
import { AuthModule } from "../auth/auth.module";
import { BlobModule } from "../blob/blob.module";
import { DevicesAutoRevokeService } from "./devices-auto-revoke.service";
import { PasskeyService } from "./passkey.service";
import { PasskeyDiscoverController, VaultController } from "./vault.controller";
import { VaultService } from "./vault.service";

@Module({
  imports: [
    AuthModule,
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
  controllers: [VaultController, PasskeyDiscoverController],
  providers: [VaultService, PasskeyService, DevicesAutoRevokeService],
  exports: [DevicesAutoRevokeService, PasskeyService],
})
export class VaultModule {}
