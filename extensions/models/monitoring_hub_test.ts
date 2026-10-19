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
import {
  extractActiveTargets,
  model,
  parsePromApi,
  removeJobBlock,
  targetFileJson,
  toBase64,
} from "./monitoring_hub.ts";
import { shellQuote } from "./lib/validate.ts";

const ok = { stdout: "", code: 0 };
const globalArgs = {
  sshHost: "hub.example.com",
  sshUser: "keeb",
  targetsDir: "/etc/prometheus/targets",
};

// deno-lint-ignore no-explicit-any
type Any = any;

const remote = (args: string[]) => args[args.length - 1];

const PROM_YML = [
  "global:",
  "  scrape_interval: 15s",
  "scrape_configs:",
  "  - job_name: node",
  "    file_sd_configs:",
  "      - files: ['/etc/prometheus/targets/*.json']",
  "",
  "  # legacy job",
  "  - job_name: 'old-app'",
  "    static_configs:",
  "      - targets: ['192.0.2.5:8080']",
  "  - job_name: loki",
  "    static_configs:",
  "      - targets: ['loki:3100']",
  "",
].join("\n");

Deno.test("removeJobBlock removes only the named block", () => {
  const { yaml, removed } = removeJobBlock(PROM_YML, "old-app");
  assert(removed);
  assert(!yaml.includes("old-app"));
  assert(!yaml.includes("192.0.2.5"));
  assertStringIncludes(yaml, "  - job_name: node");
  assertStringIncludes(yaml, "  - job_name: loki\n    static_configs:");
});

Deno.test("removeJobBlock removes the last block through EOF", () => {
  const { yaml, removed } = removeJobBlock(PROM_YML, "loki");
  assert(removed);
  assert(!yaml.includes("loki:3100"));
  assertStringIncludes(yaml, "old-app");
});

Deno.test("removeJobBlock removes adjacent duplicate blocks", () => {
  const dup = "scrape_configs:\n  - job_name: a\n    x: 1\n  - job_name: a\n    x: 2\n  - job_name: b\n";
  const { yaml } = removeJobBlock(dup, "a");
  assertEquals(yaml, "scrape_configs:\n  - job_name: b\n");
});

Deno.test("removeJobBlock leaves text untouched when job is absent or only a prefix", () => {
  for (const name of ["missing", "old", "node.*"]) {
    const { yaml, removed } = removeJobBlock(PROM_YML, name);
    assert(!removed, name);
    assertEquals(yaml, PROM_YML);
  }
});

Deno.test("toBase64 round-trips UTF-8", () => {
  const text = "job: café ✓\n";
  const bytes = Uint8Array.from(atob(toBase64(text)), (c) => c.charCodeAt(0));
  assertEquals(new TextDecoder().decode(bytes), text);
});

Deno.test("shellQuote neutralises quotes", () => {
  assertEquals(shellQuote("/a b/it's"), `'/a b/it'"'"'s'`);
});

Deno.test("parsePromApi rejects non-JSON and error responses", () => {
  assertThrows(() => parsePromApi("t", "<html>"), Error, "non-JSON");
  assertThrows(
    () => parsePromApi("t", '{"status":"error","error":"bad"}'),
    Error,
    "API error",
  );
  assertEquals(parsePromApi("t", '{"status":"success"}'), {
    status: "success",
  });
});

Deno.test("extractActiveTargets tolerates missing fields", () => {
  assertEquals(extractActiveTargets({}), []);
  assertEquals(
    extractActiveTargets({
      data: {
        activeTargets: [
          { labels: { job: "node", instance: "web01" }, health: "up" },
          { scrapeUrl: "http://192.0.2.9:9100/metrics", scrapePool: "x" },
        ],
      },
    }),
    [
      { job: "node", instance: "web01", scrapePool: "", health: "up" },
      {
        job: "",
        instance: "http://192.0.2.9:9100/metrics",
        scrapePool: "x",
        health: "",
      },
    ],
  );
});

Deno.test("targetFileJson builds a node target", () => {
  assertEquals(JSON.parse(targetFileJson("web01", "192.0.2.10")), [
    {
      targets: ["192.0.2.10:9100"],
      labels: { instance: "web01", job: "node" },
    },
  ]);
});

Deno.test("discover: records readiness and endpoints", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs,
  });
  await withMockedCommand(
    (_c, args) =>
      remote(args).includes(":3100/ready")
        ? { stdout: "ready\n", code: 0 }
        : { stdout: "", stderr: "no such container", code: 1 },
    () => model.methods.discover.execute({}, context as Any),
  );
  const data = getWrittenResources()[0].data;
  assertEquals(data.lokiReady, true);
  assertEquals(data.prometheusReady, false);
  assertEquals(data.lokiPushUrl, "http://hub.example.com:3100/loki/api/v1/push");
  assertEquals(data.prometheusUrl, "http://hub.example.com:9090");
  assertEquals(data.targetsDir, "/etc/prometheus/targets");
});

