# @keeb/prometheus

[Swamp](https://github.com/systeminit/swamp) extension for monitoring agent installation and Prometheus target registration.

## Models

### `monitoring/agent`

Install and configure monitoring agents (node_exporter, promtail) on a remote Alpine host over SSH.

| Method | Description |
|--------|-------------|
| `install` | Install node_exporter and promtail packages |
| `configure` | Configure promtail to ship logs to Loki and start it |
| `enableTextfileCollector` | Enable the node_exporter textfile collector directory for custom metrics |

### `monitoring/hub`

Validate the Prometheus/Loki hub and manage its scrape targets.

| Method | Description |
|--------|-------------|
| `discover` | Check Loki and Prometheus readiness and record their endpoints |
| `register` | Register a VM as a scrape target via a `file_sd_configs` JSON file |
| `inspect` | Record active targets and the live scrape config from the Prometheus API |
| `reload` | Send SIGHUP to the `prometheus` container |
| `removeScrapeJob` | Remove a `job_name` block from the live `prometheus.yml` (backup, `promtool` check, reload, restore on failure) |

## Workflows

| Workflow | Description |
|----------|-------------|
| `setup-monitoring` | Full monitoring setup: install agents + configure wiring + register with Prometheus |
| `configure-monitoring` | Configure monitoring wiring (promtail, Prometheus target registration) |
| `setup-game-metrics` | Enable node_exporter textfile collector on a game server VM |

## Subprocess use (SSH)

Every method works by running the local `ssh` client (`Deno.Command("ssh", ...)`
in `extensions/models/lib/ssh.ts`) against the target VM or monitoring hub.
There is no swamp primitive for remote shell access, so this is required.

- The `ssh` binary must be on `PATH`, and key-based auth (agent or default key)
  must work non-interactively for `sshUser@sshHost`.
- Arguments passed to `ssh` are fixed options plus `user@host` and one remote
  command string. `sshHost` must be a hostname or IP literal and `sshUser` a
  plain user name; neither can begin with `-`, so they cannot be read as ssh
  options. Invalid values fail before any process is spawned.
- Every value interpolated into the remote command is validated by the method's
  argument schema (`vmName`, `lokiUrl`, `targetIp`, `jobName`) or shell-quoted
  (`targetsDir`, the `prometheus.yml` path).
- Host keys are not verified (`StrictHostKeyChecking=no`,
  `UserKnownHostsFile=/dev/null`). Only use these models on a trusted network.

## Dependencies

- [@keeb/ssh](https://github.com/keeb/swamp-ssh) — SSH helpers (`lib/ssh.ts`)

## Used by

- [swamp-minecraft](https://github.com/keeb/swamp-minecraft) — Game server metrics collection

## Install

```bash
swamp extension pull @keeb/prometheus
```

## Example

Install node_exporter + promtail on an Alpine VM, then register it as a scrape target:

```yaml
models:
  - name: agent
    type: "@keeb/monitoring/agent"
    globalArguments:
      sshHost: "192.0.2.42"
      sshUser: "root"
  - name: hub
    type: "@keeb/monitoring/hub"
    globalArguments:
      sshHost: "monitoring.example.com"
      sshUser: "prometheus"
      targetsDir: "/etc/prometheus/targets"

jobs:
  - name: onboard-vm
    steps:
      - model: agent
        method: install
        inputs: { vmName: "web01" }
      - model: agent
        method: configure
        inputs:
          vmName: "web01"
          lokiUrl: "http://monitoring.example.com:3100/loki/api/v1/push"
      - model: hub
        method: register
        inputs:
          vmName: "web01"
          targetIp: "192.0.2.42"
```

## License

MIT
