import { useState, type ChangeEvent, type FormEvent } from "react";
import { MAX_SKILL_DESCRIPTION, MAX_SKILL_INSTRUCTIONS, splitTools, type SkillInfo } from "../../shared/skills.ts";
import { errorMessage } from "../../shared/util.ts";
import { api } from "../api.ts";

const ORIGIN_LABEL: Record<SkillInfo["origin"], string> = { builtin: "built-in", user: "yours", agent: "proposed in a chat" };

interface Draft {
  name: string;
  description: string;
  instructions: string;
  tools: string;
}

const EMPTY: Draft = { name: "", description: "", instructions: "", tools: "" };

/**
 * The user's skills: what the agent can pick for itself in every chat. Built-in
 * ones can be turned off; the user's own can be written, imported from a
 * SKILL.md, edited and deleted. A skill the agent proposed waits here, off,
 * until the user reviews it and turns it on.
 */
export function SkillsView({ skills, loadError, reload }: { skills: SkillInfo[] | null; loadError: string | null; reload: () => void }) {
  const [error, setError] = useState<string | null>(null);
  // The skill being edited: a draft, and the name it had (undefined for a new one).
  const [editing, setEditing] = useState<{ draft: Draft; existing?: string } | null>(null);
  const [importing, setImporting] = useState<string | null>(null);

  const run = async (action: () => Promise<unknown>) => {
    setError(null);
    try {
      await action();
      return true;
    } catch (e) {
      setError(errorMessage(e));
      return false;
    } finally {
      // Also after a refusal, which may come from a list that is out of date.
      reload();
    }
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!editing) return;
    const { draft, existing } = editing;
    // Saving under a name that is taken replaces that skill: only from its Edit button.
    if (existing === undefined && skills?.some((s) => s.name === draft.name.trim())) {
      setError(`You already have a skill named "${draft.name.trim()}"; edit that one or pick another name.`);
      return;
    }
    const enabled = skills?.find((s) => s.name === existing)?.enabled ?? true;
    const tools = splitTools(draft.tools);
    if (await run(() => api.saveSkill({ name: draft.name, description: draft.description, instructions: draft.instructions, tools, enabled }))) setEditing(null);
  };
  const edit = (field: keyof Draft) => (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setEditing((current) => current && { ...current, draft: { ...current.draft, [field]: e.target.value } });

  const importMarkdown = async (event: FormEvent) => {
    event.preventDefault();
    if (importing !== null && (await run(() => api.saveSkill({ markdown: importing })))) setImporting(null);
  };

  return (
    <div className="skills">
      <header className="skills-head">
        <div>
          <h2>Skills</h2>
          <p>
            A skill tells the agent how to handle one kind of request: when to use it, the steps and guardrails to follow, and the tools it works with. The agent sees
            each skill's description and picks the one that fits by itself. Skills apply in all your chats.
          </p>
        </div>
        <div className="skills-actions">
          <button type="button" className="primary" onClick={() => setEditing({ draft: EMPTY })}>
            New skill
          </button>
          <button type="button" onClick={() => setImporting("")}>
            Import SKILL.md
          </button>
        </div>
      </header>
      {error && <p className="form-error">{error}</p>}

      {importing !== null && (
        <form className="skill-form" onSubmit={importMarkdown}>
          <label>
            Paste a SKILL.md file, or pick one
            <textarea className="code" rows={10} value={importing} onChange={(e) => setImporting(e.target.value)} placeholder={"---\nname: weekly-report\ndescription: Use when …\n---\nSteps and guardrails…"} />
          </label>
          <input type="file" accept=".md,text/markdown,text/plain" onChange={async (e) => setImporting((await e.target.files?.[0]?.text()) ?? importing)} />
          <div className="skill-form-actions">
            <button type="submit" className="primary" disabled={!importing.trim()}>
              Import
            </button>
            <button type="button" onClick={() => setImporting(null)}>
              Cancel
            </button>
          </div>
        </form>
      )}

      {editing && (
        <form className="skill-form" onSubmit={save}>
          <label>
            Name
            <input
              value={editing.draft.name}
              disabled={editing.existing !== undefined}
              onChange={edit("name")}
              placeholder="weekly-report"
            />
          </label>
          <label>
            When to use it
            <textarea
              rows={2}
              maxLength={MAX_SKILL_DESCRIPTION}
              value={editing.draft.description}
              onChange={edit("description")}
              placeholder="Use when the user asks for …"
            />
          </label>
          <label>
            Instructions and guardrails
            <textarea
              className="code"
              rows={12}
              maxLength={MAX_SKILL_INSTRUCTIONS}
              value={editing.draft.instructions}
              onChange={edit("instructions")}
              placeholder={"1. …\n2. …\n\nGuardrails:\n- Never …"}
            />
          </label>
          <label>
            Tools it works with <small>(agent tool names, separated by spaces; optional)</small>
            <input value={editing.draft.tools} onChange={edit("tools")} placeholder="files_read run_python" />
          </label>
          <div className="skill-form-actions">
            <button type="submit" className="primary">
              Save
            </button>
            <button type="button" onClick={() => setEditing(null)}>
              Cancel
            </button>
          </div>
        </form>
      )}

      {skills === null ? (
        loadError ? (
          <p className="form-error">
            Could not load your skills: {loadError}{" "}
            <button type="button" onClick={reload}>
              Try again
            </button>
          </p>
        ) : (
          <p className="skills-note">Loading…</p>
        )
      ) : (
        <ul className="skill-list">
          {skills.map((skill) => (
            <li key={skill.name} className={skill.enabled ? "skill" : "skill off"}>
              <div className="skill-row">
                <label className="skill-toggle" title={skill.enabled ? "Turn off" : "Turn on"}>
                  <input type="checkbox" checked={skill.enabled} onChange={(e) => run(() => api.setSkillEnabled(skill.name, e.target.checked, skill.updatedAt || undefined))} />
                  <strong>{skill.name}</strong>
                </label>
                <span className={skill.origin === "agent" ? "pill review" : "pill"}>{ORIGIN_LABEL[skill.origin]}</span>
                <span className="skill-buttons">
                  {skill.origin !== "builtin" && (
                    <button
                      type="button"
                      onClick={() =>
                        setEditing({
                          existing: skill.name,
                          draft: { name: skill.name, description: skill.description, instructions: skill.instructions, tools: skill.tools.join(" ") },
                        })
                      }
                    >
                      Edit
                    </button>
                  )}
                  <a className="button" href={api.skillMarkdownUrl(skill.name)} download>
                    SKILL.md
                  </a>
                  {skill.origin !== "builtin" && (
                    <button type="button" onClick={() => confirm(`Delete the skill "${skill.name}"?`) && run(() => api.deleteSkill(skill.name))}>
                      Delete
                    </button>
                  )}
                </span>
              </div>
              <p>{skill.description}</p>
              {skill.origin === "agent" && !skill.enabled && <p className="skills-note">The agent proposed this skill. Read its instructions before turning it on.</p>}
              <details>
                <summary>Instructions{skill.tools.length ? ` · tools: ${skill.tools.join(", ")}` : ""}</summary>
                <pre>{skill.instructions}</pre>
              </details>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
