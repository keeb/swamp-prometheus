/**
 * @keeb/monitoring/agent model — install and configure node_exporter and
 * promtail on a remote Alpine VM, and enable the node_exporter textfile
 * collector for custom .prom metrics.
 *
 * All remote work runs over SSH (see lib/ssh.ts). Every value interpolated
 * into a remote command or the generated promtail config is validated by the
 * argument schemas below.
 */
import { z } from "npm:zod@4";
import { assertSshTarget, sshExec } from "./lib/ssh.ts";
import { HTTP_URL_RE, VmName } from "./lib/validate.ts";

const GlobalArgs = z.object({
  sshHost: z.string().describe("SSH hostname/IP of the target VM"),
  sshUser: z.string().default("root").describe("SSH user (default 'root')"),
});

const InstallArgs = z.object({
  vmName: VmName.describe("VM name (used for resource naming)"),
});

const ConfigureArgs = z.object({
  vmName: VmName.describe("VM name (used as host label in promtail)"),
  lokiUrl: z.string().regex(
    HTTP_URL_RE,
    "lokiUrl must be an http(s) URL without whitespace, quotes or shell characters",
  ).describe(
    "Loki push URL (e.g. http://192.0.2.12:3100/loki/api/v1/push)",
  ),
});

const InstallSchema = z.object({
  nodeExporterRunning: z.boolean(),
  promtailInstalled: z.boolean(),
  timestamp: z.string(),
});

const ConfigSchema = z.object({
  lokiUrl: z.string(),
  promtailConfigured: z.boolean(),
  timestamp: z.string(),
});

const TextfileSchema = z.object({
  textfileCollectorEnabled: z.boolean(),
  timestamp: z.string(),
});

type GlobalArgsT = z.infer<typeof GlobalArgs>;

