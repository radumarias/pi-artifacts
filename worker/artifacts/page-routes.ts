import { exports, waitUntil } from "cloudflare:workers";
import type { Api, Model, Models } from "@earendil-works/pi-ai";
import { createAI } from "agents/models/pi-ai";
import type { PageAiResponse, PageError, PageStorageResponse, PageValues } from "../../shared/protocol.ts";
import { GeminiCompat } from "../gemini.ts";
import { json, readJson } from "../http.ts";
import { catalogSource, loadCatalog, piModels } from "../models.ts";
import type { Storage } from "../storage/index.ts";
import { askPageModel, checkChanges, checkPageAiRequest, mergeValues } from "./page-features.ts";

/**
 * What a page keeps and asks beyond its MCP calls: POST /api/artifacts/:id/storage (pi.use("storage")) and
 * POST /api/artifacts/:id/ai (pi.use("ai")). Both run as the viewer, never as the page's author: the values are the
 * viewer's own (with the author's as their defaults), and the model's answers count against the viewer's allowance.
 */

/** The body of a refused page call: the runtime turns it into an Error with this code. */
export function pageFailed(error: PageError, status: number): Response {
  return json({ ok: false, error } satisfies PageStorageResponse & PageAiResponse, status);
}

/** Where a page lives: its owner, and the name of the chat object that published it. */
export interface PageHome {
  ownerUid: string;
  chat: string;
}

/**
 * The author's values for a page: everyone else's defaults, for those who may see what the page loads (a page may
 * have saved it); none for the others.
 */
async function authorValues(artifactId: string, home: PageHome, uid: string): Promise<Record<string, string | null>> {
  const [allowed, values] = await Promise.all([
    exports.ChatAgent.getByName(home.chat).mayReadPageDefaults(artifactId, uid),
    exports.UserDirectory.getByName(home.ownerUid).pageValues(artifactId),
  ]);
  return allowed ? values : {};
}

export async function pageStorageRoute(request: Request, env: Env, uid: string, artifactId: string, home: PageHome): Promise<Response> {
  const body = await readJson<{ op?: unknown; changes?: unknown }>(request);
  if (!body || !["load", "write", "reset"].includes(body.op as string)) return pageFailed({ code: "bad_request", message: "Expected {op: load, write or reset}." }, 400);
  const isAuthor = uid === home.ownerUid;
  const directory = exports.UserDirectory.getByName(uid);
  const values = async (own: Promise<Record<string, string | null>>): Promise<Response> => {
    const [mine, defaults] = await Promise.all([own, isAuthor ? {} : authorValues(artifactId, home, uid)]);
    return json({ ok: true, values: mergeValues(defaults, mine), isAuthor } satisfies PageStorageResponse & PageValues);
  };
  if (body.op === "load") return values(directory.pageValues(artifactId));

  // Writes come a short while after the page's last change, so this limit only stops a page that writes in a loop.
  const { success } = await env.PAGE_CALLS.limit({ key: `${uid}:storage` });
  if (!success) return pageFailed({ code: "rate_limited", message: "Too many writes from this page.", retryAfterMs: 30_000 }, 429);
  // After a reset the viewer has no values of their own: only the author's are left.
  if (body.op === "reset") return values(directory.resetPageValues(artifactId).then(() => ({})));
  const changes = checkChanges(body.changes);
  if (typeof changes === "string") return pageFailed({ code: "bad_request", message: changes }, 400);
  const written = await directory.writePageValues(artifactId, changes, isAuthor);
  return "error" in written ? pageFailed({ code: "too_large", message: written.error }, 413) : json({ ok: true } satisfies PageStorageResponse);
}

export async function pageAiRoute(request: Request, env: Env, storage: Storage, uid: string): Promise<Response> {
  const checked = checkPageAiRequest(await readJson(request));
  if (typeof checked === "string") return pageFailed({ code: "bad_request", message: checked }, 400);

  const directory = exports.UserDirectory.getByName(uid);
  const [{ success }, spent, [models, candidates]] = await Promise.all([env.PAGE_AI.limit({ key: uid }), directory.pageAiSpentToday(), pageModels(env, storage)]);
  if (!success) return pageFailed({ code: "rate_limited", message: "Too many requests to the model; wait a minute.", retryAfterMs: 60_000 }, 429);
  // Checked before the call and counted after it: calls at the same moment can each pass, so the allowance can be
  // passed by what a few calls cost (cents at most, with the rate limit above).
  if (spent >= (Number(env.PAGE_AI_DAILY_USD) || 0)) {
    return pageFailed({ code: "limit_reached", message: "You used today's allowance for asking pages' model; it renews at midnight UTC." }, 429);
  }

  const answer = await askPageModel(models, candidates, checked);
  const { usage } = answer;
  if (usage.input || usage.output) waitUntil(directory.recordPageAi({ input: usage.input, output: usage.output, cost: usage.cost.total }));
  if (!answer.ok) return pageFailed(answer.error, answer.error.code === "unavailable" ? 503 : 422);
  return json({ ok: true, text: answer.text, ...(answer.json !== undefined && { json: answer.json }) } satisfies PageAiResponse);
}

/** The models pages ask, made once per isolate, as a chat makes its own (piModels), and the ids PAGE_AI_MODEL names. */
let made: { models: Models; ids: string[] } | undefined;

/** The models PAGE_AI_MODEL names, in order, that this deployment can run, and what runs them. */
async function pageModels(env: Env, storage: Storage): Promise<[Models, Model<Api>[]]> {
  if (!made) {
    const gemini = new GeminiCompat();
    const ai = createAI({ binding: gemini.binding(env.AI), gateway: env.AI_GATEWAY_ID, byokAlias: env.AI_BYOK_ALIAS || undefined });
    made = { models: piModels(ai.provider, gemini), ids: env.PAGE_AI_MODEL.split(",").map((id) => id.trim()).filter(Boolean) };
  }
  const catalog = await loadCatalog(catalogSource(env, storage.models, waitUntil));
  return [made.models, made.ids.flatMap((id) => catalog.model(id) ?? [])];
}
