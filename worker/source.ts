import { DurableObject, exports } from "cloudflare:workers";
import type { Value } from "../shared/conditions.ts";
import type { LookStep } from "../shared/agents.ts";
import { isReadOnly } from "../shared/protocol.ts";
import { errorMessage } from "../shared/util.ts";
import { SourceCore, type Subscriber } from "./agents/runs/source.ts";
import { connectStreamableHttp } from "./mcp/connect.ts";
import { McpHub } from "./mcp/hub.ts";
import { mcpServers, watchableForAll } from "./mcp/servers.ts";
import { chatAgentName } from "./chat-name.ts";

/** The Source Durable Object (see SourceCore), named by sourceName. */
export class Source extends DurableObject<Env> {
  readonly hub = new McpHub(mcpServers(this.env), (server) => connectStreamableHttp(server));
  readonly core = new SourceCore(this.ctx.storage.sql, {
    read: async (step) => {
      const server = this.hub.server(step.server);
      // A Source reads only what every viewer shares: never with someone's own sign-in.
      if (!server || !watchableForAll(server)) throw new Error(`${step.server} cannot be watched for everyone.`);
      // A watch only reads, as a run's look step does: a tool that changes data is never polled.
      const info = await this.hub.tool(step.server, step.tool);
      if (!info) throw new Error(`${step.server} has no tool "${step.tool}".`);
      if (!isReadOnly(info)) throw new Error(`${step.server}.${step.tool} changes data: a watch only reads.`);
      return ((await this.hub.call(step.server, step.tool, step.input)).payload ?? null) as Value;
    },
    notify: (subscriber, value, source) =>
      exports.ChatAgent.getByName(chatAgentName(subscriber.uid, subscriber.chatId)).sourceMoved(subscriber.agentId, value as never, source),
    setAlarm: (at) => void this.ctx.storage.setAlarm(at),
    now: () => Date.now(),
  });

  subscribe(step: Pick<LookStep, "server" | "tool" | "input">, subscriber: Subscriber, everyMinutes: number): void {
    this.core.subscribe(step, subscriber, everyMinutes);
  }

  async unsubscribe(subscriber: Pick<Subscriber, "uid" | "agentId">): Promise<void> {
    if (!this.core.unsubscribe(subscriber)) await this.ctx.storage.deleteAlarm();
  }

  async alarm(): Promise<void> {
    try {
      await this.core.poll();
    } catch (error) {
      // The next poll is set already: a server that did not answer is asked again then.
      console.error("source poll:", errorMessage(error));
    }
  }
}
