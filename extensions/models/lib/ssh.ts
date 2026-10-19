/**
 * SSH helpers shared across the @keeb/prometheus models.
 *
 * Both helpers spawn the local `ssh` client. Every value that becomes an
 * argument to the `ssh` binary is validated first: the host and user must be
 * plain hostnames / IP literals / POSIX user names, so neither can start with
 * `-` and be read as an ssh option (e.g. `-oProxyCommand=...`). The remote
 * command string is built by the calling model, which validates every value
 * it interpolates into it.
 */

/** Hostname (RFC 1123 labels), IPv4 literal, or bare IPv6 literal. */
const SSH_HOST_RE =
  /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*|[0-9A-Fa-f:]*:[0-9A-Fa-f:.]*)$/;

/** POSIX-ish user name: letter or underscore first, no leading `-`. */
const SSH_USER_RE = /^[A-Za-z_][A-Za-z0-9_.-]{0,31}$/;

/** Result of running a remote command over SSH. */
export interface SshResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Returns true when `host` is a usable SSH destination host: a non-empty
 * hostname or IP literal that cannot be mistaken for an ssh option. The
 * literal strings "null" and "undefined" (unresolved CEL values) are rejected.
 */
export function isValidSshHost(host: unknown): host is string {
  if (typeof host !== "string" || host.length === 0) return false;
  if (host === "null" || host === "undefined") return false;
  if (host.length > 253) return false;
  return SSH_HOST_RE.test(host);
}

/** Returns true when `user` is a safe SSH login name. */
export function isValidSshUser(user: unknown): user is string {
  return typeof user === "string" && SSH_USER_RE.test(user);
}

/** Throws a descriptive error unless host and user are both valid. */
export function assertSshTarget(host: unknown, user: unknown): void {
  if (!isValidSshHost(host)) {
    throw new Error(
      `Invalid sshHost ${
        JSON.stringify(host)
      }: expected a hostname or IP address (is the VM running with an IP?)`,
    );
  }
  if (!isValidSshUser(user)) {
    throw new Error(
      `Invalid sshUser ${JSON.stringify(user)}: expected a plain user name`,
    );
  }
}

/** Builds the argument vector passed to the local `ssh` binary. */
export function buildSshArgs(
  host: string,
  user: string,
  command: string,
): string[] {
  return [
    "-o",
    "StrictHostKeyChecking=no",
    "-o",
    "UserKnownHostsFile=/dev/null",
    "-o",
    "ConnectTimeout=10",
    `${user}@${host}`,
    command,
  ];
}

/**
 * Runs `command` on `user@host` and returns its exit code and output without
 * throwing on a non-zero exit. Throws only when host/user fail validation.
 */
export async function sshExecRaw(
  host: string,
  user: string,
  command: string,
): Promise<SshResult> {
  assertSshTarget(host, user);
  // swamp-quality-ignore deno-command: ssh is the transport for every method; host and user are validated above
  const proc = new Deno.Command("ssh", {
    args: buildSshArgs(host, user, command),
    stdin: "null",
  });
  const result = await proc.output();
  const stdout = new TextDecoder().decode(result.stdout);
  const stderr = new TextDecoder().decode(result.stderr);
  return { code: result.code, stdout, stderr };
}

/**
 * Runs `command` on `user@host` and throws when it exits non-zero. The error
 * names the target and includes the tail of stderr.
 */
export async function sshExec(
  host: string,
  user: string,
  command: string,
): Promise<SshResult> {
  const result = await sshExecRaw(host, user, command);
  if (result.code !== 0) {
    throw new Error(
      `SSH command on ${user}@${host} failed (exit ${result.code}): ${
        (result.stderr || result.stdout).slice(-500)
      }`,
    );
  }
  return result;
}
