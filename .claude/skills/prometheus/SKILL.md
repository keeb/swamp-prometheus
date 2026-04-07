---
name: prometheus
description: Install and wire monitoring agents (node_exporter, promtail) on remote Alpine VMs over SSH and register VMs as Prometheus scrape targets via file_sd_configs from swamp workflows. Provides the @user/monitoring/agent and @user/monitoring/hub models from @keeb/prometheus. Use when setting up host metrics collection, shipping logs to Loki, registering Prometheus targets, enabling the node_exporter textfile collector for custom .prom metrics, or wiring observability into automation. Triggers on "prometheus", "node_exporter", "node-exporter", "promtail", "loki", "monitoring agent", "scrape target", "file_sd_configs", "textfile collector", "@keeb/prometheus", "@user/monitoring/agent", "@user/monitoring/hub", "setup-monitoring", "configure-monitoring", "setup-game-metrics".
---

# @keeb/prometheus

Swamp extension that installs monitoring agents on remote Alpine VMs over SSH
and registers those VMs as Prometheus scrape targets on a central monitoring
hub. Two models, three workflows. Depends on `@keeb/ssh` (only for the shared
helper module — no model wiring required).

## Models

### `@user/monitoring/agent`

Installs and configures `node_exporter` (host metrics on `:9100`) and `promtail`
(log shipper to Loki) on a remote Alpine VM. All operations run over SSH and
assume the target is Alpine with the community apk repo available (the `install`
method enables it idempotently).

#### Global arguments

| Field     | Type   | Required | Default | Description                                 |
| --------- | ------ | -------- | ------- | ------------------------------------------- |
| `sshHost` | string | yes      | —       | SSH hostname or IP of the target VM         |
| `sshUser` | string | no       | `root`  | SSH user (Alpine images typically use root) |

#### Methods

| Method                    | Arguments           | What it does                                                                                                                                          |
| ------------------------- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `install`                 | `vmName`            | Enables Alpine community repo, `apk add prometheus-node-exporter loki-promtail loki-promtail-openrc`, starts node-exporter, verifies `:9100/metrics`  |
| `configure`               | `vmName`, `lokiUrl` | Writes `/etc/loki/promtail-local-config.yaml` for the given Loki push URL, ensures promtail is installed, restarts the native `loki-promtail` service |
| `enableTextfileCollector` | `vmName`            | Creates `/var/lib/node_exporter/textfile_collector`, adds `--collector.textfile.directory` to `/etc/conf.d/node-exporter`, restarts node-exporter     |

`vmName` is used as the resource key and as the `host` label inside the
generated promtail config — keep it stable per host or you will fragment your
metrics across labels.

#### Resources

| Name       | Lifetime | GC | Schema fields                                           |
| ---------- | -------- | -- | ------------------------------------------------------- |
| `install`  | infinite | 10 | `nodeExporterRunning`, `promtailInstalled`, `timestamp` |
| `config`   | infinite | 10 | `lokiUrl`, `promtailConfigured`, `timestamp`            |
| `textfile` | infinite | 10 | `textfileCollectorEnabled`, `timestamp`                 |

### `@user/monitoring/hub`

Talks to a central monitoring hub host that runs Prometheus + Loki. Uses
Prometheus' `file_sd_configs` so registration is just writing a JSON file into a
directory the Prometheus container watches — no API call, no reload.

#### Global arguments

| Field        | Type   | Required | Default | Description                                                  |
| ------------ | ------ | -------- | ------- | ------------------------------------------------------------ |
| `sshHost`    | string | yes      | —       | SSH hostname/IP of the monitoring hub                        |
| `sshUser`    | string | no       | `keeb`  | SSH user on the hub                                          |
| `targetsDir` | string | yes      | —       | Directory Prometheus reads via `file_sd_configs` (host path) |

#### Methods

| Method     | Arguments            | What it does                                                                                                                                          |
| ---------- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `discover` | (none)               | `curl`s `localhost:3100/ready` for Loki and `docker exec prometheus wget -qO- /-/ready` for Prometheus, then writes the hub endpoints into a resource |
| `register` | `vmName`, `targetIp` | Writes `${targetsDir}/${vmName}.json` containing one target on `:9100` with labels `instance=vmName, job=node`. Prometheus auto-picks it up in ~15s   |

`discover` derives `lokiPushUrl = http://${sshHost}:3100/loki/api/v1/push` and
`prometheusUrl = http://${sshHost}:9090` from `sshHost`. Downstream steps that
need the Loki URL should pull it from this resource rather than hardcoding.

#### Resources

| Name     | Lifetime | GC | Schema fields                                                                                        |
| -------- | -------- | -- | ---------------------------------------------------------------------------------------------------- |
| `hub`    | infinite | 10 | `lokiPushUrl`, `prometheusUrl`, `sshHost`, `targetsDir`, `lokiReady`, `prometheusReady`, `timestamp` |
| `target` | infinite | 10 | `success`, `targetFile`, `targetIp`, `timestamp`                                                     |

## Defining instances

```yaml
# definition.yaml — agent instance per target VM
type: "@user/monitoring/agent"
name: monitoringAgent
globalArguments:
  sshHost: 10.0.0.225
  sshUser: root
```

