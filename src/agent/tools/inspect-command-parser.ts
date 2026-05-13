export interface InspectCommandPlan {
  command: string;
  entries: InspectCommandEntry[];
}

export interface InspectCommandEntry {
  operator: InspectCommandListOperator;
  pipeline: InspectCommandPipeline;
}

export type InspectCommandListOperator = "start" | "&&" | "||" | ";";

export interface InspectCommandPipeline {
  commands: InspectSimpleCommand[];
}

export interface InspectSimpleCommand {
  executable: string;
  args: string[];
}

type Token =
  | { type: "word"; value: string }
  | { type: "operator"; value: Exclude<InspectCommandListOperator, "start"> | "|" };

const REJECTED_SYNTAX: Array<[RegExp, string]> = [
  [/\r|\n/, "multiline commands are not allowed"],
  [/[<>]/, "redirects are not allowed"],
  [/\|&/, "stderr pipelines are not allowed"],
  [/\$\(|\$\{|\$/, "shell expansion is not allowed"],
  [/`/, "command substitution is not allowed"],
  [/[()]/, "subshells are not allowed"],
  [/[{}]/, "command groups are not allowed"],
  [/\*/, "globs are not allowed"],
  [/\?/, "globs are not allowed"],
  [/\[/, "globs are not allowed"],
  [/\]/, "globs are not allowed"],
];

export function parseInspectCommand(command: string): InspectCommandPlan {
  const trimmed = command.trim();

  if (!trimmed) {
    throw new Error("inspect_command requires a command.");
  }

  for (const [pattern, reason] of REJECTED_SYNTAX) {
    if (pattern.test(trimmed)) {
      throw new Error(`inspect_command rejected this command because ${reason}.`);
    }
  }

  const tokens = tokenize(trimmed);

  if (tokens.length === 0) {
    throw new Error("inspect_command requires a command.");
  }

  return {
    command: trimmed,
    entries: parseCommandList(tokens),
  };
}

function tokenize(command: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;

  while (index < command.length) {
    const char = command[index];

    if (/\s/.test(char)) {
      index += 1;
      continue;
    }

    if (command.startsWith("&&", index) || command.startsWith("||", index)) {
      tokens.push({ type: "operator", value: command.slice(index, index + 2) as "&&" | "||" });
      index += 2;
      continue;
    }

    if (char === "|" || char === ";") {
      tokens.push({ type: "operator", value: char });
      index += 1;
      continue;
    }

    if (char === "&") {
      throw new Error("inspect_command rejected this command because background jobs are not allowed.");
    }

    const word = readWord(command, index);
    tokens.push({ type: "word", value: word.value });
    index = word.nextIndex;
  }

  return tokens;
}

function readWord(command: string, startIndex: number): { value: string; nextIndex: number } {
  let index = startIndex;
  let value = "";

  while (index < command.length) {
    const char = command[index];

    if (/\s/.test(char) || char === "|" || char === ";" || char === "&") {
      break;
    }

    if (char === "'") {
      const quoted = readQuotedWord(command, index + 1, "'");
      value += quoted.value;
      index = quoted.nextIndex;
      continue;
    }

    if (char === '"') {
      const quoted = readQuotedWord(command, index + 1, '"');
      value += quoted.value;
      index = quoted.nextIndex;
      continue;
    }

    value += char;
    index += 1;
  }

  if (!value) {
    throw new Error("inspect_command rejected this command because empty words are not allowed.");
  }

  return { value, nextIndex: index };
}

function readQuotedWord(command: string, startIndex: number, quote: "'" | '"'): { value: string; nextIndex: number } {
  let index = startIndex;
  let value = "";

  while (index < command.length) {
    const char = command[index];

    if (char === quote) {
      return { value, nextIndex: index + 1 };
    }

    value += char;
    index += 1;
  }

  throw new Error("inspect_command rejected this command because quoted strings must be closed.");
}

function parseCommandList(tokens: Token[]): InspectCommandEntry[] {
  const entries: InspectCommandEntry[] = [];
  let index = 0;
  let operator: InspectCommandListOperator = "start";

  while (index < tokens.length) {
    if (tokens[index]?.type === "operator") {
      throw new Error("inspect_command rejected this command because operators must appear between commands.");
    }

    const parsed = parsePipeline(tokens, index);
    entries.push({ operator, pipeline: parsed.pipeline });
    index = parsed.nextIndex;

    if (index >= tokens.length) {
      break;
    }

    const token = tokens[index];

    if (token?.type !== "operator" || token.value === "|") {
      throw new Error("inspect_command rejected this command because pipelines must contain commands on both sides.");
    }

    operator = token.value;
    index += 1;

    if (index >= tokens.length) {
      throw new Error("inspect_command rejected this command because operators must appear between commands.");
    }
  }

  return entries;
}

function parsePipeline(tokens: Token[], startIndex: number): { pipeline: InspectCommandPipeline; nextIndex: number } {
  const commands: InspectSimpleCommand[] = [];
  let index = startIndex;

  while (index < tokens.length) {
    const parsed = parseSimpleCommand(tokens, index);
    commands.push(parsed.command);
    index = parsed.nextIndex;

    const token = tokens[index];

    if (token?.type !== "operator" || token.value !== "|") {
      break;
    }

    index += 1;

    if (index >= tokens.length || tokens[index]?.type === "operator") {
      throw new Error("inspect_command rejected this command because pipelines must contain commands on both sides.");
    }
  }

  return { pipeline: { commands }, nextIndex: index };
}

function parseSimpleCommand(tokens: Token[], startIndex: number): { command: InspectSimpleCommand; nextIndex: number } {
  const words: string[] = [];
  let index = startIndex;

  while (index < tokens.length) {
    const token = tokens[index];

    if (token?.type !== "word") {
      break;
    }

    words.push(token.value);
    index += 1;
  }

  if (words.length === 0) {
    throw new Error("inspect_command rejected this command because empty commands are not allowed.");
  }

  return {
    command: {
      executable: words[0] ?? "",
      args: words.slice(1),
    },
    nextIndex: index,
  };
}
