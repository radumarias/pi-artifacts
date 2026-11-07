import { useSyncExternalStore } from "react";
import type { AgentDefinition } from "../../shared/agents.ts";
import { errorMessage } from "../../shared/util.ts";
import { api } from "../api.ts";

/** The user's agents as the app last read them: null until the first read answers. */
interface AgentsState {
  agents: AgentDefinition[] | null;
  error: string | null;
}

/**
 * The user's agents, shared by the sidebar, the agent page and the draft cards in a chat: read once, and again when
 * the user's directory says they changed (the sidebar's socket) or a change here answers with one of them.
 */
const agentsStore = (() => {
  let state: AgentsState = { agents: null, error: null };
  let reading: Promise<void> | undefined;
  let again = false;
  const listeners = new Set<() => void>();
  const set = (next: AgentsState) => {
    state = next;
    for (const listener of listeners) listener();
  };
  // One read at a time; asked again meanwhile, it reads once more after, so the list is never older than the ask.
  const load = (): Promise<void> => {
    if (reading) {
      again = true;
      return reading;
    }
    reading = api.agents().then(
      (agents) => set({ agents, error: null }),
      (error: unknown) => set({ ...state, error: errorMessage(error) }),
    );
    return reading.finally(() => {
      reading = undefined;
      if (again) {
        again = false;
        void load();
      }
    });
  };
  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      if (state.agents === null && !reading) void load();
      return () => listeners.delete(listener);
    },
    get: () => state,
    load,
    /** One agent as a change answered with it: shown at once, before the list is read again. */
    put(agent: AgentDefinition) {
      const agents = state.agents ?? [];
      const others = agents.filter((known) => known.id !== agent.id);
      set({ ...state, agents: [...others, agent].sort((a, b) => a.name.localeCompare(b.name)) });
    },
    drop(id: string) {
      set({ ...state, agents: (state.agents ?? []).filter((known) => known.id !== id) });
    },
  };
})();

export const reloadAgents = agentsStore.load;
export const putAgent = agentsStore.put;
export const dropAgent = agentsStore.drop;

/** The user's agents, by name; null until they are read. */
export function useAgents(): AgentsState {
  return useSyncExternalStore(agentsStore.subscribe, agentsStore.get);
}
