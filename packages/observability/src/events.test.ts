import { describe, expect, it, vi } from "vitest";
import { type EventSink, type StoredEvent, emitEvent } from "./events.js";
import type { Logger } from "./logger.js";

describe("emitEvent", () => {
  it("persiste o evento no sink e loga com o tipo no evento", async () => {
    const inserted: StoredEvent[] = [];
    const sink: EventSink = {
      insert: async (event) => {
        inserted.push(event);
      },
    };
    const info = vi.fn();
    const logger = { info } as unknown as Logger;

    await emitEvent(sink, logger, { type: "feature.created", featureId: "f1" });

    expect(inserted).toHaveLength(1);
    expect(inserted[0]?.type).toBe("feature.created");
    expect(inserted[0]?.createdAt).toBeInstanceOf(Date);
    expect(info).toHaveBeenCalledOnce();
  });
});
