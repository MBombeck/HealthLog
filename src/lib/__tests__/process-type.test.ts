import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  assertSubsystemEnabled,
  getProcessType,
  shouldRunWeb,
  shouldRunWorker,
} from "../process-type";

describe("process-type gate", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it("defaults to 'all' when env is unset", () => {
    vi.stubEnv("HEALTHLOG_PROCESS_TYPE", "");
    expect(getProcessType()).toBe("all");
    expect(shouldRunWeb()).toBe(true);
    expect(shouldRunWorker()).toBe(true);
  });

  it("recognises web mode", () => {
    vi.stubEnv("HEALTHLOG_PROCESS_TYPE", "web");
    expect(getProcessType()).toBe("web");
    expect(shouldRunWeb()).toBe(true);
    expect(shouldRunWorker()).toBe(false);
  });

  it("recognises worker mode", () => {
    vi.stubEnv("HEALTHLOG_PROCESS_TYPE", "worker");
    expect(getProcessType()).toBe("worker");
    expect(shouldRunWeb()).toBe(false);
    expect(shouldRunWorker()).toBe(true);
  });

  it("rejects unknown values", () => {
    vi.stubEnv("HEALTHLOG_PROCESS_TYPE", "junk");
    expect(() => getProcessType()).toThrow(/Invalid HEALTHLOG_PROCESS_TYPE/);
  });

  it("assertSubsystemEnabled refuses cross-mode boots", () => {
    vi.stubEnv("HEALTHLOG_PROCESS_TYPE", "web");
    expect(() => assertSubsystemEnabled("worker")).toThrow(
      /Refusing to start worker/,
    );
    expect(() => assertSubsystemEnabled("web")).not.toThrow();

    vi.stubEnv("HEALTHLOG_PROCESS_TYPE", "worker");
    expect(() => assertSubsystemEnabled("web")).toThrow(
      /Refusing to start web/,
    );
    expect(() => assertSubsystemEnabled("worker")).not.toThrow();
  });
});
