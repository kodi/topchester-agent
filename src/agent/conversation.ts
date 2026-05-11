export interface ConversationTurn {
  role: "user" | "assistant";
  text: string;
}

export function buildConversationPrompt(turns: ConversationTurn[], latestMessage: string): string {
  const lines = turns.map((turn) => {
    const label = turn.role === "user" ? "User" : "Assistant";

    return `${label}: ${turn.text}`;
  });

  if (lines.at(-1) !== `User: ${latestMessage}`) {
    lines.push(`User: ${latestMessage}`);
  }

  return lines.join("\n\n");
}
