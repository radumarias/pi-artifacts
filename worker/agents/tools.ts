import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, type Extension } from "@earendil-works/pi-durable";
import {
  AGENT_COLORS,
  AGENT_EFFORTS,
  AGENT_PROPOSE_TOOL,
  MAX_AGENT_INSTRUCTIONS,
  MAX_AGENT_JOB,
  type AgentProposedDetails,
  type AgentResult,
} from "../../shared/agents.ts";
import { text } from "../agent/output.ts";

/** What the agent tools need from the chat (part of ChatScope). */
export interface AgentsScope {
  /** Save an agent for the chat's owner, turned off until they turn it on. */
  proposeAgent(input: Record<string, unknown>): Promise<AgentResult>;
}

/**
 * agent_propose: the model drafts an agent from what the user described in the chat, as skill_propose drafts a skill.
 * It is saved off; the chat shows a draft card, and the owner reviews it and turns it on.
 */
export function agentsExtension(scope: AgentsScope): Extension {
  return defineExtension({
    name: "agent-proposals",
    tools: [
      defineTool({
        name: AGENT_PROPOSE_TOOL,
        description:
          'Draft a new agent for the user when they ask for one ("make me an agent that…", "every morning, check … and tell me"): a named helper with its own job, ' +
          "instructions, model and MCP servers, that people call in a chat with @name, and that can run on a schedule. It is saved turned off; the user reviews it and turns it on. " +
          "Ask only about gaps you cannot fill from the servers' tool lists; list in assumed the fields you guessed (such as servers, trigger, model), so they show as Assumed. " +
          "Write the instructions as numbered plain steps that work on their own, without this conversation's specifics unless they are the point.",
        parameters: Type.Object({
          name: Type.String({
            description: 'Its handle, called as @name: 2 to 24 lowercase letters, digits or hyphens, starting with a letter, e.g. "research".',
          }),
          job: Type.String({ description: `One line on what it is for. Up to ${MAX_AGENT_JOB} characters.` }),
          instructions: Type.String({ description: `Markdown: numbered steps, then the rules it follows. Up to ${MAX_AGENT_INSTRUCTIONS} characters.` }),
          model: Type.Optional(Type.String({ description: "A model id from the picker; leave it out for the chat's default." })),
          effort: Type.Optional(Type.Union(AGENT_EFFORTS.map((level) => Type.Literal(level)))),
          servers: Type.Optional(Type.Array(Type.String(), { description: "The MCP servers it may use, by name; leave it out for all of them." })),
          sharedServers: Type.Optional(Type.Array(Type.String(), { description: "Of those, the ones others in a shared chat can make it use, read-only." })),
          color: Type.Optional(Type.Union(AGENT_COLORS.map((color) => Type.Literal(color)))),
          trigger: Type.Optional(
            Type.Unsafe<Record<string, unknown>>({
              type: "object",
              description:
                'When it runs on its own: {kind: "schedule", at: "07:00", tz: "Europe/Bucharest", days?: ["mon", …]} or ' +
                '{kind: "watch", step: {kind: "look", server, tool, input}, everyMinutes: 60, when: "a condition"}. Leave it out for an agent that only answers when called.',
            }),
          ),
          autonomy: Type.Optional(
            Type.Union(
              [1, 2, 3, 4].map((level) => Type.Literal(level)),
              { description: "1 inform (default), 2 recommend, 3 approve, 4 run." },
            ),
          ),
          assumed: Type.Optional(Type.Array(Type.String(), { description: "The fields you guessed, by name." })),
        }),
        execute: async (args) => {
          const saved = await scope.proposeAgent(args as Record<string, unknown>);
          if ("error" in saved) throw new Error(`Not saved: ${saved.error}`);
          const details: AgentProposedDetails = {
            agentId: saved.id,
            name: saved.name,
            version: saved.version,
            ...(saved.assumed && { assumed: saved.assumed }),
          };
          return {
            output: text(
              `Drafted the agent @${saved.name}, turned off. The user reviews it, tests it and turns it on from its card or under Agents in the sidebar.`,
            ),
            details,
          };
        },
      }),
    ],
  });
}