/** The subset of the swamp method context this model uses. */
interface AgentContext {
  globalArgs: GlobalArgsT;
  logger: {
    info: (message: string, props?: Record<string, unknown>) => void;
  };
  writeResource: (
    spec: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<unknown>;
}

/** Resolves and validates the SSH target from global arguments. */
function sshTarget(context: AgentContext): { host: string; user: string } {
  const { sshHost, sshUser = "root" } = context.globalArgs;
  assertSshTarget(sshHost, sshUser);
  return { host: sshHost, user: sshUser };
}

/** Renders the promtail config pushing syslog and /var/log/*.log to Loki. */
export function promtailConfig(lokiUrl: string, vmName: string): string {
  return `server:
  http_listen_port: 9080
  grpc_listen_port: 0

positions:
  filename: /var/lib/promtail/positions.yaml

clients:
  - url: ${lokiUrl}

scrape_configs:
  - job_name: syslog
    static_configs:
      - targets: [localhost]
        labels:
          host: ${vmName}
          job: syslog
          __path__: /var/log/messages
  - job_name: logs
    static_configs:
      - targets: [localhost]
        labels:
          host: ${vmName}
          job: logs
          __path__: /var/log/*.log
`;
}

/** Swamp model definition for `@keeb/monitoring/agent`. */
export const model = {
  type: "@keeb/monitoring/agent",
  version: "2026.02.17.1",
  resources: {
    "install": {
      description: "Monitoring agent install state",
      schema: InstallSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    "config": {
      description: "Monitoring agent configuration state",
      schema: ConfigSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    "textfile": {
      description: "Textfile collector setup state",
      schema: TextfileSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },
  globalArguments: GlobalArgs,
  upgrades: [
    {
      toVersion: "2026.02.17.1",
      description: "Baseline version, no globalArguments schema changes",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  checks: {
    "valid-ssh-target": {
      description:
        "sshHost is a plain hostname/IP (VM has an address) and sshUser a plain user name",
      labels: ["policy"],
      execute: (
        context: { globalArgs: GlobalArgsT },
      ): Promise<{ pass: boolean; errors?: string[] }> => {
        const { sshHost, sshUser = "root" } = context.globalArgs;
        try {
          assertSshTarget(sshHost, sshUser);
          return Promise.resolve({ pass: true });
        } catch (e) {
          return Promise.resolve({
            pass: false,
            errors: [(e as Error).message],
          });
        }
      },
    },
  },
  methods: {
    install: {
      description:
        "Install node-exporter and promtail binary on an Alpine VM (no configuration)",
      arguments: InstallArgs,
      execute: async (
        args: z.infer<typeof InstallArgs>,
        context: AgentContext,
      ) => {
        const { vmName } = InstallArgs.parse(args);
        const { host, user } = sshTarget(context);
        const log = context.logger;

        log.info("Installing monitoring agents on {host} ({vmName})", {
          host,
          vmName,
        });

        log.info("Enabling Alpine community repo");
        await sshExec(
          host,
          user,
          `sed -i '/^#.*\\/community$/s/^#//' /etc/apk/repositories && apk update`,
        );

        log.info("Installing node-exporter");
        await sshExec(
          host,
          user,
          `apk add prometheus-node-exporter && { rc-update add node-exporter default 2>/dev/null || true; } && { service node-exporter status >/dev/null 2>&1 || service node-exporter start; }`,
        );

        log.info("Verifying node-exporter on :9100");
        await sshExec(
          host,
          user,
          `wget -qO /dev/null http://localhost:9100/metrics`,
        );

        log.info("Installing promtail via apk");
        await sshExec(host, user, `apk add loki-promtail loki-promtail-openrc`);
        await sshExec(
          host,
          user,
          `rc-update add loki-promtail default 2>/dev/null || true`,
        );
        log.info(
          "Installed node-exporter (running) and promtail (not started, no config yet) on {vmName}",
          { vmName },
        );

        const handle = await context.writeResource("install", vmName, {
          nodeExporterRunning: true,
          promtailInstalled: true,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },
    configure: {
      description:
        "Configure promtail to push logs to Loki and start the service",
      arguments: ConfigureArgs,
      execute: async (
        args: z.infer<typeof ConfigureArgs>,
        context: AgentContext,
      ) => {
        const { vmName, lokiUrl } = ConfigureArgs.parse(args);
        const { host, user } = sshTarget(context);
        const log = context.logger;

        log.info("Configuring promtail on {host} ({vmName}) -> {lokiUrl}", {
          host,
          vmName,
          lokiUrl,
        });

        const config = promtailConfig(lokiUrl, vmName);
        await sshExec(host, user, `mkdir -p /etc/loki /var/lib/promtail`);
        await sshExec(
          host,
          user,
          `cat > /etc/loki/promtail-local-config.yaml << 'EOF'\n${config}EOF`,
        );
        log.info("Wrote /etc/loki/promtail-local-config.yaml");

        // Stop old Docker container if somehow present (idempotent cleanup)
        await sshExec(
          host,
          user,
          `docker stop promtail 2>/dev/null || true && docker rm promtail 2>/dev/null || true`,
        );

        // Ensure promtail is installed (idempotent — handles configure without prior install)
        await sshExec(
          host,
          user,
          `apk info -e loki-promtail >/dev/null 2>&1 || apk add loki-promtail loki-promtail-openrc`,
        );

        log.info("Starting native promtail service");
        await sshExec(
          host,
          user,
          `rc-update add loki-promtail default 2>/dev/null || true`,
        );
        await sshExec(
          host,
          user,
          `service loki-promtail restart 2>/dev/null || service loki-promtail start`,
        );
        log.info("promtail service running on {vmName}", { vmName });

        const handle = await context.writeResource("config", vmName, {
          lokiUrl,
          promtailConfigured: true,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },
    enableTextfileCollector: {
      description:
        "Enable node-exporter textfile collector for custom .prom metrics (one-time setup)",
      arguments: InstallArgs,
      execute: async (
        args: z.infer<typeof InstallArgs>,
        context: AgentContext,
      ) => {
        const { vmName } = InstallArgs.parse(args);
        const { host, user } = sshTarget(context);
        const log = context.logger;

        log.info("Setting up textfile collector on {host} ({vmName})", {
          host,
          vmName,
        });

        await sshExec(
          host,
          user,
          `mkdir -p /var/lib/node_exporter/textfile_collector`,
        );

        log.info("Configuring node-exporter textfile directory");
        await sshExec(
          host,
          user,
          [
            `grep -q 'textfile.directory' /etc/conf.d/node-exporter 2>/dev/null`,
            `|| echo 'ARGS="--collector.textfile.directory=/var/lib/node_exporter/textfile_collector"' >> /etc/conf.d/node-exporter`,
          ].join(" "),
        );

        log.info("Restarting node-exporter");
        await sshExec(host, user, `service node-exporter restart`);

        await sshExec(
          host,
          user,
          `wget -qO- http://localhost:9100/metrics | grep -q 'node_textfile_scrape_error' && echo ok`,
        );
        log.info("Textfile collector enabled on {vmName}", { vmName });

        const handle = await context.writeResource("textfile", vmName, {
          textfileCollectorEnabled: true,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