```yaml
# definition.yaml — one hub instance for the central Prometheus/Loki host
type: "@user/monitoring/hub"
name: hancockMonitoring
globalArguments:
  sshHost: 10.0.0.12
  sshUser: keeb
  targetsDir: /storage/02/linux/docker/prometheus/targets
```

`sshHost` for the agent is typically not known until a VM has been provisioned —
wire it from an upstream model (e.g. a fleet/proxmox lookup) rather than baking
it into the definition. The bundled workflows do this with a `lookup-vm` step.

## Bundled workflows

| Workflow               | Inputs   | Steps                                                                                                                          |
| ---------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `setup-monitoring`     | `vmName` | auth → discover-hub + lookup-vm → install-agents → configure-promtail + register-target                                        |
| `configure-monitoring` | `vmName` | auth → discover-hub + lookup-vm → configure-promtail + register-target (skips install — use when binaries are already present) |
| `setup-game-metrics`   | `vmName` | auth → lookup-vm → enable-textfile (one-time per host)                                                                         |

The workflows reference external model names (`keebDev02`, `fleet`,
`monitoringAgent`, `hancockMonitoring`) — those are model instance names, not
types. `monitoringAgent` and `hancockMonitoring` are the conventional instance
names this extension's workflows expect. `keebDev02` (Proxmox auth) and `fleet`
(VM lookup) are NOT provided by this extension; they must already exist in the
user's repo or workflow planning will fail.

Run a workflow:

```bash
swamp workflow run setup-monitoring --input vmName=infinity
```

## Common patterns

### Wire agent `sshHost` from a fleet lookup

The bundled workflows demonstrate this — the agent's `sshHost` is left unset in
the definition and overridden per-run by data from an upstream `fleet` model. If
`sshHost` is missing or literally the string `"null"` / `"undefined"`, every
method throws `sshHost is required — VM must be running with an IP`.

### Pull `lokiUrl` from the hub's `discover` output

Don't hardcode the Loki push URL in the agent's `configure` arguments — pull it
from the `hub` resource so changing the hub host updates every downstream
consumer.

```yaml
arguments:
  vmName: "${{ inputs.vmName }}"
  lokiUrl: "{{ data.latest('hancockMonitoring', 'hub').attributes.lokiPushUrl }}"
```

### Register first, configure later

`register-target` only depends on `discover-hub` (and `lookup-vm` for the IP).
It does not require the agent to actually be running yet — Prometheus will
simply mark the target down until node-exporter responds. This is fine and is
how `configure-monitoring` works.

### Custom metrics via the textfile collector

After running `enableTextfileCollector` once on a VM, drop `*.prom` files into
`/var/lib/node_exporter/textfile_collector/` on the host. node-exporter exports
them under their declared names with a `node_textfile_*` prefix. Use this for
game-server metrics, batch job durations, etc. — anything you can't scrape with
HTTP.

## Gotchas

- **Alpine only.** `install` and `configure` use `apk` and OpenRC (`rc-update`,
  `service`). Anything Debian/Ubuntu/RHEL will fail. The promtail package is
  `loki-promtail` from the Alpine community repo — `install` enables that repo
  for you.
- **`sshHost` validation is intentionally loose.** Only `null`, `undefined`,
  empty strings, and non-strings are rejected. A typo'd hostname will get all
  the way to `ssh` and fail there with a less friendly error.
- **SSH uses `StrictHostKeyChecking=no` and `UserKnownHostsFile=/dev/null`.**
  Fine for ephemeral VMs in a trusted network; do NOT point these models at
  hosts on an untrusted network without changing the helper.
- **`configure` is idempotent and self-installing.** Calling `configure` without
  first calling `install` works — it `apk add`s promtail if missing. The
  two-step split exists so workflows can run them in parallel-with-deps, not
  because `configure` is fragile.
- **`enableTextfileCollector` writes to `/etc/conf.d/node-exporter`** with a
  single `ARGS=` line. The grep guard prevents duplicating the textfile flag,
  but if a pre-existing `ARGS=` line already sets other flags, the textfile flag
  is appended on a new line and node-exporter may not pick up both. If you have
  customized `ARGS=` manually, edit by hand.
- **`hub.discover` shells `docker exec prometheus`** on the hub. If Prometheus
  isn't running in a container literally named `prometheus`, the readiness check
  fails. Loki, in contrast, is checked via `localhost:3100` and assumes the port
  is exposed on the host.
- **`register` writes the target file as the SSH user.** Make sure that user has
  write access to `targetsDir`. The default user `keeb` is a hint this extension
  was authored against a specific homelab — override it.
- **Targets are hardcoded to port `:9100` and `job: node`.** No support for
  cAdvisor, blackbox exporter, or any other exporter from this model. Extend the
  model or write the JSON yourself for non-node targets.
- **No reload on `register`.** Prometheus' `file_sd_configs` poller picks up new
  files within ~15 seconds. There is no API call and no notification — a long
  `refresh_interval` will delay pickup.
- **Resource keys.** Agent resources are keyed by `vmName`; hub resources use
  the literal key `"hub"` (singleton) for `hub` and `vmName` for `target`. Query
  by these keys when listing later.
- **Dependency on `@keeb/ssh`** is declared in the manifest but only the shared
  helper module (`lib/ssh.ts`) is actually consumed — no SSH model instance is
  required at runtime. The dependency is there so the helper source resolves on
  install.
