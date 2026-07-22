// SB-4: template:echo returns load_error in a clean clone because server/router.ts
// imports hono, which is hoisted only under packages/orchestrator/node_modules while extensions/* are not root workspace members.
import type { ApiResponse, ToolCallResult, ToolsEnvelope } from '../lib/api.ts';
import {
  assertGolden,
  type GoldenCaseDefinition,
} from './_template.ts';

const LIST_STEP = 'GET /api/tools';
const PROBE_STEP = 'POST configured probe tool';

export interface SmokeToolsListCaseDefinition extends GoldenCaseDefinition {
  probeTool: string;
}

const definition: SmokeToolsListCaseDefinition = {
  name: 'smoke-tools-list',
  description: 'Deterministic tool catalog and read-only probe smoke test.',
  modes: ['l4a'],
  probeTool: 'lowpoly:projects.list',
  steps: [
    {
      name: LIST_STEP,
      async run(ctx) {
        const response = await ctx.api.getTools();
        const tools = Array.isArray(response.body?.tools) ? response.body.tools : [];
        return {
          value: response,
          evidence: {
            status: response.status,
            toolCount: tools.length,
            exposedToAICount: tools.filter((tool) => tool.exposedToAI === true).length,
          },
        };
      },
    },
    {
      name: PROBE_STEP,
      async run(ctx) {
        const response = await ctx.api.callTool({
          toolId: definition.probeTool,
          args: {},
          caller: { kind: 'user' },
        });
        return {
          value: response,
          evidence: {
            toolId: definition.probeTool,
            status: response.status,
            ok: response.body?.ok === true,
            resultIsArray: Array.isArray(response.body?.result),
          },
        };
      },
    },
  ],
  asserts: [
    {
      name: 'tool catalog is HTTP 200',
      check(_ctx, state) {
        const response = state.value<ApiResponse<ToolsEnvelope>>(LIST_STEP);
        assertGolden(
          response.status === 200,
          `GET /api/tools returned HTTP ${response.status}, expected 200`,
          { status: response.status, body: response.body },
        );
        return { status: response.status };
      },
    },
    {
      name: 'tool catalog exposes at least one AI tool',
      check(_ctx, state) {
        const response = state.value<ApiResponse<ToolsEnvelope>>(LIST_STEP);
        const tools = Array.isArray(response.body?.tools) ? response.body.tools : [];
        const exposed = tools.filter((tool) => tool.exposedToAI === true);
        assertGolden(
          exposed.length >= 1,
          'GET /api/tools contained no exposedToAI:true tool',
          { toolCount: tools.length },
        );
        return {
          exposedToAICount: exposed.length,
          sampleIds: exposed.slice(0, 5).map((tool) => tool.id),
        };
      },
    },
    {
      name: 'configured probe returns an array',
      check(_ctx, state) {
        const response = state.value<ApiResponse<ToolCallResult>>(PROBE_STEP);
        assertGolden(
          response.status === 200,
          `POST /api/tools/call returned HTTP ${response.status}, expected 200`,
          { status: response.status, body: response.body },
        );
        assertGolden(
          response.body?.ok === true,
          `${definition.probeTool} returned ok:false`,
          response.body,
        );
        assertGolden(
          Array.isArray(response.body.result),
          `${definition.probeTool} result was not an array`,
          { actual: response.body.result },
        );
        return {
          ok: true,
          toolId: definition.probeTool,
          resultCount: response.body.result.length,
        };
      },
    },
  ],
};

export default definition;
