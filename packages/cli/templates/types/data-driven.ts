/**
 * Types for data-driven test data files.
 *
 * Keep data types here so they are reusable across explore/ and tests/.
 * Use `type` (not `interface`) — data loaders require index signatures.
 */

/** Row shape for data/users.json */
export type User = {
  id: string;
  role: string;
  expected: number;
};

/** Row shape for data/endpoints.csv (all CSV values are strings) */
export type Endpoint = {
  method: string;
  path: string;
  expected: string;
};

/** Row shape for data/scenarios.yaml */
export type Scenario = {
  id: string;
  description: string;
  method: string;
  path: string;
  expected: number;
};
