import type { AssistantMessage, AssistantMessageEvent, AssistantMessageEventStream } from "@earendil-works/pi-ai";

/** `stream`, calling `onEvent` with each event as it is read and `onResult` with the reply its `result()` gives. */
export function tapStream(
  stream: AssistantMessageEventStream,
  onEvent: (event: AssistantMessageEvent) => void,
  onResult: (message: AssistantMessage) => void,
): AssistantMessageEventStream {
  const result = stream.result.bind(stream);
  const events = { [Symbol.asyncIterator]: stream[Symbol.asyncIterator].bind(stream) };
  stream[Symbol.asyncIterator] = async function* () {
    for await (const event of events) {
      onEvent(event);
      yield event;
    }
  };
  stream.result = async () => {
    const message = await result();
    onResult(message);
    return message;
  };
  return stream;
}
