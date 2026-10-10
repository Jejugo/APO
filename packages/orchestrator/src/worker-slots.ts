// Limites de concorrência do daemon inteiro (M2.4): `maxGlobalWorkers` e
// `maxWorkersPerProvider` (config.yaml). Compartilhado entre todas as
// Features — duas Features rodando juntas disputam os mesmos slots.

import type { ProviderId } from "@apo/domain";

interface Waiter {
  provider: ProviderId;
  resolve: (release: () => void) => void;
}

export class WorkerSlots {
  private active = 0;
  private readonly perProvider = new Map<ProviderId, number>();
  private readonly queue: Waiter[] = [];

  constructor(
    private readonly maxGlobal: number,
    private readonly maxPerProvider: number,
  ) {}

  /** Espera um slot livre; devolve a função que libera o slot. */
  acquire(provider: ProviderId): Promise<() => void> {
    return new Promise((resolve) => {
      this.queue.push({ provider, resolve });
      this.drain();
    });
  }

  private canRun(provider: ProviderId): boolean {
    return (
      this.active < this.maxGlobal && (this.perProvider.get(provider) ?? 0) < this.maxPerProvider
    );
  }

  private drain(): void {
    for (let index = 0; index < this.queue.length; ) {
      const waiter = this.queue[index];
      if (waiter && this.canRun(waiter.provider)) {
        this.queue.splice(index, 1);
        this.active += 1;
        this.perProvider.set(waiter.provider, (this.perProvider.get(waiter.provider) ?? 0) + 1);
        let released = false;
        waiter.resolve(() => {
          if (released) return;
          released = true;
          this.active -= 1;
          this.perProvider.set(waiter.provider, (this.perProvider.get(waiter.provider) ?? 1) - 1);
          this.drain();
        });
      } else {
        index += 1;
      }
    }
  }
}
