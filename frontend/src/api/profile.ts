import type { MockScenario } from "./client";
import type { ExecutionMode } from "./types";

/** A MOCK response identifies execution mode, not simulator capabilities. */
export function initialSimulatorControls(value: string | undefined): boolean {
  return value === "true";
}

/** Scenario headers are an explicit contract-simulator control. */
export function scenarioForConnection(
  mode: ExecutionMode | null,
  enabled: boolean,
  scenario: MockScenario,
): MockScenario | undefined {
  return mode === "MOCK" && enabled ? scenario : undefined;
}
