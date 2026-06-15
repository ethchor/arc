import { IsBoolean, IsInt, IsObject, IsOptional, IsString, MaxLength, Min, MinLength } from "class-validator";

/**
 * Workflow save / update payload. `definition` is the raw `WorkflowDefinition` JSON; the
 * service hands it to `@arc/workflows` `parseAndValidate` and refuses 422 on any error
 * level issue. We don't shape-validate the definition here; the validator gives much
 * better diagnostics + is the single source of truth for the vocabulary.
 */
export class UpsertWorkflowDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @IsObject()
  definition!: Record<string, unknown>;

  @IsBoolean()
  @IsOptional()
  enabled?: boolean;

  /**
   * Required on update (PUT); ignored on create (POST). Lets the server refuse to
   * overwrite a workflow that another admin saved while you were editing.
   */
  @IsInt()
  @Min(1)
  @IsOptional()
  expectedVersion?: number;
}

/**
 * Simulate a workflow against a synthetic context — lets the editor preview the
 * decision the executor would reach without actually triggering anything. Pure
 * read-only, no side effects.
 */
export class SimulateWorkflowDto {
  @IsString()
  mountPath!: string;

  @IsString()
  @IsOptional()
  capability?: string;

  @IsString()
  @IsOptional()
  requesterRole?: "owner" | "admin" | "editor" | "viewer";

  @IsOptional()
  requesterGroups?: string[];

  @IsInt()
  @IsOptional()
  mfaAgeSeconds?: number | null;
}
