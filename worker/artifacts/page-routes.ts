import { exports, waitUntil } from "cloudflare:workers";
import { createModels } from "@earendil-works/pi-ai/models";
import { createAI } from "agents/models/pi-ai";
import type { Api, Model } from "@earendil-works/pi-ai";
import { type PageAiResponse, type PageError, type PageStorageResponse, type PageValues } from "../../shared/protocol.ts";
import { json, readJson } from "../http.ts";
import { catalogSource, currentCatalog, listedProviders, loadCatalog, withCurrentPrices } from "../models.ts";
import type { Storage } from "../storage/index.ts";
import { askPageModel, checkChanges, checkPageAiRequest, mergeValues } from "./page-features.ts";

/**
 * What a page keeps and asks beyond its MCP calls: POST /api/artifacts/:id/storage (pi.use("storage")) and
 * POST /api/artifacts/:id/ai (pi.use("ai")). Both run as the viewer, never as the page's author: the values are the
 * viewer's own (with the author's as their defaults), and the model's answers count against the viewer's allowance.
 */

/** Whose artifact a page is: the owner's values are its defaults. */
export interface PageOwner {
  id: string;
  ownerUid: string;
}

const failed = (error: PageError, status: number) => json({ ok: false, error } satisfies PageStorageResponse, status);

async function pageValues(page: PageOwner, uid: string): Promise<PageValues> {
  const isAuthor = uid === page.ownerUid;
  const none: Record<string, string | null> = {};
  const [own, defaults] = await Promise.all([
    exports.UserDirectory.getByName(uid).pageValues(page.id),
    isAuthor ? none : exports.UserDirectory.getByName(page.ownerUid).pageValues(page.id),
  ]);
  return { values: mergeValues(defaults, own), isAuthor };
}

export async function pageStorageRoute(request: Request, env: Env, uid: string, page: PageOwner): Promise<Response> {
  const body = await readJson<{ op?: unknown; changes?: unknown }>(request);
  if (!body || !["load", "write", "reset"].includes(body.op as string)) return failed({ code: "bad_request", message: "Expected {op: load, write or reset}." }, 400);
  if (body.op === "load") return json({ ok: true, ...(await pageValues(page, uid)) } satisfies PageStorageResponse);

  // Writes come a short while after the page's last change, so this limit only stops a page that writes in a loop.
  const { success } = await env.PAGE_CALLS.limit({ key: `${uid}:storage` });
  if (!success) return failed({ code: "rate_limited", message: "Too many writes from this page.", retryAfterMs: 30_000 }, 429);
  const directory = exports.UserDirectory.getByName(uid);
  if (body.op === "reset") {
    await directory.resetPageValues(page.id);
    return json({ ok: true, ...(await pageValues(page, uid)) } satisfies PageStorageResponse);
  }
  const changes = checkChanges(body.changes);
  if (typeof changes === "string") return failed({ code: "bad_request", message: changes }, 400);
  const written = await directory.writePageValues(page.id, changes, uid === page.ownerUid);
  return "error" in written ? failed({ code: "too_large", message: written.error }, 413) : json({ ok: true } satisfies PageStorageResponse);
}

export async function pageAiRoute(request: Request, env: Env, storage: Storage, uid: string): Promise<Response> {
  const fail = (error: PageError, status: number) => json({ ok: false, error } satisfies PageAiResponse, status);
  const checked = checkPageAiRequest(await readJson(request));
  if (typeof checked === "string") return fail({ code: "bad_request", message: checked }, 400);

  const { success } = await env.PAGE_AI.limit({ key: uid });
  if (!success) return fail({ code: "rate_limited", message: "Too many requests to the model; wait a minute.", retryAfterMs: 60_000 }, 429);
  const directory = exports.UserDirectory.getByName(uid);
  const allowance = Number(env.PAGE_AI_DAILY_USD) || 0;
  if ((await directory.pageAiSpentToday()) >= allowance) {
    return fail({ code: "limit_reached", message: "You used today's allowance for asking pages' model; it renews at midnight UTC." }, 429);
  }

  const answer = await askPageModel(...(await pageModels(env, storage)), checked);
  if (answer.usage) waitUntil(directory.recordPageAi({ input: answer.usage.input, output: answer.usage.output, cost: answer.usage.cost.total }));
  if (!answer.ok) return fail(answer.error, answer.error.code === "unavailable" ? 503 : 422);
  return json({ ok: true, text: answer.text, ...(answer.json !== undefined && { json: answer.json }) } satisfies PageAiResponse);
}

/** The models PAGE_AI_MODEL names, in order, that this deployment can run, and what runs them. */
async function pageModels(env: Env, storage: Storage): Promise<[ReturnType<typeof createModels>, Model<Api>[]]> {
  const ai = createAI({ binding: env.AI, gateway: env.AI_GATEWAY_ID, byokAlias: env.AI_BYOK_ALIAS || undefined });
  const models = createModels();
  models.setProvider(withCurrentPrices(ai.provider));
  for (const listed of listedProviders(ai.provider, currentCatalog)) models.setProvider(listed);
  const catalog = await loadCatalog(catalogSource(env, storage.models, waitUntil));
  const ids = env.PAGE_AI_MODEL.split(",").map((id) => id.trim()).filter(Boolean);
  return [models, ids.flatMap((id) => catalog.model(id) ?? [])];
}
