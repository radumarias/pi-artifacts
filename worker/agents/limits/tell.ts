// A run's report told through an outside tool (a tell step with `via: {server, tool}`, such as a mail server's send
// tool): the tool's input built from its own input schema, so the app needs to know no server. The recipients go in
// the field that names them, the report in the one for the text; anything else the tool requires cannot be guessed.

import type { StepInput } from "../../../shared/agents.ts";
import { schemaType } from "../../../shared/limits.ts";
import { isObject } from "../../../shared/util.ts";

const RECIPIENTS = /^(to|recipients?|emails?|address(es)?|channels?|users?|user_?ids?|members?|targets?|chat_?ids?|phones?|numbers?)$/i;
const TEXT = /^(text|body|message|content|markdown|html|description)$/i;
const SUBJECT = /^(subject|title|summary|headline)$/i;

/** What a tell step sends: to whom, the report, and a subject line for tools that take one. */
export interface Telling {
  to: readonly string[];
  text: string;
  subject: string;
}

const typeOf = (property: unknown) => (isObject(property) ? schemaType(property) : undefined);

/** The tool's input for a tell, from its input schema; or what is missing, when its fields cannot be told apart. */
export function toolInput(schema: unknown, telling: Telling): StepInput | { error: string } {
  const properties = isObject(schema) && isObject(schema.properties) ? schema.properties : {};
  const names = Object.keys(properties);
  const recipients = names.find((name) => RECIPIENTS.test(name));
  const text = names.find((name) => TEXT.test(name));
  if (!recipients || !text) {
    return { error: `cannot tell which of the tool's fields (${names.join(", ") || "none"}) take the recipients and the text` };
  }
  const subject = names.find((name) => SUBJECT.test(name) && name !== text);
  const input: StepInput = {
    [recipients]: typeOf(properties[recipients]) === "array" ? [...telling.to] : telling.to.join(", "),
    [text]: telling.text,
    ...(subject && { [subject]: telling.subject }),
  };
  const required =
    isObject(schema) && Array.isArray(schema.required) ? schema.required.filter((name): name is string => typeof name === "string") : [];
  const missing = required.filter((name) => !(name in input));
  if (missing.length) return { error: `the tool also needs ${missing.join(", ")}, which a tell step does not say` };
  return input;
}
