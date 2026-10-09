import { z } from "zod";

// ~/.apo/config.yaml — config global do daemon (seção 18 do PLAN.md).

export const RoutingConfigSchema = z.object({
  capacityAware: z.boolean().default(true),
  degradedAt: z.number().min(0).max(100).default(80),
  avoidAt: z.number().min(0).max(100).default(95),
  preferLowerUsageDifference: z.number().min(0).max(100).default(20),
});

export const LimitsConfigSchema = z.object({
  maxGlobalWorkers: z.number().int().positive().default(4),
  maxWorkersPerProvider: z.number().int().positive().default(2),
});

export const GlobalConfigSchema = z.object({
  socketPath: z.string().default("~/.apo/apo.sock"),
  routing: RoutingConfigSchema.default({}),
  limits: LimitsConfigSchema.default({}),
});

export type GlobalConfig = z.infer<typeof GlobalConfigSchema>;
