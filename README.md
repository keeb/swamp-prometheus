# @keeb/prometheus

[Swamp](https://github.com/systeminit/swamp) extension for monitoring agent installation and Prometheus target registration.

## Models

### `monitoring/agent`

Install and configure monitoring agents (node_exporter, promtail) on a remote host over SSH.

| Method | Description |
|--------|-------------|
| `install` | Install node_exporter and promtail packages |
| `configure` | Configure promtail to ship logs to Loki, set up node_exporter |
| `enableTextfileCollector` | Enable the node_exporter textfile collector directory for custom metrics |

### `monitoring/hub`

Register monitoring targets with a Prometheus server.

| Method | Description |
|--------|-------------|
| `discover` | List currently registered Prometheus targets |
| `register` | Register a new scrape target with Prometheus |

## Workflows

| Workflow | Description |
|----------|-------------|
| `setup-monitoring` | Full monitoring setup: install agents + configure wiring + register with Prometheus |
| `configure-monitoring` | Configure monitoring wiring (promtail, Prometheus target registration) |
| `setup-game-metrics` | Enable node_exporter textfile collector on a game server VM |

## Dependencies

- [@keeb/ssh](https://github.com/keeb/swamp-ssh) — SSH helpers (`lib/ssh.ts`)

## Used by

- [swamp-minecraft](https://github.com/keeb/swamp-minecraft) — Game server metrics collection

## Install

```bash
swamp extension pull @keeb/prometheus
```

## License

MIT
