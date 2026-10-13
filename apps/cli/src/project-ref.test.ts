import { describe, expect, it } from "vitest";
import { resolveProjectRef } from "./project-ref.js";

const rows = [
  { id: "c8f36cfa-89e2-4851-ad7e-84d8413f9018", name: "attlas-whatsapp-engine", repoPath: "/p/a" },
  { id: "eddb5945-52b6-4a8f-87ae-baf436ea05e4", name: "apo-e2e-sample", repoPath: "/p/b" },
];
const list = async () => rows;

describe("resolveProjectRef", () => {
  it("UUID passa direto, sem consultar o daemon", async () => {
    const id = "c8f36cfa-89e2-4851-ad7e-84d8413f9018";
    await expect(
      resolveProjectRef(id, async () => {
        throw new Error("não deveria consultar");
      }),
    ).resolves.toBe(id);
  });

  it("resolve pelo nome, sem diferenciar maiúsculas", async () => {
    await expect(resolveProjectRef("Attlas-WhatsApp-Engine", list)).resolves.toBe(rows[0]?.id);
  });

  it("resolve por prefixo único do id (6+ caracteres)", async () => {
    await expect(resolveProjectRef("eddb59", list)).resolves.toBe(rows[1]?.id);
  });

  it("nome inexistente: erro que lista os Projects", async () => {
    await expect(resolveProjectRef("nada", list)).rejects.toThrow(
      /não encontrado[\s\S]*apo-e2e-sample/,
    );
  });

  it("nome repetido: erro pedindo o id, sem escolher um", async () => {
    const dup = async () => [
      { id: "11111111-1111-1111-1111-111111111111", name: "app", repoPath: "/x/app" },
      { id: "22222222-2222-2222-2222-222222222222", name: "app", repoPath: "/y/app" },
    ];
    await expect(resolveProjectRef("app", dup)).rejects.toThrow(/mais de um Project/);
  });
});
