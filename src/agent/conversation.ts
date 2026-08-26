export interface ConversationTurn {
  role: "user" | "assistant";
  text: string;
  /** Provider-visible context that must render without a User/Assistant label. */
  raw?: boolean;
}

export function buildConversationPrompt(turns: ConversationTurn[], latestMessage: string): string {
  const lines = turns.map((turn) => {
    const label = turn.role === "user" ? "User" : "Assistant";

    return turn.raw ? turn.text : `${label}: ${turn.text}`;
  });

  if (latestMessage && lines.at(-1) !== `User: ${latestMessage}`) {
    lines.push(`User: ${latestMessage}`);
  }

  return lines.reduce((rendered, line, index) => {
    if (!rendered) return line;
    const previous = turns[index - 1];
    return `${rendered}${previous?.raw ? "\n" : "\n\n"}${line}`;
  }, "");
}
