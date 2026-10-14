// A scripted model, so the demo runs real pi without an API key and nothing leaves the browser.
// Each prompt below has a fixed run of replies; the tools they call (read, edit, bash) are real.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createFauxCore, fauxAssistantMessage, fauxText, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai";

const model = {
  id: "scripted",
  name: "Scripted",
  reasoning: true,
  input: ["text" as const],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 32_000,
};

const oldLine = 'console.log(`${city}: ${reading.sky}, ${reading.low}-${reading.high}°C, ${Math.round(reading.rain * 100)}% chance of rain`);';
const newLines = `if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ city, ...reading }));
} else {
  ${oldLine}
}`;
const oslo = '  oslo: { sky: "light rain", high: 9, low: 4, rain: 0.8 },';
const newYork = `${oslo}\n  "new york": { sky: "partly cloudy", high: 18, low: 11, rain: 0.2 },`;
// Closing a task in TODO.md is checking its box; pi-tasks reads the file again when the list opens.
const close = (title: string) => fauxToolCall("edit", { path: "TODO.md", edits: [{ oldText: `- [ ] **${title}**`, newText: `- [x] **${title}**` }] });

type Step = ReturnType<typeof fauxAssistantMessage>;
const toolUse = { stopReason: "toolUse" as const };

// Matched against the latest prompt; each entry lists the replies in order, one per model request.
const scripts: { match: RegExp; steps: Step[] }[] = [
  {
    match: /--json/i,
    steps: [
      fauxAssistantMessage([fauxThinking("A flag check around the final print is enough; keep the text output as it is."), fauxToolCall("edit", { path: "src/cli.js", edits: [{ oldText: oldLine, newText: newLines }] })], toolUse),
      fauxAssistantMessage([fauxToolCall("bash", { command: "node src/cli.js Lisbon --json && node src/cli.js Lisbon" })], toolUse),
      fauxAssistantMessage([fauxThinking("Works both ways. Close the task."), close("Add a --json flag")], toolUse),
      fauxAssistantMessage([fauxText("Added `--json`: it prints the reading as one JSON object, and the plain output is unchanged. The task is checked off in `TODO.md`, so it moved to the closed list.")]),
    ],
  },
  {
    match: /new york/i,
    steps: [
      fauxAssistantMessage([fauxToolCall("edit", { path: "src/readings.js", edits: [{ oldText: oslo, newText: newYork }] })], toolUse),
      fauxAssistantMessage([fauxToolCall("bash", { command: 'node src/cli.js "New York"' })], toolUse),
      fauxAssistantMessage([close("Add New York")], toolUse),
      fauxAssistantMessage([fauxText("New York has a reading now, and its task is closed. Tokyo is still open under **More cities**.")]),
    ],
  },
];

const fallback = fauxAssistantMessage([
  fauxText("I'm a scripted stand-in for a model, so I only know a few tasks. Open the list with **/tasks**, pick **Add a --json flag** or **Add New York**, and press Enter to hand it to me."),
]);

function text(content: unknown): string {
  return typeof content === "string" ? content : Array.isArray(content) ? content.map((part) => part?.text ?? "").join(" ") : "";
}

function nextStep(context: { messages: { role: string; content: unknown }[] }): Step {
  const lastUser = context.messages.findLastIndex((message) => message.role === "user");
  // Only the task's lead line, so a description that mentions another task cannot pick the wrong script.
  const prompt = text(context.messages[lastUser]?.content).split("\n")[0];
  const replies = context.messages.slice(lastUser + 1).filter((message) => message.role === "assistant").length;
  const script = scripts.find((candidate) => candidate.match.test(prompt));
  return script?.steps[replies] ?? (replies === 0 ? fallback : fauxAssistantMessage([fauxText("Done.")]));
}

export default function demoModel(pi: ExtensionAPI): void {
  const core = createFauxCore({ provider: "demo", api: "demo-scripted", models: [model], tokensPerSecond: 90 });
  pi.registerProvider("demo", {
    name: "Demo",
    baseUrl: "http://demo.invalid",
    apiKey: "demo",
    api: "demo-scripted" as never,
    models: [model],
    streamSimple: (requestModel, context, options) => {
      core.setResponses([nextStep(context as never)]);
      return core.streamSimple(requestModel as never, context, options);
    },
  });
}
