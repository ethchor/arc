import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Put,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { CurrentUser, type CurrentUserData } from "../auth/current-user.decorator";
import { PasskeyService } from "./passkey.service";
import { VaultService } from "./vault.service";
import {
  AddMemberDto,
  ApproveDeviceDto,
  CreateFolderDto,
  CreateVaultDto,
  EnrollDto,
  PasskeyRegisterDto,
  PasskeyUnlockDto,
  PutHeadDto,
  RegisterDeviceDto,
  RotateKeyDto,
  UnlockDto,
  UpsertItemDto,
} from "./dto";
import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/types";

@UseGuards(JwtAuthGuard)
@Controller()
export class VaultController {
  constructor(
    private readonly vault: VaultService,
    private readonly passkey: PasskeyService,
  ) {}

  @Post("vault/enroll")
  enroll(@CurrentUser() u: CurrentUserData, @Body() dto: EnrollDto) {
    return this.vault.enroll(u.userId, dto);
  }

  @Get("vault/keyset")
  keyset(@CurrentUser() u: CurrentUserData) {
    return this.vault.getKeyset(u.userId);
  }

  @Post("vault/unlock")
  unlock(@CurrentUser() u: CurrentUserData, @Body() dto: UnlockDto) {
    return this.vault.unlock(u.userId, dto.authHash);
  }

  // --- Passkey unlock (docs/13) — additive to master-password ---

  @Post("vault/passkey/register-challenge")
  passkeyRegisterChallenge(@CurrentUser() u: CurrentUserData) {
    return this.passkey.beginRegistration(u.userId);
  }

  @Post("vault/passkey/register")
  passkeyRegister(@CurrentUser() u: CurrentUserData, @Body() dto: PasskeyRegisterDto) {
    return this.passkey.finishRegistration(
      u.userId,
      dto.registration as unknown as RegistrationResponseJSON,
      dto.encIdentityPrivPasskey,
      dto.encIdentityPrivMlkemPasskey,
      dto.encSigningPrivPasskey,
      dto.label,
    );
  }

  @Get("vault/passkeys")
  passkeys(@CurrentUser() u: CurrentUserData) {
    return this.passkey.list(u.userId);
  }

  @Delete("vault/passkeys/:id")
  passkeyRemove(@CurrentUser() u: CurrentUserData, @Param("id") id: string) {
    return this.passkey.remove(u.userId, id);
  }

  @Post("vault/passkey/unlock-challenge")
  passkeyUnlockChallenge(@CurrentUser() u: CurrentUserData) {
    return this.passkey.beginUnlock(u.userId);
  }

  @Post("vault/passkey/unlock")
  passkeyUnlock(@CurrentUser() u: CurrentUserData, @Body() dto: PasskeyUnlockDto) {
    return this.passkey.finishUnlock(
      u.userId,
      dto.assertion as unknown as AuthenticationResponseJSON,
    );
  }

  @Get("vaults")
  listVaults(@CurrentUser() u: CurrentUserData) {
    return this.vault.listVaults(u.userId);
  }

  @Post("vaults")
  createVault(@CurrentUser() u: CurrentUserData, @Body() dto: CreateVaultDto) {
    return this.vault.createVault(u.userId, dto);
  }

  @Get("vaults/:id/members")
  members(@CurrentUser() u: CurrentUserData, @Param("id") id: string) {
    return this.vault.listMembers(u.userId, id);
  }

  @Post("vaults/:id/members")
  addMember(@CurrentUser() u: CurrentUserData, @Param("id") id: string, @Body() dto: AddMemberDto) {
    return this.vault.addMember(u.userId, id, dto);
  }

  @Post("vaults/:id/rotate-key")
  rotateKey(@CurrentUser() u: CurrentUserData, @Param("id") id: string, @Body() dto: RotateKeyDto) {
    return this.vault.rotateKey(u.userId, id, dto);
  }

  @Get("vaults/:id/items")
  items(
    @CurrentUser() u: CurrentUserData,
    @Param("id") id: string,
    @Query("since") since?: string,
  ) {
    return this.vault.getItems(u.userId, id, Number(since ?? 0));
  }

  @Post("vaults/:id/items")
  upsert(@CurrentUser() u: CurrentUserData, @Param("id") id: string, @Body() dto: UpsertItemDto) {
    return this.vault.upsertItem(u.userId, id, dto);
  }

  @Delete("vaults/:id/items/:itemId")
  deleteItem(
    @CurrentUser() u: CurrentUserData,
    @Param("id") id: string,
    @Param("itemId") itemId: string,
  ) {
    return this.vault.deleteItem(u.userId, id, itemId);
  }

  @Get("vaults/:id/folders")
  folders(@CurrentUser() u: CurrentUserData, @Param("id") id: string) {
    return this.vault.listFolders(u.userId, id);
  }

  @Post("vaults/:id/folders")
  createFolder(@CurrentUser() u: CurrentUserData, @Param("id") id: string, @Body() dto: CreateFolderDto) {
    return this.vault.createFolder(u.userId, id, dto);
  }

  @Delete("vaults/:id/folders/:folderId")
  deleteFolder(
    @CurrentUser() u: CurrentUserData,
    @Param("id") id: string,
    @Param("folderId") folderId: string,
  ) {
    return this.vault.deleteFolder(u.userId, id, folderId);
  }

  @Get("vaults/:id/head")
  getHead(@CurrentUser() u: CurrentUserData, @Param("id") id: string) {
    return this.vault.getHead(u.userId, id);
  }

  @Put("vaults/:id/head")
  putHead(@CurrentUser() u: CurrentUserData, @Param("id") id: string, @Body() dto: PutHeadDto) {
    return this.vault.putHead(u.userId, id, dto);
  }

  @Get("vault/users/:id/identity-key")
  identityKey(@CurrentUser() _u: CurrentUserData, @Param("id", ParseIntPipe) id: number) {
    return this.vault.getUserIdentityKey(id);
  }

  @Get("vault/users/by-email/:email")
  identityKeyByEmail(@CurrentUser() _u: CurrentUserData, @Param("email") email: string) {
    return this.vault.getUserIdentityKeyByEmail(email);
  }

  @Post("vault/devices")
  registerDevice(@CurrentUser() u: CurrentUserData, @Body() dto: RegisterDeviceDto) {
    return this.vault.registerDevice(u.userId, dto);
  }

  @Get("vault/devices")
  pendingDevices(@CurrentUser() u: CurrentUserData) {
    return this.vault.listPendingDevices(u.userId);
  }

  @Get("vault/devices/me/keyset")
  deviceKeyset(@CurrentUser() u: CurrentUserData, @Query("deviceId") deviceId: string) {
    return this.vault.getDeviceKeyset(u.userId, deviceId);
  }

  @Post("vault/devices/:id/approve")
  approveDevice(
    @CurrentUser() u: CurrentUserData,
    @Param("id") id: string,
    @Body() dto: ApproveDeviceDto,
  ) {
    return this.vault.approveDevice(u.userId, id, dto);
  }

  @Delete("vault/devices/:id")
  revokeDevice(@CurrentUser() u: CurrentUserData, @Param("id") id: string) {
    return this.vault.revokeDevice(u.userId, id);
  }

  @Get("vaults/:id/audit")
  audit(
    @CurrentUser() u: CurrentUserData,
    @Param("id") id: string,
    @Query("limit") limit?: string,
    @Query("before") before?: string,
  ) {
    return this.vault.listAudit(u.userId, id, {
      ...(limit !== undefined ? { limit: Number(limit) } : {}),
      ...(before !== undefined ? { before } : {}),
    });
  }
}
