/**
 * @keeb/monitoring/hub model — validate the observability stack endpoints
 * (Loki, Prometheus) on the monitoring hub host, register VMs as
 * Prometheus scrape targets via file_sd_configs, and edit/inspect the live
 * `prometheus.yml`.
 *
 * All remote work runs over SSH (see lib/ssh.ts). Paths are shell-quoted and
 * every other interpolated value is validated by the argument schemas below.
 */
import { z } from "npm:zod@4";
import { assertSshTarget, sshExec, sshExecRaw } from "./lib/ssh.ts";
import {
  assertAbsPath,
  JOB_NAME_RE,
  shellQuote,
  TARGET_HOST_RE,
  VmName,
} from "./lib/validate.ts";

const GlobalArgs = z.object({
  sshHost: z.string().describe(
    "SSH hostname/IP of the monitoring hub",
  ),
  sshUser: z.string().default("keeb").describe("SSH user (default 'keeb')"),
  targetsDir: z.string().describe(
    "Path to Prometheus file_sd_configs targets directory",
  ),
});

const DiscoverArgs = z.object({});

const RegisterArgs = z.object({
  vmName: VmName.describe(
    "VM name to register as a Prometheus scrape target",
  ),
  targetIp: z.string().regex(
    TARGET_HOST_RE,
    "targetIp must be an IPv4 address, hostname, or [IPv6] literal",
  ).describe("IP address of the target VM"),
});

const InspectArgs = z.object({});

const ReloadArgs = z.object({});

const RemoveScrapeJobArgs = z.object({
  jobName: z.string().regex(
    JOB_NAME_RE,
    "jobName must be 1-128 letters, digits, '_', '.', ':' or '-'",
  ).describe(
    "Name of the scrape_config job_name to remove from prometheus.yml",
  ),
});

const InspectSchema = z.object({
  jobs: z.array(z.string()),
  activeTargets: z.array(z.object({
    job: z.string(),
    instance: z.string(),
    scrapePool: z.string(),
    health: z.string(),
  })),
  scrapeConfigsYaml: z.string(),
  timestamp: z.string(),
});

const RemoveScrapeJobSchema = z.object({
  jobName: z.string(),
  configPath: z.string(),
  removed: z.boolean(),
  reloaded: z.boolean(),
  timestamp: z.string(),
});

const HubSchema = z.object({
  lokiPushUrl: z.string(),
  prometheusUrl: z.string(),
  sshHost: z.string(),
  targetsDir: z.string(),
  lokiReady: z.boolean(),
  prometheusReady: z.boolean(),
  timestamp: z.string(),
});

const TargetSchema = z.object({
  success: z.boolean(),
  targetFile: z.string(),
  targetIp: z.string(),
  timestamp: z.string(),
});

type GlobalArgsT = z.infer<typeof GlobalArgs>;

