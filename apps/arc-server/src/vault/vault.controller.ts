import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { CurrentUser, type CurrentUserData } from "../auth/current-user.decorator";
import { DevicesAutoRevokeService } from "./devices-auto-revoke.service";
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
  TouchDeviceDto,
  UnlockDto,
  UpdateVaultUiDto,
  UploadAttachmentDto,
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
    private readonly autoRevoke: DevicesAutoRevokeService,
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

  /**
   * Patch the per-vault UI affordance (icon + colour). Admin-or-higher only because the
   * change is visible to every member of the vault. Body fields are individually optional:
   * omit one to leave it alone, send `null` to clear it.
   */
  @Patch("vaults/:id/ui")
  updateVaultUi(
    @CurrentUser() u: CurrentUserData,
    @Param("id") id: string,
    @Body() dto: UpdateVaultUiDto,
  ) {
    return this.vault.updateVaultUi(u.userId, id, dto);
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

  // ----- Encrypted attachments (large item payloads kept in BlobStore) -----

  @Post("vaults/:id/items/:itemId/attachments")
  uploadAttachment(
    @CurrentUser() u: CurrentUserData,
    @Param("id") id: string,
    @Param("itemId") itemId: string,
    @Body() dto: UploadAttachmentDto,
  ) {
    return this.vault.uploadAttachment(u.userId, id, itemId, dto);
  }

  @Get("vaults/:id/items/:itemId/attachments")
  listAttachments(
    @CurrentUser() u: CurrentUserData,
    @Param("id") id: string,
    @Param("itemId") itemId: string,
  ) {
    return this.vault.listAttachments(u.userId, id, itemId);
  }

  @Get("vaults/:id/items/:itemId/attachments/:attId")
  downloadAttachment(
    @CurrentUser() u: CurrentUserData,
    @Param("id") id: string,
    @Param("itemId") itemId: string,
    @Param("attId") attId: string,
  ) {
    return this.vault.downloadAttachment(u.userId, id, itemId, attId);
  }

  @Delete("vaults/:id/items/:itemId/attachments/:attId")
  deleteAttachment(
    @CurrentUser() u: CurrentUserData,
    @Param("id") id: string,
    @Param("itemId") itemId: string,
    @Param("attId") attId: string,
  ) {
    return this.vault.deleteAttachment(u.userId, id, itemId, attId);
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
  listDevices(
    @CurrentUser() u: CurrentUserData,
    @Query("approved") approved?: string,
    @Query("pending") pending?: string,
  ) {
    // Default is the historical behaviour: pending devices awaiting approval. The new
    // approved=true variant returns the user's already-enrolled devices with lastSeenAt +
    // trusted, used by the "my devices" UI and the auto-revoke admin tooling.
    const wantsApproved = approved === "true" || approved === "1";
    const wantsPending = pending === "true" || pending === "1" || pending === undefined;
    if (wantsApproved && !wantsPending) return this.vault.listApprovedDevices(u.userId);
    return this.vault.listPendingDevices(u.userId);
  }

  @Post("vault/devices/me/touch")
  touchDevice(@CurrentUser() u: CurrentUserData, @Body() dto: TouchDeviceDto) {
    return this.vault.touchDevice(u.userId, dto.deviceId);
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

  /**
   * Manual trigger for the auto-revoke scan. Useful in tests + as an operator escape
   * hatch ("apply the inactivity policy right now, don't wait for the timer"). Reuses the
   * JwtAuthGuard so any authenticated user can poke it for their own account — the scan
   * looks at every user's devices though, so in practice this is admin-only behaviour
   * that we'll gate behind a capability once `@arc/grants` covers /vault/*.
   *
   * Returns the IDs that were revoked + whether the feature is currently enabled.
   */
  @Post("vault/devices/auto-revoke/run")
  async runAutoRevoke(@CurrentUser() _u: CurrentUserData) {
    const enabled = this.autoRevoke.enabled;
    const { revokedIds } = await this.autoRevoke.runOnce();
    return { enabled, revokedIds };
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
