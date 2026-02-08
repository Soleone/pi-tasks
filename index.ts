import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"

import beadsTasks from "./beads-tasks.ts"

export default function (pi: ExtensionAPI) {
  beadsTasks(pi)
}
