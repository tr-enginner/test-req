import type { DtpBusAdapter, DtpBusType } from "./types"

function passthroughAdapter(
  id: string,
  busType: DtpBusType,
  aliases: readonly string[],
  pattern: RegExp,
): DtpBusAdapter {
  return {
    id,
    busType,
    aliases,
    fallbackPolicies: [],
    matchesEvidence: (text) => pattern.test(text),
  }
}

// These adapters preserve existing bus detection while leaving protocol-specific
// behavior on the generic writer until a dedicated adapter is implemented.
export const rs422BusAdapter = passthroughAdapter("rs422", "RS422", ["RS422", "RS-422"], /\bRS\s*[-_]?\s*422\b/i)
export const uartBusAdapter = passthroughAdapter("uart", "UART", ["UART", "串口"], /\bUART\b|串口/i)
export const mil1553BusAdapter = passthroughAdapter("1553b", "1553B", ["1553B"], /\b1553B\b/i)
