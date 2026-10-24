import { describe, expect, it } from "vitest";
import { initialSimulatorControls, scenarioForConnection } from "./profile";

describe("connection profile", () => {
  it.each([undefined, "", "false", "TRUE", "1", " true "])(
    "leaves simulator controls disabled for %s",
    (value) => {
      expect(initialSimulatorControls(value)).toBe(false);
    },
  );

  it("requires an explicit simulator development flag", () => {
    expect(initialSimulatorControls("true")).toBe(true);
  });

  it("does not infer simulator support from MOCK mode", () => {
    expect(scenarioForConnection("MOCK", false, "review")).toBeUndefined();
  });

  it.each(["normal", "blocked", "review", "unknown", "lesson"] as const)(
    "allows %s only on an explicitly enabled MOCK connection",
    (scenario) => {
      expect(scenarioForConnection("MOCK", true, scenario)).toBe(scenario);
      expect(scenarioForConnection("TESTNET", true, scenario)).toBeUndefined();
      expect(scenarioForConnection(null, true, scenario)).toBeUndefined();
    },
  );
});
