// WorkspacePolicy (M2.2) — seção 4.1 do ROADMAP, função pura.
//
// - Toda Task que escreve código usa worktree isolada.
// - `shared` é só para Task read-only, e só se o harness tiver read-only
//   confiável (confirmado em spike) — senão a Task recebe worktree mesmo assim.
//   `shared` aponta para a worktree de integração, nunca para o repo principal.
// - Task corretiva de conflito roda na própria worktree de integração.

export type WorkspaceMode = "isolated" | "shared" | "integration";

export interface WorkspacePolicyInput {
  kind: "read" | "write";
  origin: string;
  /** O harness tem read-only confirmado empiricamente (spike)? */
  reliableReadOnly: boolean;
  /** `.apo/project.yaml`: workspace.defaultMode. */
  projectDefaultMode: "shared" | "isolated" | "auto";
}

export function decideWorkspace(input: WorkspacePolicyInput): WorkspaceMode {
  if (input.origin === "conflict") return "integration";
  if (input.kind === "write") return "isolated";
  if (input.projectDefaultMode === "isolated") return "isolated";
  return input.reliableReadOnly ? "shared" : "isolated";
}
