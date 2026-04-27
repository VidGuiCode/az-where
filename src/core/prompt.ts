import readline from "node:readline/promises";
import { stdin as input, stdout as output, stderr } from "node:process";
import { NonInteractiveError } from "./errors.js";
import { isNonInteractiveMode } from "./runtime.js";

export async function ask(question: string, defaultValue?: string): Promise<string> {
  if (isNonInteractiveMode()) {
    if (defaultValue !== undefined) return defaultValue;
    throw new NonInteractiveError(
      `Missing required value for '${question}' in non-interactive mode.`,
    );
  }
  const rl = readline.createInterface({ input, output });
  const prompt = defaultValue ? `${question} [${defaultValue}]: ` : `${question}: `;
  const answer = await rl.question(prompt);
  rl.close();
  return answer.trim() || defaultValue || "";
}

export async function confirm(question: string, defaultValue = false): Promise<boolean> {
  if (isNonInteractiveMode()) return defaultValue;
  const suffix = defaultValue ? "[Y/n]" : "[y/N]";
  const rl = readline.createInterface({ input, output: stderr });
  const answer = (await rl.question(`${question} ${suffix}: `)).trim().toLowerCase();
  rl.close();
  if (!answer) return defaultValue;
  return answer === "y" || answer === "yes";
}
