import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * The `lib/` import graph has no cycles.
 *
 * Not a style rule. A cycle between two service modules survives `tsc`,
 * `vitest` and `next build` — every one of them resolved
 * lib/leave-service.ts <-> lib/comp-off-service.ts without complaint — and
 * then fails at runtime, because which module is left half-initialised
 * depends on which one the bundler entered first. A page render entered
 * leave-service and worked; the Server Action entered the other way and threw
 * `approverFor is not a function`, which reaches the browser as the
 * uninformative "An unexpected response was received from the server".
 *
 * So the invariant is checked here, where it is cheap, rather than trusted to
 * the next person noticing.
 */

const LIB = join(process.cwd(), "lib");

/** `@/lib/x` imports in one file, as bare module names. */
function libImportsOf(file: string): string[] {
  const source = readFileSync(join(LIB, file), "utf8");
  const found = new Set<string>();

  // Covers `import ... from "@/lib/x"`, `import "@/lib/x"` and
  // `await import("@/lib/x")` alike — the specifier is what matters.
  for (const match of source.matchAll(/from\s+"@\/lib\/([\w-]+)"|import\("@\/lib\/([\w-]+)"\)/g)) {
    const name = match[1] ?? match[2];
    if (name) found.add(name);
  }

  return [...found];
}

function buildGraph(): Map<string, string[]> {
  const graph = new Map<string, string[]>();
  for (const entry of readdirSync(LIB)) {
    if (!entry.endsWith(".ts") && !entry.endsWith(".tsx")) continue;
    graph.set(entry.replace(/\.tsx?$/, ""), libImportsOf(entry));
  }
  return graph;
}

/** Every cycle in the graph, each as the path that closes it. */
function cyclesIn(graph: Map<string, string[]>): string[][] {
  const cycles: string[][] = [];
  const visiting = new Set<string>();
  const done = new Set<string>();

  const walk = (node: string, path: string[]) => {
    if (visiting.has(node)) {
      cycles.push([...path.slice(path.indexOf(node)), node]);
      return;
    }
    if (done.has(node)) return;

    visiting.add(node);
    for (const next of graph.get(node) ?? []) {
      if (!graph.has(next)) continue;
      walk(next, [...path, node]);
    }
    visiting.delete(node);
    done.add(node);
  };

  for (const node of graph.keys()) walk(node, []);
  return cycles;
}

describe("the lib/ import graph", () => {
  it("has no cycles", () => {
    const cycles = cyclesIn(buildGraph()).map((cycle) => cycle.join(" -> "));
    expect(cycles).toEqual([]);
  });

  it("lets leave-service read comp-off credit without comp-off-service reaching back", () => {
    const graph = buildGraph();

    // The dependency that has to exist: a Comp-off balance is the member's
    // approved claims, and `summaryFor` needs them.
    expect(graph.get("leave-service")).toContain("comp-off-service");

    // The one that must not: it would close the cycle. What the two share —
    // `approverFor`, so a claim and a leave request route to the same person —
    // lives in lib/approver.ts, which imports neither.
    expect(graph.get("comp-off-service")).not.toContain("leave-service");
    expect(graph.get("approver")).not.toContain("leave-service");
    expect(graph.get("approver")).not.toContain("comp-off-service");
  });
});
