/**
 * Glubean API Project Tests
 *
 * Tests the project CRUD endpoints of the Glubean server.
 *
 * Prerequisites:
 * - Glubean server running at BASE_URL (default: http://localhost:3002)
 * - API_KEY set in .env.secrets (see .env.example for instructions)
 *
 * Run with:
 *   cd examples/glubean-api && deno task test:project
 */

import ky, { type KyInstance } from "npm:ky";
import { test } from "@glubean/sdk";

/**
 * Create a ky client for API requests
 */
function createClient(
  ctx: { vars: { get(key: string): string | undefined }; secrets: { get(key: string): string | undefined } }
): KyInstance {
  const baseUrl = ctx.vars.get("BASE_URL") || "http://localhost:3002";
  const apiKey = ctx.secrets.get("API_KEY");

  return ky.create({
    prefixUrl: baseUrl,
    headers: {
      "Content-Type": "application/json",
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    // Don't throw on non-2xx responses - we want to check status codes
    throwHttpErrors: false,
  });
}

/**
 * Test: List projects
 * Expected: Should return array of projects
 */
export const listProjects = test(
  {
    id: "project-list",
    name: "List all projects",
    tags: ["project", "read"],
  },
  async (ctx) => {
    const apiKey = ctx.secrets.get("API_KEY");

    if (!apiKey) {
      ctx.log("⚠️ Skipping: API_KEY not set in .env.secrets");
      ctx.assert(true, "Test skipped - no API key");
      return;
    }

    const baseUrl = ctx.vars.get("BASE_URL") || "http://localhost:3002";
    ctx.log(`Listing projects at: ${baseUrl}/projects`);

    const client = createClient(ctx);

    const startTime = Date.now();
    const res = await client.get("projects");
    const duration = Date.now() - startTime;
    const data = await res.json();

    ctx.trace({
      method: "GET",
      url: `${baseUrl}/projects`,
      status: res.status,
      duration,
      responseBody: data,
    });

    ctx.assert(res.status === 200, "Projects endpoint should return 200", {
      actual: res.status,
      expected: 200,
    });

    ctx.assert(Array.isArray(data), "Response should be an array");
    ctx.log(`Found ${(data as any[]).length} projects`);

    if ((data as any[]).length > 0) {
      ctx.log("First project:", (data as any[])[0]);
    }
  }
);

/**
 * Test: Create, read, and delete a project (full lifecycle)
 * This is a comprehensive test that validates the entire CRUD flow.
 */
export const projectLifecycle = test(
  {
    id: "project-lifecycle",
    name: "Project CRUD lifecycle",
    tags: ["project", "crud", "integration"],
  },
  async (ctx) => {
    const apiKey = ctx.secrets.get("API_KEY");

    if (!apiKey) {
      ctx.log("⚠️ Skipping: API_KEY not set in .env.secrets");
      ctx.assert(true, "Test skipped - no API key");
      return;
    }

    const baseUrl = ctx.vars.get("BASE_URL") || "http://localhost:3002";
    const testProjectName = `Test Project ${Date.now()}`;
    const client = createClient(ctx);

    // ===== 1. CREATE =====
    ctx.log("Creating project:", testProjectName);

    const createStart = Date.now();
    const createRes = await client.post("projects", {
      json: {
        name: testProjectName,
        description: "Created by Glubean E2E test",
      },
    });
    const createDuration = Date.now() - createStart;
    const createData = await createRes.json();

    ctx.trace({
      method: "POST",
      url: `${baseUrl}/projects`,
      status: createRes.status,
      duration: createDuration,
      requestBody: { name: testProjectName, description: "Created by Glubean E2E test" },
      responseBody: createData,
    });

    ctx.assert(createRes.status >= 200 && createRes.status < 300, "Create project should return 2xx", {
      actual: createRes.status,
      expected: "2xx",
    });

    ctx.log("Created project:", createData);

    ctx.assert(!!(createData as any).id, "Created project should have an ID");
    ctx.assert(
      (createData as any).name === testProjectName,
      "Created project name should match",
      { actual: (createData as any).name, expected: testProjectName }
    );

    const projectId = (createData as any).id;

    // ===== 2. READ =====
    ctx.log("Reading project:", projectId);

    const getStart = Date.now();
    const getRes = await client.get(`projects/${projectId}`);
    const getDuration = Date.now() - getStart;
    const getData = await getRes.json();

    ctx.trace({
      method: "GET",
      url: `${baseUrl}/projects/${projectId}`,
      status: getRes.status,
      duration: getDuration,
      responseBody: getData,
    });

    ctx.assert(getRes.status === 200, "Get project should return 200", {
      actual: getRes.status,
      expected: 200,
    });

    ctx.assert(
      (getData as any).id === projectId,
      "Fetched project ID should match",
      { actual: (getData as any).id, expected: projectId }
    );

    // ===== 3. UPDATE =====
    const updatedName = `${testProjectName} - Updated`;
    ctx.log("Updating project to:", updatedName);

    const updateStart = Date.now();
    const updateRes = await client.put(`projects/${projectId}`, {
      json: {
        name: updatedName,
      },
    });
    const updateDuration = Date.now() - updateStart;
    const updateData = await updateRes.json();

    ctx.trace({
      method: "PUT",
      url: `${baseUrl}/projects/${projectId}`,
      status: updateRes.status,
      duration: updateDuration,
      requestBody: { name: updatedName },
      responseBody: updateData,
    });

    ctx.assert(updateRes.status === 200, "Update project should return 200", {
      actual: updateRes.status,
      expected: 200,
    });

    ctx.assert(
      (updateData as any).name === updatedName,
      "Updated project name should match",
      { actual: (updateData as any).name, expected: updatedName }
    );

    // ===== 4. DELETE =====
    ctx.log("Deleting project:", projectId);

    const deleteStart = Date.now();
    const deleteRes = await client.delete(`projects/${projectId}`);
    const deleteDuration = Date.now() - deleteStart;

    ctx.trace({
      method: "DELETE",
      url: `${baseUrl}/projects/${projectId}`,
      status: deleteRes.status,
      duration: deleteDuration,
    });

    ctx.assert(deleteRes.status >= 200 && deleteRes.status < 300, "Delete project should return 2xx", {
      actual: deleteRes.status,
      expected: "2xx",
    });

    // ===== 5. VERIFY DELETION =====
    ctx.log("Verifying project is deleted...");

    const verifyRes = await client.get(`projects/${projectId}`);

    ctx.assert(
      verifyRes.status === 404,
      "Deleted project should return 404",
      { actual: verifyRes.status, expected: 404 }
    );

    ctx.log("✅ Project lifecycle test completed successfully!");
  }
);

/**
 * Test: Access project without auth
 * Expected: Should return 401
 */
export const projectNoAuth = test(
  {
    id: "project-no-auth",
    name: "Project endpoint requires auth",
    tags: ["project", "security"],
  },
  async (ctx) => {
    const baseUrl = ctx.vars.get("BASE_URL") || "http://localhost:3002";
    ctx.log(`Testing projects endpoint without auth: ${baseUrl}/projects`);

    // Create client without auth
    const client = ky.create({
      prefixUrl: baseUrl,
      throwHttpErrors: false,
    });

    const startTime = Date.now();
    const res = await client.get("projects");
    const duration = Date.now() - startTime;

    ctx.trace({
      method: "GET",
      url: `${baseUrl}/projects`,
      status: res.status,
      duration,
    });

    ctx.assert(
      res.status === 401,
      "Projects endpoint should return 401 without auth",
      { actual: res.status, expected: 401 }
    );
  }
);