Deno.test("register: writes target file to a quoted path", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: { ...globalArgs, targetsDir: "/etc/prometheus/targets/" },
  });
  const { calls } = await withMockedCommand(
    () => ok,
    () =>
      model.methods.register.execute(
        { vmName: "web01", targetIp: "192.0.2.10" },
        context as Any,
      ),
  );
  assertEquals(calls.length, 1);
  const cmd = remote(calls[0].args);
  assert(cmd.startsWith("cat > '/etc/prometheus/targets/web01.json' << 'EOF'\n"));
  assert(cmd.endsWith("\nEOF"));
  assertStringIncludes(cmd, '"192.0.2.10:9100"');
  const w = getWrittenResources()[0];
  assertEquals(w.specName, "target");
  assertEquals(w.data.targetFile, "/etc/prometheus/targets/web01.json");
});

Deno.test("register: rejects unsafe vmName, targetIp, and relative targetsDir", async () => {
  const { context } = createModelTestContext({ globalArgs });
  const { calls } = await withMockedCommand([], async () => {
    await assertRejects(() =>
      model.methods.register.execute(
        { vmName: "../../etc/passwd", targetIp: "192.0.2.10" },
        context as Any,
      )
    );
    await assertRejects(() =>
      model.methods.register.execute(
        { vmName: "web01", targetIp: "192.0.2.10; rm -rf /" },
        context as Any,
      )
    );
    const rel = createModelTestContext({
      globalArgs: { ...globalArgs, targetsDir: "targets" },
    });
    await assertRejects(
      () =>
        model.methods.register.execute(
          { vmName: "web01", targetIp: "192.0.2.10" },
          rel.context as Any,
        ),
      Error,
      "absolute path",
    );
  });
  assertEquals(calls.length, 0);
});

Deno.test("register: ssh failure propagates and writes nothing", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs,
  });
  await withMockedCommand(
    [{ stdout: "", stderr: "Permission denied", code: 1 }],
    () =>
      assertRejects(
        () =>
          model.methods.register.execute(
            { vmName: "web01", targetIp: "192.0.2.10" },
            context as Any,
          ),
        Error,
        "Permission denied",
      ),
  );
  assertEquals(getWrittenResources().length, 0);
});

Deno.test("inspect: parses targets and config", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs,
  });
  const targets = {
    status: "success",
    data: {
      activeTargets: [
        { labels: { job: "node", instance: "web01" }, scrapePool: "node", health: "up" },
        { labels: { job: "loki", instance: "loki:3100" }, scrapePool: "loki", health: "up" },
      ],
    },
  };
  await withMockedCommand(
    [
      { stdout: JSON.stringify(targets), code: 0 },
      { stdout: JSON.stringify({ status: "success", data: { yaml: "g: 1" } }), code: 0 },
    ],
    () => model.methods.inspect.execute({}, context as Any),
  );
  const data = getWrittenResources()[0].data;
  assertEquals(data.jobs, ["loki", "node"]);
  assertEquals((data.activeTargets as unknown[]).length, 2);
  assertEquals(data.scrapeConfigsYaml, "g: 1");
});

Deno.test("inspect: failed docker exec throws instead of JSON parse error", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs,
  });
  await withMockedCommand(
    [{ stdout: "", stderr: "No such container: prometheus", code: 1 }],
    () =>
      assertRejects(
        () => model.methods.inspect.execute({}, context as Any),
        Error,
        "No such container",
      ),
  );
  assertEquals(getWrittenResources().length, 0);
});

Deno.test("reload: success and failure", async () => {
  const { context } = createModelTestContext({ globalArgs });
  const { calls } = await withMockedCommand(
    [ok],
    () => model.methods.reload.execute({}, context as Any),
  );
  assertEquals(remote(calls[0].args), "docker kill -s HUP prometheus");
  await withMockedCommand(
    [{ stdout: "", stderr: "not running", code: 1 }],
    () =>
      assertRejects(
        () => model.methods.reload.execute({}, context as Any),
        Error,
        "not running",
      ),
  );
});

/** Scripted hub for removeScrapeJob: dispatches on the remote command. */
function hubHandler(opts: { promtoolCode?: number; hupCode?: number } = {}) {
  return (_c: string, args: string[]) => {
    const r = remote(args);
    if (r.startsWith("docker inspect")) {
      return { stdout: "/srv/prom/prometheus.yml\n", code: 0 };
    }
    if (r === "cat '/srv/prom/prometheus.yml'") {
      return { stdout: PROM_YML, code: 0 };
    }
    if (r.includes("promtool")) return { stdout: "", code: opts.promtoolCode ?? 0 };
    if (r.startsWith("docker kill")) return { stdout: "", code: opts.hupCode ?? 0 };
    return ok;
  };
}

