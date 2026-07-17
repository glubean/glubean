const colors = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  yellow: "\x1b[33m",
}

export interface ProjectionInventory {
  tests: number
  contracts: number
  workflows: number
  files?: number
  warnings?: number
}

/** Shared declaration inventory used by scan, dry-run, sync, and validation. */
export function formatProjectionInventory(
  title: string,
  inventory: ProjectionInventory,
  options: { hintWhenNoWorkflows?: boolean } = {},
): string {
  const rows: Array<[string, number]> = [
    ["Tests", inventory.tests],
    ["Contracts", inventory.contracts],
    ["Workflows", inventory.workflows],
  ]
  if (inventory.files !== undefined) rows.unshift(["Files", inventory.files])
  if (inventory.warnings !== undefined) rows.push(["Warnings", inventory.warnings])

  const lines = [
    `${colors.bold}${title}${colors.reset}`,
    ...rows.map(([label, count]) => `  ${label.padEnd(10)} ${String(count).padStart(5)}`),
  ]
  if (options.hintWhenNoWorkflows && inventory.workflows === 0) {
    lines.push(
      `${colors.yellow}  ! No workflows discovered.${colors.reset} ${colors.dim}Expected exported workflow() declarations in *.workflow.ts (or legacy *.flow.ts).${colors.reset}`,
    )
  }
  return lines.join("\n")
}
