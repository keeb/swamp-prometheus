import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "jsr:@std/assert@1";
import {
  createModelTestContext,
  withMockedCommand,
} from "jsr:@swamp-club/swamp-testing@0.20261014.55";
import { model, promtailConfig } from "./monitoring_agent.ts";
import {
  assertSshTarget,
  buildSshArgs,
  isValidSshHost,
  isValidSshUser,
  sshExec,
} from "./lib/ssh.ts";

const ok = { stdout: "", code: 0 };
const globalArgs = { sshHost: "192.0.2.10", sshUser: "root" };

// deno-lint-ignore no-explicit-any
type Any = any;

/** The remote command string is the last ssh argument. */
const remote = (args: string[]) => args[args.length - 1];

Deno.test("ssh: host/user validation rejects option injection and junk", () => {
  assert(isValidSshHost("192.0.2.10"));
  assert(isValidSshHost("hub.example.com"));
  assert(isValidSshHost("2001:db8::1"));
  for (const bad of ["", "null", "undefined", "-oProxyCommand=x", "a b", 5]) {
    assert(!isValidSshHost(bad), `host ${String(bad)} should be invalid`);
  }
  assert(isValidSshUser("root"));
  assert(isValidSshUser("svc_user-1"));
  for (const bad of ["", "-oFoo", "a b", "root;id", undefined]) {
    assert(!isValidSshUser(bad), `user ${String(bad)} should be invalid`);
  }
  assertSshTarget("hub.example.com", "keeb");
  assertThrows(() => assertSshTarget("hub.example.com", "-x"), Error, "sshUser");
});

Deno.test("ssh: buildSshArgs puts destination then command last", () => {
  const args = buildSshArgs("192.0.2.10", "root", "uptime");
  assertEquals(args.slice(-2), ["root@192.0.2.10", "uptime"]);
  assert(args.includes("ConnectTimeout=10"));
});

Deno.test("ssh: sshExec throws with stderr on non-zero exit", async () => {
  await withMockedCommand([{ stdout: "", stderr: "boom", code: 2 }], () =>
    assertRejects(
      () => sshExec("192.0.2.10", "root", "false"),
      Error,
      "exit 2): boom",
    ));
});

Deno.test("ssh: invalid host never spawns a process", async () => {
  const { calls } = await withMockedCommand([], async () => {
    await assertRejects(
      () => sshExec("-oProxyCommand=sh", "root", "id"),
      Error,
      "Invalid sshHost",
    );
  });
  assertEquals(calls.length, 0);
});

Deno.test("promtailConfig embeds Loki URL and host label", () => {
  const cfg = promtailConfig("http://192.0.2.12:3100/loki/api/v1/push", "web01");
  assertStringIncludes(cfg, "- url: http://192.0.2.12:3100/loki/api/v1/push");
  assertStringIncludes(cfg, "host: web01");
  assert(cfg.endsWith("\n"), "heredoc terminator must start on its own line");
});

Deno.test("install: runs apk steps over ssh and writes install state", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs,
  });
  const { calls } = await withMockedCommand(
    () => ok,
    () => model.methods.install.execute({ vmName: "web01" }, context as Any),
  );
  assertEquals(calls.length, 5);
  for (const c of calls) {
    assertEquals(c.command, "ssh");
    assert(c.args.includes("root@192.0.2.10"));
  }
  assertStringIncludes(remote(calls[1].args), "apk add prometheus-node-exporter");
  assertStringIncludes(remote(calls[3].args), "apk add loki-promtail");
  const written = getWrittenResources();
  assertEquals(written.length, 1);
  assertEquals(written[0].specName, "install");
  assertEquals(written[0].name, "web01");
  assertEquals(written[0].data.nodeExporterRunning, true);
  assertEquals(written[0].data.promtailInstalled, true);
});

Deno.test("install: ssh failure propagates and writes nothing", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs,
  });
  await withMockedCommand(
    (_cmd, args) =>
      remote(args).includes("node-exporter")
        ? { stdout: "", stderr: "apk: not found", code: 1 }
        : ok,
    () =>
      assertRejects(
        () => model.methods.install.execute({ vmName: "web01" }, context as Any),
        Error,
        "apk: not found",
      ),
  );
  assertEquals(getWrittenResources().length, 0);
});