Deno.test("removeScrapeJob: backs up, rewrites in place, validates, reloads", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs,
  });
  const { calls } = await withMockedCommand(
    hubHandler(),
    () =>
      model.methods.removeScrapeJob.execute({ jobName: "old-app" }, context as Any),
  );
  const cmds = calls.map((c) => remote(c.args));
  assert(cmds.some((c) => c.startsWith("cp '/srv/prom/prometheus.yml' '/srv/prom/prometheus.yml.bak.")));
  const write = cmds.find((c) => c.includes("base64 -d >"));
  assert(write);
  const b64 = write.match(/^echo '([A-Za-z0-9+/=]+)'/)![1];
  const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
  assertEquals(
    new TextDecoder().decode(bytes),
    removeJobBlock(PROM_YML, "old-app").yaml,
  );
  const data = getWrittenResources()[0].data;
  assertEquals(data.removed, true);
  assertEquals(data.reloaded, true);
  assertEquals(data.configPath, "/srv/prom/prometheus.yml");
});

Deno.test("removeScrapeJob: absent job writes removed=false without touching the file", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs,
  });
  const { calls } = await withMockedCommand(
    hubHandler(),
    () =>
      model.methods.removeScrapeJob.execute({ jobName: "nope" }, context as Any),
  );
  assertEquals(calls.length, 2);
  assertEquals(getWrittenResources()[0].data.removed, false);
});

Deno.test("removeScrapeJob: promtool failure restores the backup and throws", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs,
  });
  const { calls } = await withMockedCommand(
    hubHandler({ promtoolCode: 1 }),
    () =>
      assertRejects(
        () =>
          model.methods.removeScrapeJob.execute({ jobName: "old-app" }, context as Any),
        Error,
        "backup restored",
      ),
  );
  const last = remote(calls[calls.length - 1].args);
  assert(last.startsWith("cat '/srv/prom/prometheus.yml.bak."));
  assert(last.endsWith("> '/srv/prom/prometheus.yml'"));
  assertEquals(getWrittenResources().length, 0);
});

Deno.test("removeScrapeJob: reload failure restores the backup and throws", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs,
  });
  await withMockedCommand(
    hubHandler({ hupCode: 1 }),
    () =>
      assertRejects(
        () =>
          model.methods.removeScrapeJob.execute({ jobName: "old-app" }, context as Any),
        Error,
        "reload failed",
      ),
  );
  assertEquals(getWrittenResources().length, 0);
});

Deno.test("removeScrapeJob: missing bind mount and unreadable config throw", async () => {
  const { context } = createModelTestContext({ globalArgs });
  await withMockedCommand(
    [{ stdout: "\n", code: 0 }],
    () =>
      assertRejects(
        () =>
          model.methods.removeScrapeJob.execute({ jobName: "old-app" }, context as Any),
        Error,
        "bind mount",
      ),
  );
  await withMockedCommand(
    [
      { stdout: "/srv/prom/prometheus.yml\n", code: 0 },
      { stdout: "", stderr: "Permission denied", code: 1 },
    ],
    () =>
      assertRejects(
        () =>
          model.methods.removeScrapeJob.execute({ jobName: "old-app" }, context as Any),
        Error,
        "Permission denied",
      ),
  );
});

Deno.test("removeScrapeJob: rejects invalid job names", async () => {
  const { context } = createModelTestContext({ globalArgs });
  for (const jobName of ["", "a b", "x'; rm -rf /"]) {
    await assertRejects(() =>
      model.methods.removeScrapeJob.execute({ jobName }, context as Any)
    );
  }
});

Deno.test("upgrades: chain ends at the model version and is a no-op", () => {
  const last = model.upgrades[model.upgrades.length - 1];
  assertEquals(last.toVersion, model.version);
  const old = { sshHost: "192.0.2.10", sshUser: "root" };
  assertEquals(last.upgradeAttributes(old), old);
});

Deno.test("checks: valid-hub-target reports every problem", async () => {
  const check = model.checks["valid-hub-target"];
  assertEquals(await check.execute({ globalArgs }), { pass: true });
  const bad = await check.execute({
    globalArgs: { sshHost: "-oProxyCommand=x", sshUser: "keeb", targetsDir: "rel" },
  });
  assertEquals(bad.pass, false);
  assertEquals(bad.errors!.length, 2);
});

Deno.test("removeJobBlock keeps comments that precede the next job", () => {
  const { yaml, removed } = removeJobBlock(PROM_YML, "node");
  assert(removed);
  assert(!yaml.includes("file_sd_configs"));
  assertStringIncludes(yaml, "scrape_configs:\n\n  # legacy job\n  - job_name: 'old-app'");
});

Deno.test("removeJobBlock matches quoted names and trailing comments, keeps final newline", () => {
  const text = 'scrape_configs:\n  - job_name: "x" # temp\n    a: 1\n';
  assertEquals(removeJobBlock(text, "x"), {
    yaml: "scrape_configs:\n",
    removed: true,
  });
});

Deno.test("discover: ssh connection failure throws instead of recording not-ready", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs,
  });
  await withMockedCommand(
    () => ({ stdout: "", stderr: "Connection timed out", code: 255 }),
    () =>
      assertRejects(
        () => model.methods.discover.execute({}, context as Any),
        Error,
        "Connection timed out",
      ),
  );
  assertEquals(getWrittenResources().length, 0);
});
