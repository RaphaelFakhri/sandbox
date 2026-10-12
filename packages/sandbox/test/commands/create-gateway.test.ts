import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import * as cmd from "cmd-ts";
import { gatewayKeyFingerprint } from "../../src/util/agent-gateway/policy";
const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  key: vi.fn(),
  prepare: vi.fn(),
  exec: vi.fn(),
  tty: vi.fn(),
}));
vi.mock("node:tty", () => ({ isatty: mocks.tty }));
vi.mock("../../src/client", () => ({
  sandboxClient: { create: mocks.create, get: vi.fn() },
}));
vi.mock("@vercel/oidc", () => ({
  getVercelOidcToken: vi.fn(),
  getVercelToken: vi.fn(),
}));
vi.mock("../../src/commands/login", () => ({ login: { handler: vi.fn() } }));
vi.mock("../../src/util/agent-gateway/credentials", () => ({
  resolveGatewayKey: mocks.key,
}));
vi.mock("../../src/util/agent-gateway/config", () => ({
  prepareAgent: mocks.prepare,
}));
vi.mock("../../src/util/check-latest-version", () => ({
  startLatestVersionCheck: () => ({ report: vi.fn() }),
}));
vi.mock("../../src/commands/exec", async (load) => ({
  ...(await load<typeof import("../../src/commands/exec")>()),
  exec: { handler: mocks.exec },
}));
async function create(args: string[]) {
  const { create } = await import("../../src/commands/create");
  return cmd.runSafely(create, [
    ...args,
    "--scope=team",
    "--project=project",
    "--silent",
  ]);
}
describe("create --ai", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("VERCEL_AUTH_TOKEN", "host-vercel-token");
    mocks.tty.mockReturnValue(true);
    mocks.key.mockResolvedValue("host-gateway-secret");
    mocks.create.mockImplementation(async (args) => ({
      name: "test",
      interactivePort: 8443,
      tags: args.tags,
      runCommand: vi.fn().mockResolvedValue({ exitCode: 0 }),
    }));
  });
  afterEach(() => vi.unstubAllEnvs());
  test.each(["codex", "claude", "opencode", "pi"])(
    "configures %s after create and before launching, with external auth",
    async (agent) => {
      expect((await create(["--ai", agent]))._tag).toBe("ok");
      expect(mocks.key).toHaveBeenCalledOnce();
      const input = mocks.create.mock.calls[0][0];
      expect(input.image).toBe("vercel/sandbox/universal");
      expect(input.tags["sandbox-ai"]).toBe(
        `v2:${agent}:${gatewayKeyFingerprint("host-gateway-secret")}`,
      );
      expect(JSON.stringify(input.networkPolicy)).toContain(
        "host-gateway-secret",
      );
      expect(JSON.stringify(input.env)).not.toContain("host-gateway-secret");
      expect(mocks.prepare).toHaveBeenCalledOnce();
      expect(mocks.prepare.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.exec.mock.invocationCallOrder[0],
      );
      expect(JSON.stringify(mocks.exec.mock.calls)).not.toContain(
        "host-gateway-secret",
      );
    },
  );
  test("accepts flag after the agent too", async () => {
    expect((await create(["codex", "--ai"]))._tag).toBe("ok");
  });
  test.each([
    ["--ai", "--runtime=node24"],
    ["--ai", "codex", "--network-policy=deny-all"],
    ["--ai", "codex", "--env=AI_GATEWAY_API_KEY=secret"],
  ])(
    "rejects invalid setup before credentials or VM allocation: %j",
    async (...values) => {
      const args = values as unknown as string[];
      await expect(create(args)).rejects.toThrow();
      expect(mocks.create).not.toHaveBeenCalled();
      expect(mocks.key).not.toHaveBeenCalled();
    },
  );
  test("keeps ordinary launcher authentication unchanged", async () => {
    expect((await create(["codex"]))._tag).toBe("ok");
    expect(mocks.key).not.toHaveBeenCalled();
    expect(mocks.prepare).not.toHaveBeenCalled();
  });
  test("bare --ai prepares every harness without requiring a terminal or launching one", async () => {
    mocks.tty.mockReturnValue(false);
    mocks.key.mockResolvedValue(undefined);
    expect((await create(["--ai"]))._tag).toBe("ok");
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        image: "vercel/sandbox/universal",
        enableAiGateway: true,
        tags: { "sandbox-ai": "v3:all:managed" },
        networkPolicy: "allow-all",
      }),
    );
    expect(mocks.prepare).toHaveBeenCalledWith(expect.anything(), "all");
    expect(mocks.exec).not.toHaveBeenCalled();
  });
  test("requests a managed key for the selected agent when no local key is saved", async () => {
    mocks.key.mockResolvedValue(undefined);
    await create(["--ai", "codex"]);
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        enableAiGateway: true,
        tags: { "sandbox-ai": "v3:codex:managed" },
      }),
    );
    expect(mocks.prepare).toHaveBeenCalledWith(expect.anything(), "codex");
    expect(mocks.exec).toHaveBeenCalledOnce();
  });
  test("reports the retained sandbox when setup fails", async () => {
    mocks.prepare.mockRejectedValueOnce(
      new Error("sensitive implementation detail"),
    );
    await expect(create(["--ai", "pi"])).rejects.toThrow(/sandbox test/);
    expect(mocks.exec).not.toHaveBeenCalled();
  });
});
