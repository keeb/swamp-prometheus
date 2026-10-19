/**
 * Input validation shared by the @keeb/prometheus models. Every value a model
 * interpolates into a remote shell command or a generated config file must
 * pass one of these patterns, so it cannot break out of a quoted heredoc,
 * start a new shell word, or inject YAML/JSON structure.
 */
import { z } from "npm:zod@4";

/** VM / instance name: letters, digits, `.`, `_`, `-`; no leading punctuation. */
export const VM_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;

/**
 * http(s) URL made only of URL-safe characters: no whitespace, quotes,
 * backslashes, `$`, backticks, `#` or newlines.
 */
export const HTTP_URL_RE = /^https?:\/\/[A-Za-z0-9._~:/?&=%[\]@+-]+$/;

/** Hostname or IPv4/IPv6 literal usable as a Prometheus scrape target host. */
export const TARGET_HOST_RE =
  /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*|\[[0-9A-Fa-f:.]+\])$/;

/** Prometheus scrape job name accepted by removeScrapeJob. */
export const JOB_NAME_RE = /^[A-Za-z0-9_.:-]{1,128}$/;

/** Zod schema for a VM name argument. */
export const VmName = z.string().regex(
  VM_NAME_RE,
  "vmName must be letters, digits, '.', '_' or '-' (max 63 chars)",
);

/** Throws unless `path` is a non-empty absolute path without NUL or newlines. */
export function assertAbsPath(label: string, path: unknown): string {
  if (
    typeof path !== "string" || !path.startsWith("/") || /[\0\n\r]/.test(path)
  ) {
    throw new Error(
      `${label} ${JSON.stringify(path)} must be an absolute path`,
    );
  }
  return path;
}

/** Single-quotes `value` for a POSIX shell. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