/** The subset of the swamp method context this model uses. */
interface HubContext {
  globalArgs: GlobalArgsT;
  logger: {
    info: (message: string, props?: Record<string, unknown>) => void;
    warning: (message: string, props?: Record<string, unknown>) => void;
  };
  writeResource: (
    spec: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<unknown>;
}

/** An active target as reported by Prometheus' /api/v1/targets. */
export interface ActiveTarget {
  job: string;
  instance: string;
  scrapePool: string;
  health: string;
}

/** Resolves and validates the SSH target from global arguments. */
function sshTarget(context: HubContext): { host: string; user: string } {
  const { sshHost, sshUser = "keeb" } = context.globalArgs;
  assertSshTarget(sshHost, sshUser);
  return { host: sshHost, user: sshUser };
}

/** Parses a Prometheus HTTP API JSON response, throwing a descriptive error. */
export function parsePromApi(label: string, stdout: string): unknown {
  let body: unknown;
  try {
    body = JSON.parse(stdout);
  } catch {
    throw new Error(
      `${label}: Prometheus returned non-JSON output: ${stdout.slice(0, 200)}`,
    );
  }
  if (
    typeof body !== "object" || body === null ||
    (body as { status?: unknown }).status === "error"
  ) {
    throw new Error(
      `${label}: Prometheus API error: ${JSON.stringify(body).slice(0, 300)}`,
    );
  }
  return body;
}

/** Extracts active targets from a parsed /api/v1/targets response. */
export function extractActiveTargets(body: unknown): ActiveTarget[] {
  const raw = (body as { data?: { activeTargets?: unknown } })?.data
    ?.activeTargets;
  if (!Array.isArray(raw)) return [];
  return raw.map((t) => {
    const s = (v: unknown) => (typeof v === "string" ? v : "");
    const labels = (t?.labels ?? {}) as Record<string, unknown>;
    return {
      job: s(labels.job),
      instance: s(labels.instance) || s(t?.scrapeUrl),
      scrapePool: s(t?.scrapePool),
      health: s(t?.health),
    };
  });
}

/** Builds the file_sd_configs JSON for a single node_exporter target. */
export function targetFileJson(vmName: string, targetHost: string): string {
  return JSON.stringify(
    [
      {
        targets: [`${targetHost}:9100`],
        labels: { instance: vmName, job: "node" },
      },
    ],
    null,
    2,
  );
}

/**
 * Removes every `- job_name: <jobName>` block from a prometheus.yml body.
 * A block ends at the first non-blank, non-comment line whose indentation is
 * at or left of the `- job_name` dash. Blank lines and comments at or left of
 * that indentation that sit between the removed block and the next entry are
 * kept (they usually describe the next entry); deeper comments are dropped
 * with the block. Returns the new text and whether any block was removed.
 */
export function removeJobBlock(
  yamlContent: string,
  jobName: string,
): { yaml: string; removed: boolean } {
  const lines = yamlContent.split("\n");
  const out: string[] = [];
  let skipping = false;
  let blockIndent = 0;
  let removed = false;
  let pending: string[] = [];
  const escaped = jobName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const startRe = new RegExp(
    `^(\\s*)-\\s+job_name:\\s*["']?${escaped}["']?\\s*(?:#.*)?$`,
  );

  for (const line of lines) {
    if (skipping) {
      const trimmed = line.trim();
      const lstrip = line.length - line.trimStart().length;
      if (trimmed === "") {
        pending.push(line);
        continue;
      }
      if (trimmed.startsWith("#")) {
        if (lstrip <= blockIndent) pending.push(line);
        continue;
      }
      if (lstrip > blockIndent) {
        pending = [];
        continue;
      }
      skipping = false;
      out.push(...pending);
      pending = [];
    }
    const m = line.match(startRe);
    if (m) {
      blockIndent = m[1].length;
      skipping = true;
      removed = true;
      continue;
    }
    out.push(line);
  }
  // A block removed at EOF swallows the final newline; keep the file
  // newline-terminated if it was.
  if (removed && yamlContent.endsWith("\n") && out[out.length - 1] !== "") {
    out.push("");
  }
  return { yaml: out.join("\n"), removed };
}

/** UTF-8 safe base64 encoding. */
export function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** Swamp model definition for `@keeb/monitoring/hub`. */
export const model = {
  type: "@keeb/monitoring/hub",
  version: "2026.04.26.1",
  resources: {
    "hub": {
      description: "Observability stack endpoints on the monitoring hub",
      schema: HubSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    "target": {
      description: "Prometheus scrape target registration",
      schema: TargetSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    "inspect": {
      description: "Live Prometheus scrape config and active targets",
      schema: InspectSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    "removeScrapeJob": {
      description:
        "Result of removing a scrape_config block from prometheus.yml",
      schema: RemoveScrapeJobSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },
  globalArguments: GlobalArgs,
  upgrades: [
    {
      toVersion: "2026.04.26.1",
      description: "Baseline version, no globalArguments schema changes",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  checks: {
    "valid-hub-target": {
      description:
        "sshHost/sshUser are a plain hostname/IP and user name, and targetsDir is absolute",
      labels: ["policy"],
      execute: (
        context: { globalArgs: GlobalArgsT },
      ): Promise<{ pass: boolean; errors?: string[] }> => {
        const { sshHost, sshUser = "keeb", targetsDir } = context.globalArgs;
        const errors: string[] = [];
        for (
          const check of [
            () => assertSshTarget(sshHost, sshUser),
            () => assertAbsPath("targetsDir", targetsDir),
          ]
        ) {
          try {
            check();
          } catch (e) {
            errors.push((e as Error).message);
          }
        }
        return Promise.resolve(
          errors.length ? { pass: false, errors } : { pass: true },
        );
      },
    },
  },
  methods: {
    discover: {
      description: "Validate observability stack and write endpoint data",
      arguments: DiscoverArgs,
      execute: async (
        _args: z.infer<typeof DiscoverArgs>,
        context: HubContext,
      ) => {
        const { host, user } = sshTarget(context);
        const { targetsDir } = context.globalArgs;
        const log = context.logger;

        log.info("Checking observability stack on {host}", { host });

        // Loki readiness (exposed on host port 3100)
        const lokiResult = await sshExecRaw(
          host,
          user,
          `curl -sf http://localhost:3100/ready`,
        );
        const lokiReady = lokiResult.code === 0 &&
          lokiResult.stdout.trim().toLowerCase() === "ready";

        // Prometheus readiness (not exposed on host, use docker exec)
        const promResult = await sshExecRaw(
          host,
          user,
          `docker exec prometheus wget -qO- http://localhost:9090/-/ready`,
        );
        const prometheusReady = promResult.code === 0 &&
          promResult.stdout.trim().includes("Ready");

        // Exit 255 is ssh's own failure (unreachable host, auth): that is not
        // "service not ready", so fail instead of recording a false negative.
        for (
          const [name, r] of [["Loki", lokiResult], [
            "Prometheus",
            promResult,
          ]] as const
        ) {
          if (r.code === 255) {
            throw new Error(
              `discover: SSH to ${user}@${host} failed while checking ${name}: ${
                r.stderr.slice(-500)
              }`,
            );
          }
        }

        if (!lokiReady) {
          log.warning("Loki is not ready on {host}", { host });
        }
        if (!prometheusReady) {
          log.warning("Prometheus is not ready on {host}", { host });
        }

        const lokiPushUrl = `http://${host}:3100/loki/api/v1/push`;
        const prometheusUrl = `http://${host}:9090`;

        log.info(
          "Discovered hub: loki={lokiPushUrl} ready={lokiReady}, prometheus={prometheusUrl} ready={prometheusReady}",
          { lokiPushUrl, lokiReady, prometheusUrl, prometheusReady },
        );

        const handle = await context.writeResource("hub", "hub", {
          lokiPushUrl,
          prometheusUrl,
          sshHost: host,
          targetsDir,
          lokiReady,
          prometheusReady,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },
    register: {
      description:
        "Register a VM as a Prometheus scrape target via file_sd_configs",
      arguments: RegisterArgs,
      execute: async (
        args: z.infer<typeof RegisterArgs>,
        context: HubContext,
      ) => {
        const { vmName, targetIp } = RegisterArgs.parse(args);
        const { host, user } = sshTarget(context);
        const targetsDir = assertAbsPath(
          "targetsDir",
          context.globalArgs.targetsDir,
        ).replace(/\/+$/, "");
        const log = context.logger;

        log.info("Registering {vmName} ({targetIp}) as Prometheus target", {
          vmName,
          targetIp,
        });

        const targetFile = `${targetsDir}/${vmName}.json`;
        const targetConfig = targetFileJson(vmName, targetIp);

        await sshExec(
          host,
          user,
          `cat > ${shellQuote(targetFile)} << 'EOF'\n${targetConfig}\nEOF`,
        );
        log.info(
          "Wrote target file {targetFile}; Prometheus picks it up on its next file_sd refresh",
          { targetFile },
        );

        const handle = await context.writeResource("target", vmName, {
          success: true,
          targetFile,
          targetIp,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },
    inspect: {
      description:
        "Inspect live Prometheus scrape config and active targets via the HTTP API",
      arguments: InspectArgs,
      execute: async (
        _args: z.infer<typeof InspectArgs>,
        context: HubContext,
      ) => {
        const { host, user } = sshTarget(context);
        const log = context.logger;

        log.info("Querying Prometheus on {host}", { host });

        const targetsResult = await sshExec(
          host,
          user,
          `docker exec prometheus wget -qO- http://localhost:9090/api/v1/targets`,
        );
        const activeTargets = extractActiveTargets(
          parsePromApi("inspect /api/v1/targets", targetsResult.stdout),
        );

        const jobs = Array.from(new Set(activeTargets.map((t) => t.job)))
          .sort();

        const configResult = await sshExec(
          host,
          user,
          `docker exec prometheus wget -qO- http://localhost:9090/api/v1/status/config`,
        );
        const configJson = parsePromApi(
          "inspect /api/v1/status/config",
          configResult.stdout,
        ) as { data?: { yaml?: unknown } };
        const scrapeConfigsYaml = typeof configJson.data?.yaml === "string"
          ? configJson.data.yaml
          : "";

        log.info("Found {count} active targets across jobs {jobs}", {
          count: activeTargets.length,
          jobs,
        });

        const handle = await context.writeResource("inspect", "inspect", {
          jobs,
          activeTargets,
          scrapeConfigsYaml,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },
    reload: {
      description:
        "Send SIGHUP to the prometheus container to reload its config",
      arguments: ReloadArgs,
      execute: async (
        _args: z.infer<typeof ReloadArgs>,
        context: HubContext,
      ) => {
        const { host, user } = sshTarget(context);
        context.logger.info("Sending SIGHUP to prometheus on {host}", { host });
        const result = await sshExecRaw(
          host,
          user,
          `docker kill -s HUP prometheus`,
        );
        if (result.code !== 0) {
          throw new Error(
            `SIGHUP to prometheus on ${host} failed (exit ${result.code}): ${
              result.stderr || result.stdout
            }`,
          );
        }
        context.logger.info("SIGHUP sent to prometheus");
        return { dataHandles: [] };
      },
    },
    removeScrapeJob: {
      description:
        "Remove a scrape_config block from the live prometheus.yml and reload",
      arguments: RemoveScrapeJobArgs,
      execute: async (
        args: z.infer<typeof RemoveScrapeJobArgs>,
        context: HubContext,
      ) => {
        const { jobName } = RemoveScrapeJobArgs.parse(args);
        const { host, user } = sshTarget(context);
        const log = context.logger;

        log.info("Removing scrape job {jobName} on {host}", { jobName, host });
        const inspectResult = await sshExec(
          host,
          user,
          `docker inspect -f '{{range .Mounts}}{{if eq .Destination "/etc/prometheus/prometheus.yml"}}{{.Source}}{{end}}{{end}}' prometheus`,
        );
        const configPath = inspectResult.stdout.trim();
        if (!configPath) {
          throw new Error(
            `Could not locate the prometheus.yml bind mount of the prometheus container on ${host}`,
          );
        }
        assertAbsPath("prometheus.yml bind-mount source", configPath);
        const qConfig = shellQuote(configPath);
        log.info("Config file: {configPath}", { configPath });

        const readResult = await sshExec(host, user, `cat ${qConfig}`);
        const { yaml: newYaml, removed } = removeJobBlock(
          readResult.stdout,
          jobName,
        );

        if (!removed) {
          log.info("No job_name {jobName} found in {configPath}", {
            jobName,
            configPath,
          });
          const handle = await context.writeResource(
            "removeScrapeJob",
            jobName,
            {
              jobName,
              configPath,
              removed: false,
              reloaded: false,
              timestamp: new Date().toISOString(),
            },
          );
          return { dataHandles: [handle] };
        }

        const backupPath = `${configPath}.bak.${Date.now()}`;
        const qBackup = shellQuote(backupPath);
        log.info("Backing up config to {backupPath}", { backupPath });
        await sshExec(host, user, `cp ${qConfig} ${qBackup}`);

        // Truncate-write in place — single-file Docker bind mounts break if we
        // swap the inode via mv (the container holds a reference to the old
        // inode and never sees the new file).
        await sshExec(
          host,
          user,
          `echo '${toBase64(newYaml)}' | base64 -d > ${qConfig}`,
        );
        log.info("Wrote new prometheus.yml (truncate-write, preserves inode)");

        const validateResult = await sshExecRaw(
          host,
          user,
          `docker exec prometheus promtool check config /etc/prometheus/prometheus.yml`,
        );
        if (validateResult.code !== 0) {
          log.warning("promtool rejected the new config, restoring backup");
          await sshExec(host, user, `cat ${qBackup} > ${qConfig}`);
          throw new Error(
            `promtool validation failed (backup restored): stdout=${validateResult.stdout} stderr=${validateResult.stderr}`,
          );
        }

        const reloadResult = await sshExecRaw(
          host,
          user,
          `docker kill -s HUP prometheus`,
        );
        if (reloadResult.code !== 0) {
          log.warning("Prometheus reload failed, restoring backup");
          await sshExec(host, user, `cat ${qBackup} > ${qConfig}`);
          throw new Error(
            `prometheus reload failed (backup restored): ${
              reloadResult.stderr || reloadResult.stdout
            }`,
          );
        }
        log.info("Removed job {jobName} and reloaded prometheus", { jobName });

        const handle = await context.writeResource(
          "removeScrapeJob",
          jobName,
          {
            jobName,
            configPath,
            removed: true,
            reloaded: true,
            timestamp: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
