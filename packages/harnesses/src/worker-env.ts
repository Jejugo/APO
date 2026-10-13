// `buildWorkerEnvironment()` (M3.0b, seção 6.3 do TECHNICAL_PLAN.md):
// allowlist, nunca denylist. Segredos do daemon (DATABASE_URL, JEV_API_KEY,
// GITHUB_TOKEN...) nunca chegam ao worker.
//
// NODE_ENV fica de FORA de propósito: é do daemon (production na VM), não do
// projeto que ele opera. Repassá-lo fazia os testes dos workers e dos gates
// rodarem em production e divergirem do CI (achado de 2026-10-13: o APO
// oscilava entre adicionar e remover vi.stubEnv). Cada ferramenta define o seu.
//
// Além de HOME/PATH/SHELL/TERM (lista original da seção 6.3), entram
// USER/LOGNAME/LANG/LC_ALL/TMPDIR: no macOS, os CLIs leem credenciais do
// keychain do usuário e escrevem em $TMPDIR — sem essas variáveis a auth OAuth
// do Claude Code e do Codex pode falhar.

const BASE_ALLOWLIST = [
  "HOME",
  "PATH",
  "SHELL",
  "TERM",
  "USER",
  "LOGNAME",
  "LANG",
  "LC_ALL",
  "TMPDIR",
] as const;

export function buildWorkerEnvironment(
  extraAllowed: readonly string[] = [],
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of [...BASE_ALLOWLIST, ...extraAllowed]) {
    const value = source[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }
  return env;
}
