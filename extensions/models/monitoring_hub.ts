/**
 * @keeb/monitoring/hub model — validate the observability stack endpoints
 * (Loki, Prometheus) on the monitoring hub host, register VMs as
 * Prometheus scrape targets via file_sd_configs, and edit/inspect the live
 * `prometheus.yml`.
 */
import { z } from "npm:zod@4";
import { sshExec, sshExecRaw } from "./lib/ssh.ts";

const GlobalArgs = z.object({
  sshHost: z.string().describe(
    "SSH hostname/IP of the monitoring hub (hancock)",
  ),
  sshUser: z.string().default("keeb").describe("SSH user (default 'keeb')"),
  targetsDir: z.string().describe(
    "Path to Prometheus file_sd_configs targets directory",
  ),
});

const DiscoverArgs = z.object({});

const RegisterArgs = z.object({
  vmName: z.string().describe(
    "VM name to register as a Prometheus scrape target",
  ),
  targetIp: z.string().describe("IP address of the target VM"),
});

const InspectArgs = z.object({});

const ReloadArgs = z.object({});

const RemoveScrapeJobArgs = z.object({
  jobName: z.string().describe(
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

/** Swamp model definition for `@keeb/monitoring/hub`. */
export const model: {
  type: string;
  version: string;
  resources: Record<string, unknown>;
  globalArguments: typeof GlobalArgs;
  methods: Record<string, unknown>;
} = {
  type: "@keeb/monitoring/hub",
  version: "2026.04.26.1",
  resources: {
    "hub": {
      description: "Observability stack endpoints on hancock",
      schema: HubSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    "target": {
      description: "Prometheus scrape target registration",
      schema: TargetSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    "inspect": {
      description: "Live Prometheus scrape config and active targets",
      schema: InspectSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    "removeScrapeJob": {
      description:
        "Result of removing a scrape_config block from prometheus.yml",
      schema: RemoveScrapeJobSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  globalArguments: GlobalArgs,
  methods: {
    discover: {
      description: "Validate observability stack and write endpoint data",
      arguments: DiscoverArgs,
      execute: async (_args, context) => {
        const { sshHost, sshUser = "keeb", targetsDir } = context.globalArgs;

        console.log(`[discover] Checking observability stack on ${sshHost}`);

        // Check Loki readiness (exposed on host port 3100)
        console.log(`[discover] Checking Loki...`);
        const lokiResult = await sshExecRaw(
          sshHost,
          sshUser,
          `curl -sf http://localhost:3100/ready`,
        );
        const lokiReady = lokiResult.stdout.trim().toLowerCase() === "ready";
        console.log(`[discover] Loki ready: ${lokiReady}`);

        // Check Prometheus readiness (not exposed on host, use docker exec)
        console.log(`[discover] Checking Prometheus...`);
        const promResult = await sshExecRaw(
          sshHost,
          sshUser,
          `docker exec prometheus wget -qO- http://localhost:9090/-/ready`,
        );
        const prometheusReady = promResult.stdout.trim().includes("Ready");
        console.log(`[discover] Prometheus ready: ${prometheusReady}`);

        const lokiPushUrl = `http://${sshHost}:3100/loki/api/v1/push`;
        const prometheusUrl = `http://${sshHost}:9090`;

        console.log(`[discover] Loki push URL: ${lokiPushUrl}`);
        console.log(`[discover] Prometheus URL: ${prometheusUrl}`);

        const handle = await context.writeResource("hub", "hub", {
          lokiPushUrl,
          prometheusUrl,
          sshHost,
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
      execute: async (args, context) => {
        const { vmName, targetIp } = args;
        const { sshHost, sshUser = "keeb", targetsDir } = context.globalArgs;

        console.log(
          `[register] Registering ${vmName} (${targetIp}) as Prometheus target`,
        );

        // Write file_sd_configs JSON target file
        const targetFile = `${targetsDir}/${vmName}.json`;
        const targetConfig = JSON.stringify(
          [
            {
              targets: [`${targetIp}:9100`],
              labels: {
                instance: vmName,
                job: "node",
              },
            },
          ],
          null,
          2,
        );

        await sshExec(
          sshHost,
          sshUser,
          `cat > ${targetFile} << 'EOF'\n${targetConfig}\nEOF`,
        );
        console.log(`[register] Wrote target file: ${targetFile}`);
        console.log(`[register] Prometheus will auto-discover within 15s`);

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
      execute: async (_args, context) => {
        const { sshHost, sshUser = "keeb" } = context.globalArgs;

        console.log(`[inspect] Querying Prometheus on ${sshHost}`);

        const targetsResult = await sshExecRaw(
          sshHost,
          sshUser,
          `docker exec prometheus wget -qO- http://localhost:9090/api/v1/targets`,
        );
        const targetsJson = JSON.parse(targetsResult.stdout);
        const activeTargets = (targetsJson.data?.activeTargets || []).map(
          (t) => ({
            job: t.labels?.job || "",
            instance: t.labels?.instance || t.scrapeUrl || "",
            scrapePool: t.scrapePool || "",
            health: t.health || "",
          }),
        );

        const jobs = Array.from(new Set(activeTargets.map((t) => t.job)))
          .sort();
        console.log(`[inspect] Active jobs: ${JSON.stringify(jobs)}`);
        for (const t of activeTargets) {
          console.log(
            `[inspect]   job=${t.job} pool=${t.scrapePool} instance=${t.instance} health=${t.health}`,
          );
        }

        const configResult = await sshExecRaw(
          sshHost,
          sshUser,
          `docker exec prometheus wget -qO- http://localhost:9090/api/v1/status/config`,
        );
        const configJson = JSON.parse(configResult.stdout);
        const scrapeConfigsYaml = configJson.data?.yaml || "";

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
      execute: async (_args, context) => {
        const { sshHost, sshUser = "keeb" } = context.globalArgs;
        const result = await sshExecRaw(
          sshHost,
          sshUser,
          `docker kill -s HUP prometheus`,
        );
        if (result.code !== 0) {
          throw new Error(
            `SIGHUP failed: ${result.stderr || result.stdout}`,
          );
        }
        console.log(`[reload] SIGHUP sent to prometheus`);
        return { dataHandles: [] };
      },
    },
    removeScrapeJob: {
      description:
        "Remove a scrape_config block from the live prometheus.yml and reload",
      arguments: RemoveScrapeJobArgs,
      execute: async (args, context) => {
        const { jobName } = args;
        const { sshHost, sshUser = "keeb" } = context.globalArgs;

        if (!jobName) throw new Error("jobName is required");

        console.log(`[removeScrapeJob] Locating prometheus.yml on ${sshHost}`);
        const inspectResult = await sshExecRaw(
          sshHost,
          sshUser,
          `docker inspect -f '{{range .Mounts}}{{if eq .Destination "/etc/prometheus/prometheus.yml"}}{{.Source}}{{end}}{{end}}' prometheus`,
        );
        const configPath = inspectResult.stdout.trim();
        if (!configPath) {
          throw new Error(
            "Could not locate prometheus.yml bind mount on host",
          );
        }
        console.log(`[removeScrapeJob] Config file: ${configPath}`);

        const readResult = await sshExecRaw(
          sshHost,
          sshUser,
          `cat ${configPath}`,
        );
        const yamlContent = readResult.stdout;

        const lines = yamlContent.split("\n");
        const out = [];
        let skipping = false;
        let blockIndent = 0;
        let removed = false;
        const escaped = jobName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const startRe = new RegExp(
          `^(\\s*)-\\s+job_name:\\s*["']?${escaped}["']?\\s*$`,
        );

        for (const line of lines) {
          if (!skipping) {
            const m = line.match(startRe);
            if (m) {
              blockIndent = m[1].length;
              skipping = true;
              removed = true;
              continue;
            }
            out.push(line);
          } else {
            const trimmed = line.trim();
            if (trimmed === "" || trimmed.startsWith("#")) continue;
            const lstrip = line.length - line.trimStart().length;
            if (lstrip > blockIndent) continue;
            skipping = false;
            out.push(line);
          }
        }

        if (!removed) {
          console.log(
            `[removeScrapeJob] No job_name '${jobName}' found in ${configPath}`,
          );
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

        const newYaml = out.join("\n");
        const backupPath = `${configPath}.bak.${Date.now()}`;
        console.log(`[removeScrapeJob] Backup: ${backupPath}`);
        await sshExec(sshHost, sshUser, `cp ${configPath} ${backupPath}`);

        // Truncate-write in place — single-file Docker bind mounts break if we
        // swap the inode via mv (the container holds a reference to the old
        // inode and never sees the new file).
        const b64 = btoa(unescape(encodeURIComponent(newYaml)));
        await sshExec(
          sshHost,
          sshUser,
          `echo '${b64}' | base64 -d > ${configPath}`,
        );
        console.log(
          `[removeScrapeJob] Wrote new prometheus.yml (truncate-write, preserves inode)`,
        );

        console.log(`[removeScrapeJob] Validating with promtool`);
        const validateResult = await sshExecRaw(
          sshHost,
          sshUser,
          `docker exec prometheus promtool check config /etc/prometheus/prometheus.yml`,
        );
        if (validateResult.code !== 0) {
          console.log(`[removeScrapeJob] promtool failed, restoring backup`);
          await sshExec(sshHost, sshUser, `cp ${backupPath} ${configPath}`);
          throw new Error(
            `promtool validation failed (backup restored): stdout=${validateResult.stdout} stderr=${validateResult.stderr}`,
          );
        }
        console.log(`[removeScrapeJob] promtool ok`);

        const reloadResult = await sshExecRaw(
          sshHost,
          sshUser,
          `docker kill -s HUP prometheus`,
        );
        const reloaded = reloadResult.code === 0;
        console.log(`[removeScrapeJob] SIGHUP exit=${reloadResult.code}`);
        if (!reloaded) {
          console.log(`[removeScrapeJob] Reload failed, restoring backup`);
          await sshExec(sshHost, sshUser, `cp ${backupPath} ${configPath}`);
          throw new Error(
            `prometheus reload failed (backup restored): ${
              reloadResult.stderr || reloadResult.stdout
            }`,
          );
        }

        const handle = await context.writeResource(
          "removeScrapeJob",
          jobName,
          {
            jobName,
            configPath,
            removed: true,
            reloaded,
            timestamp: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
