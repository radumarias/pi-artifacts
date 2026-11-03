import type { Discovery } from "../gateway-models.ts";

/** Where the last discovery of the gateway's models is kept: deployment-wide, and no secret (model names and prices). */
const KEY = "models/discovered.json";

/** The models AI Gateway's providers listed when last asked, shared by every isolate (worker/models.ts asks again when it is old). */
export class ModelCache {
  readonly #bucket: R2Bucket;

  constructor(bucket: R2Bucket) {
    this.#bucket = bucket;
  }

  /** The last discovery, or null when there is none or it cannot be read. */
  async read(): Promise<Discovery | null> {
    const object = await this.#bucket.get(KEY);
    if (!object) return null;
    try {
      const discovery = (await object.json()) as Discovery;
      return typeof discovery?.checkedAt === "number" && typeof discovery.providers === "object" ? discovery : null;
    } catch {
      return null;
    }
  }

  async write(discovery: Discovery): Promise<void> {
    await this.#bucket.put(KEY, JSON.stringify(discovery), { httpMetadata: { contentType: "application/json" } });
  }
}