Deno.test("install: missing sshHost fails before any ssh call", async () => {
  const { context } = createModelTestContext({
    globalArgs: { sshHost: "null", sshUser: "root" },
  });
  const { calls } = await withMockedCommand([], () =>
    assertRejects(
      () => model.methods.install.execute({ vmName: "web01" }, context as Any),
      Error,
      "Invalid sshHost",
    ));
  assertEquals(calls.length, 0);
});

Deno.test("configure: writes promtail config via quoted heredoc and records lokiUrl", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs,
  });
  const lokiUrl = "http://192.0.2.12:3100/loki/api/v1/push";
  const { calls } = await withMockedCommand(
    () => ok,
    () =>
      model.methods.configure.execute({ vmName: "web01", lokiUrl }, context as Any),
  );
  const write = calls.map((c) => remote(c.args)).find((r) =>
    r.startsWith("cat > /etc/loki/promtail-local-config.yaml << 'EOF'\n")
  );
  assert(write, "promtail config write not found");
  assert(write.endsWith("\nEOF"));
  assertStringIncludes(write, `- url: ${lokiUrl}`);
  const written = getWrittenResources();
  assertEquals(written[0].specName, "config");
  assertEquals(written[0].data.lokiUrl, lokiUrl);
  assertEquals(written[0].data.promtailConfigured, true);
});

Deno.test("configure: rejects a lokiUrl that could break out of the heredoc", async () => {
  const { context } = createModelTestContext({ globalArgs });
  const { calls } = await withMockedCommand([], async () => {
    for (
      const lokiUrl of [
        "http://x\nEOF\nrm -rf /",
        "ftp://192.0.2.12/",
        "http://192.0.2.12/$(id)",
      ]
    ) {
      await assertRejects(() =>
        model.methods.configure.execute(
          { vmName: "web01", lokiUrl },
          context as Any,
        )
      );
    }
  });
  assertEquals(calls.length, 0);
});

Deno.test("configure: rejects an unsafe vmName", async () => {
  const { context } = createModelTestContext({ globalArgs });
  await assertRejects(() =>
    model.methods.configure.execute(
      { vmName: "web01\n  evil: true", lokiUrl: "http://192.0.2.12:3100/" },
      context as Any,
    )
  );
});

Deno.test("enableTextfileCollector: configures, restarts and verifies", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs,
  });
  const { calls } = await withMockedCommand(
    () => ok,
    () =>
      model.methods.enableTextfileCollector.execute(
        { vmName: "web01" },
        context as Any,
      ),
  );
  const cmds = calls.map((c) => remote(c.args));
  assertStringIncludes(cmds[1], "--collector.textfile.directory=");
  assertEquals(cmds[2], "service node-exporter restart");
  assertStringIncludes(cmds[3], "node_textfile_scrape_error");
  assertEquals(getWrittenResources()[0].data.textfileCollectorEnabled, true);
});

Deno.test("enableTextfileCollector: verification failure throws and writes nothing", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs,
  });
  await withMockedCommand(
    (_cmd, args) =>
      remote(args).includes("node_textfile_scrape_error")
        ? { stdout: "", stderr: "", code: 1 }
        : ok,
    () =>
      assertRejects(() =>
        model.methods.enableTextfileCollector.execute(
          { vmName: "web01" },
          context as Any,
        )
      ),
  );
  assertEquals(getWrittenResources().length, 0);
});

Deno.test("upgrades: chain ends at the model version and is a no-op", () => {
  const last = model.upgrades[model.upgrades.length - 1];
  assertEquals(last.toVersion, model.version);
  const old = { sshHost: "192.0.2.10", sshUser: "root" };
  assertEquals(last.upgradeAttributes(old), old);
});

Deno.test("checks: valid-ssh-target passes and fails", async () => {
  const check = model.checks["valid-ssh-target"];
  assertEquals(await check.execute({ globalArgs }), { pass: true });
  const bad = await check.execute({
    globalArgs: { sshHost: "null", sshUser: "root" },
  });
  assertEquals(bad.pass, false);
  assertStringIncludes(bad.errors![0], "Invalid sshHost");
});
