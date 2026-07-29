export interface ToolTelemetryContext {
  telemetryEnabled?: boolean;
}

export function writeToolTelemetry(
  ctx: ToolTelemetryContext,
  writer: () => void,
): boolean {
  if (ctx.telemetryEnabled === false) return false;
  writer();
  return true;
}
