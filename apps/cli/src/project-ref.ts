import { daemonRequest } from "./daemon-client.js";

/** Erro de uso (nome ausente ou ambíguo): a CLI mostra só a mensagem, sem stack. */
export class ProjectRefError extends Error {}

interface ProjectRow {
  id: string;
  name: string;
  repoPath: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const cache = new Map<string, string>();

/**
 * `--project` aceita o id (UUID) ou o nome do Project (o nome do repositório,
 * ex.: `attlas-whatsapp-engine`) e, na falta de nome exato, um prefixo único do id.
 * Nome repetido (dois repositórios com o mesmo nome) é erro: o usuário usa o id.
 */
export async function resolveProjectRef(
  ref: string,
  list: () => Promise<ProjectRow[]> = () => daemonRequest<ProjectRow[]>("/projects"),
): Promise<string> {
  if (UUID.test(ref)) return ref;
  const cached = cache.get(ref);
  if (cached) return cached;

  const projects = await list();
  const wanted = ref.toLowerCase();
  const byName = projects.filter((project) => project.name.toLowerCase() === wanted);
  const matches =
    byName.length > 0
      ? byName
      : wanted.length >= 6
        ? projects.filter((project) => project.id.toLowerCase().startsWith(wanted))
        : [];
  const [only] = matches;
  if (matches.length === 1 && only) {
    cache.set(ref, only.id);
    return only.id;
  }
  const describe = (rows: ProjectRow[]) =>
    rows.map((project) => `  ${project.id}  ${project.name}  ${project.repoPath}`).join("\n");
  throw new ProjectRefError(
    matches.length > 1
      ? `"${ref}" bate com mais de um Project; use o id:\n${describe(matches)}`
      : `Project "${ref}" não encontrado. Projects:\n${describe(projects)}`,
  );
}
