// Turns the page's theme (~/.config/showcase/theme.json, written by the demo page) into a pi theme.
// Runs as the recipe's onTheme command; pi reloads its active custom theme when the file changes.
const { mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const path = require("node:path");

const home = path.join(__dirname, "..");
const theme = JSON.parse(readFileSync(path.join(home, ".config/showcase/theme.json"), "utf8"));
const { palette: p } = theme;

// A tint of the terminal background toward a color, for the tool panels.
function mix(base, color, amount) {
  const channel = (hex, at) => parseInt(hex.slice(at, at + 2), 16);
  return `#${[1, 3, 5].map((at) => Math.round(channel(base, at) * (1 - amount) + channel(color, at) * amount).toString(16).padStart(2, "0")).join("")}`;
}
const tint = theme.mode === "light" ? 0.14 : 0.16;

const colors = {
  accent: theme.accent,
  border: theme.muted,
  borderAccent: theme.accent,
  borderMuted: theme.line,
  success: p.green,
  error: p.red,
  warning: p.yellow,
  muted: theme.muted,
  dim: theme.muted,
  text: "",
  thinkingText: theme.muted,
  selectedBg: theme.line,
  userMessageBg: theme.surface,
  userMessageText: "",
  customMessageBg: theme.surface,
  customMessageText: "",
  customMessageLabel: theme.accent,
  toolPendingBg: mix(theme.terminal, p.blue, tint),
  toolSuccessBg: mix(theme.terminal, p.green, tint),
  toolErrorBg: mix(theme.terminal, p.red, tint),
  toolTitle: theme.inkStrong,
  toolOutput: "",
  mdHeading: theme.accent,
  mdLink: p.blue,
  mdLinkUrl: theme.muted,
  mdCode: p.cyan,
  mdCodeBlock: "",
  mdCodeBlockBorder: theme.line,
  mdQuote: theme.muted,
  mdQuoteBorder: theme.line,
  mdHr: theme.line,
  mdListBullet: theme.accent,
  toolDiffAdded: p.green,
  toolDiffRemoved: p.red,
  toolDiffContext: theme.muted,
  syntaxComment: theme.muted,
  syntaxKeyword: p.magenta,
  syntaxFunction: p.blue,
  syntaxVariable: theme.ink,
  syntaxString: p.green,
  syntaxNumber: p.yellow,
  syntaxType: p.cyan,
  syntaxOperator: theme.ink,
  syntaxPunctuation: theme.muted,
  thinkingOff: theme.line,
  thinkingMinimal: theme.muted,
  thinkingLow: p.blue,
  thinkingMedium: p.cyan,
  thinkingHigh: p.magenta,
  thinkingXhigh: p.red,
  thinkingMax: p.brightRed,
  bashMode: p.yellow,
};

const out = path.join(home, ".pi/agent/themes");
mkdirSync(out, { recursive: true });
writeFileSync(path.join(out, "showcase.json"), `${JSON.stringify({ name: "showcase", colors }, null, 2)}\n`);
