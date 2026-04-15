/**
 * OpenTelemetry + Langfuse telemetry module for Paperclip server.
 *
 * Phase 1A of DEV-269: standalone module, no wire-up to heartbeat yet.
 *
 * Exports:
 *  - initTelemetry(): idempotent init, reads env, sets up NodeSDK with
 *    BatchSpanProcessors for Langfuse and/or OTel OTLP HTTP exporters.
 *  - getTracer(): returns a Tracer for `paperclip.server`. Safe to call
 *    before init (no-op tracer) — OTel's global trace API handles that.
 *  - redactAttrs(): shallow-clones an attribute bag, redacts sensitive
 *    keys, and truncates oversized string values.
 *
 * NOTE: this file intentionally lives at `otel.ts` (not `telemetry.ts`)
 * to avoid colliding with the existing `telemetry.ts` module, which
 * owns the opt-in usage telemetry client (`@paperclipai/shared/telemetry`).
 * Rename/merge is deliberately deferred to a later phase.
 */

import { trace, type Tracer } from "@opentelemetry/api";
import { logger } from "./middleware/logger.js";

// OTel SDK modules are imported dynamically inside initTelemetry() so that
// `getTracer()` and `redactAttrs()` can be used in environments where the SDK
// is intentionally disabled (kill switch) without paying the import cost.

const TRACER_NAME = "paperclip.server";
const TRACER_VERSION = "1.0.0";
const MAX_ATTR_STRING_BYTES = 4 * 1024; // 4KB
const REDACTED = "[REDACTED]";
const SENSITIVE_KEY_RE =
  /^(authorization|api[-_]?key|token|password|secret|bearer|jwt|pat|x-api-key)$/i;

let initialized = false;
let sdk: { shutdown: () => Promise<void> } | null = null;

export function getTracer(): Tracer {
  return trace.getTracer(TRACER_NAME, TRACER_VERSION);
}

export function redactAttrs<T extends Record<string, unknown>>(attrs: T): T {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (SENSITIVE_KEY_RE.test(key)) {
      out[key] = REDACTED;
      continue;
    }
    if (typeof value === "string") {
      const byteLen = Buffer.byteLength(value, "utf8");
      if (byteLen > MAX_ATTR_STRING_BYTES) {
        const head = value.slice(0, MAX_ATTR_STRING_BYTES);
        out[key] = `${head}…[+${byteLen - MAX_ATTR_STRING_BYTES}b truncated]`;
        continue;
      }
    }
    out[key] = value;
  }
  return out as T;
}

