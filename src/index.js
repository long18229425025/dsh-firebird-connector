import { AuditLog, Redactor } from './audit.js'
import { loadConfig } from './config.js'
import { ConfirmationStore } from './confirmations.js'
import { ConnectionManager } from './driver.js'
import { createLogger } from './logger.js'
import { MetadataService } from './metadata.js'
import { buildTools } from './tools/index.js'
import { auditArgumentFailures } from './tools/shared.js'

export const name = 'firebird-connector'
export const inject = ['tools']

/**
 * dsh bundle entry point. Connections open lazily, every tool call is audited,
 * and unloading the plugin closes all connections and fsyncs the audit log.
 */
export function apply(ctx, rawConfig) {
  const config = loadConfig(rawConfig ?? {})
  const redactor = new Redactor()
  const audit = new AuditLog(config.auditFile, { redactor })
  audit.open()
  const log = createLogger(ctx, config.logLevel, (value) => redactor.redact(value))

  let credentials
  try {
    credentials = ctx.get('credentials')
  } catch {
    credentials = undefined
  }

  const manager = new ConnectionManager({ config, credentials, audit, log })
  const metadata = new MetadataService({ manager, log })
  const confirmations = new ConfirmationStore()
  const context = { config, manager, metadata, audit, log, credentials, confirmations }

  ctx.effect(() => async () => {
    try {
      await manager.dispose()
    } finally {
      confirmations.clear()
      audit.close()
    }
  })

  for (const tool of buildTools(context)) {
    ctx.tools.register(auditArgumentFailures(tool, audit))
  }

  log.debug(
    `registered ${config.connectionNames.length} Firebird connection(s) and 13 tool(s); audit log ${config.auditFile}`,
  )
}
