/**
 * The name of a user's chat object. The uid must come from a verified identity: it is what keeps users apart. On its
 * own, so UserDirectory can name a chat without importing the chat object's module (which imports it).
 */
export function chatAgentName(uid: string, chatId: string): string {
  return `${uid}:${chatId}`;
}

/** The uid and chat id a chat object's name was built from (see chatAgentName). */
export function parseChatAgentName(name: string): { uid: string; chatId: string } {
  const [uid, chatId] = name.split(":");
  return { uid, chatId };
}