function parseHeaders(raw: string | undefined): Record<string, string> | undefined {
  if (!raw) return undefined;
  const out: Record<string, string> = {};
  for (const pair of raw.split(",")) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const k = trimmed.slice(0, eq).trim();
    const v = trimmed.slice(eq + 1).trim();
    if (k) out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function langfuseAuthHeader(publicKey: string, secretKey: string): string {
  const token = Buffer.from(`${publicKey}:${secretKey}`).toString("base64");
  return `Basic ${token}`;
}

/**
 * Initialize OTel SDK. Idempotent — subsequent calls are no-ops.
 * Never throws; logs a warning on failure.
 */
export function initTelemetry(): void {
  if (initialized) return;
  initialized = true;

  const enabledEnv = process.env.PAPERCLIP_TELEMETRY_ENABLED;
  const enabled = enabledEnv === undefined ? true : enabledEnv.toLowerCase() !== "false";
  if (!enabled) {
    logger.info("[otel] PAPERCLIP_TELEMETRY_ENABLED=false — telemetry disabled");
    return;
  }

  (async () => {
    try {
      const [
        { NodeSDK },
        { BatchSpanProcessor },
        { OTLPTraceExporter },
        resourcesMod,
        semconv,
      ] = await Promise.all([
        import("@opentelemetry/sdk-node"),
        import("@opentelemetry/sdk-trace-base"),
        import("@opentelemetry/exporter-trace-otlp-http"),
        import("@opentelemetry/resources"),
        import("@opentelemetry/semantic-conventions"),
      ]);

      const langfuseHost =
        process.env.LANGFUSE_HOST?.trim() ||
        "https://agent-observability.devfellowship.com";
      const langfusePub = process.env.LANGFUSE_PUBLIC_KEY?.trim();
      const langfuseSec = process.env.LANGFUSE_SECRET_KEY?.trim();

      const otelEndpoint =
        process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim() ||
        "https://otel.devfellowship.com";
      const otelHeaders = parseHeaders(process.env.OTEL_EXPORTER_OTLP_HEADERS);

      const processors: unknown[] = [];

      if (langfusePub && langfuseSec) {
        const lfExporter = new OTLPTraceExporter({
          url: `${langfuseHost.replace(/\/+$/, "")}/api/public/otel/v1/traces`,
          headers: {
            Authorization: langfuseAuthHeader(langfusePub, langfuseSec),
          },
        });
        processors.push(new BatchSpanProcessor(lfExporter));
        logger.info({ host: langfuseHost }, "[otel] Langfuse exporter configured");
      } else {
        logger.info(
          "[otel] Langfuse credentials missing (LANGFUSE_PUBLIC_KEY/LANGFUSE_SECRET_KEY) — skipping Langfuse exporter",
        );
      }

      if (otelEndpoint) {
        const otlpExporter = new OTLPTraceExporter({
          url: otelEndpoint.replace(/\/+$/, "") + "/v1/traces",
          headers: otelHeaders,
        });
        processors.push(new BatchSpanProcessor(otlpExporter));
        logger.info({ endpoint: otelEndpoint }, "[otel] OTLP exporter configured");
      }

      if (processors.length === 0) {
        logger.warn("[otel] no exporters configured — skipping SDK start");
        return;
      }

      const serviceVersion = process.env.PAPERCLIP_VERSION ?? "1.0.0";
      const environment = process.env.NODE_ENV ?? "production";

      const semconvAny = semconv as unknown as Record<string, string>;
      const ATTR_SERVICE_NAME = semconvAny.ATTR_SERVICE_NAME ?? "service.name";
      const ATTR_SERVICE_VERSION = semconvAny.ATTR_SERVICE_VERSION ?? "service.version";
      const ATTR_DEPLOYMENT_ENVIRONMENT =
        semconvAny.ATTR_DEPLOYMENT_ENVIRONMENT ?? "deployment.environment";

      const resAttrs: Record<string, string> = {
        [ATTR_SERVICE_NAME]: "paperclip-server",
        [ATTR_SERVICE_VERSION]: serviceVersion,
        [ATTR_DEPLOYMENT_ENVIRONMENT]: environment,
      };
      // Support both 1.x (`new Resource(attrs)`) and 2.x (`resourceFromAttributes`).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const resMod = resourcesMod as any;
      const resource =
        typeof resMod.resourceFromAttributes === "function"
          ? resMod.resourceFromAttributes(resAttrs)
          : new resMod.Resource(resAttrs);

      const nodeSdk = new NodeSDK({
        resource,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        spanProcessors: processors as any,
      });

      nodeSdk.start();
      sdk = nodeSdk;

      logger.info(
        { exporters: processors.length, version: serviceVersion, env: environment },
        "[otel] telemetry initialized",
      );

      const shutdown = async () => {
        try {
          await nodeSdk.shutdown();
          logger.info("[otel] telemetry flushed on shutdown");
        } catch (err) {
          logger.warn({ err }, "[otel] shutdown failed");
        }
      };
      process.once("SIGTERM", () => void shutdown());
    } catch (err) {
      logger.warn({ err }, "[otel] init failed, continuing without telemetry");
    }
  })();
}

// Testing utility — resets the module-local singleton state. Not exported
// through the public contract but callable via the compiled module.
export function __resetForTests(): void {
  initialized = false;
  sdk = null;
}
