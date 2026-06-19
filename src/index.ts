#!/usr/bin/env node
/**
 * rybbit-mcp — an MCP server exposing Rybbit Analytics as tools for Claude.
 *
 * Configure via environment variables:
 *   RYBBIT_URL     Base URL of your Rybbit instance (e.g. https://app.rybbit.io
 *                   or your self-hosted URL). Required.
 *   RYBBIT_API_KEY Rybbit API key (Settings -> Account -> API Keys). Required.
 *
 * Transport: stdio (suitable for Claude Desktop / Claude Code / any local MCP client).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import express from "express";
import { z } from "zod";
import { RybbitApiError, RybbitClient, type FilterObject } from "./rybbit-client.js";

const RYBBIT_URL = process.env.RYBBIT_URL;
const RYBBIT_API_KEY = process.env.RYBBIT_API_KEY;

if (!RYBBIT_URL || !RYBBIT_API_KEY) {
  console.error(
    "[rybbit-mcp] Missing required environment variables.\n" +
      "  RYBBIT_URL     - base URL of your Rybbit instance (e.g. https://app.rybbit.io)\n" +
      "  RYBBIT_API_KEY - your Rybbit API key (Settings -> Account -> API Keys)\n"
  );
  process.exit(1);
}

const client = new RybbitClient({ baseUrl: RYBBIT_URL, apiKey: RYBBIT_API_KEY });

const server = new McpServer({
  name: "rybbit-mcp",
  version: "0.1.0",
});

// ---------- shared schema fragments ----------

const timeParamsShape = {
  start_date: z
    .string()
    .optional()
    .describe("Start date, e.g. 2024-01-01. Use with end_date and time_zone."),
  end_date: z
    .string()
    .optional()
    .describe("End date, e.g. 2024-01-31. Use with start_date and time_zone."),
  time_zone: z
    .string()
    .optional()
    .describe("IANA time zone, e.g. America/New_York. Required when using start_date/end_date or start_datetime/end_datetime."),
  start_datetime: z
    .string()
    .optional()
    .describe("Exact start datetime, e.g. '2024-01-15 13:00:00' (UTC). Alternative to start_date."),
  end_datetime: z
    .string()
    .optional()
    .describe("Exact end datetime, e.g. '2024-01-15 15:00:00' (UTC). Alternative to end_date."),
  past_minutes_start: z
    .number()
    .optional()
    .describe("Relative range start in minutes ago, e.g. 60. Use with past_minutes_end instead of dates."),
  past_minutes_end: z
    .number()
    .optional()
    .describe("Relative range end in minutes ago, e.g. 0 for 'now'. Use with past_minutes_start."),
};

const filterSchema = z.object({
  parameter: z
    .string()
    .describe(
      "Field to filter on, e.g. country, device_type, pathname, browser, referrer, channel, utm_source, event_name."
    ),
  type: z.enum([
    "equals",
    "not_equals",
    "contains",
    "not_contains",
    "regex",
    "not_regex",
    "greater_than",
    "less_than",
  ]),
  value: z
    .array(z.union([z.string(), z.number()]))
    .describe("Value(s) to match. Multiple values are OR'd together for the same filter."),
});

const filtersParam = z
  .array(filterSchema)
  .optional()
  .describe(
    "Optional list of filters to narrow the data (AND logic across different filters). Example: " +
      '[{"parameter":"country","type":"equals","value":["US"]}]'
  );

const siteIdParam = z
  .union([z.string(), z.number()])
  .describe("The Rybbit site ID (numeric ID from your Rybbit dashboard or the rybbit_list_sites tool).");

function textResult(data: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(data, null, 2),
      },
    ],
  };
}

function errorResult(err: unknown) {
  if (err instanceof RybbitApiError) {
    return {
      content: [
        {
          type: "text" as const,
          text: `Rybbit API error (${err.status}): ${err.message}`,
        },
      ],
      isError: true,
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  return {
    content: [{ type: "text" as const, text: `Error: ${message}` }],
    isError: true,
  };
}

function toFilters(filters?: z.infer<typeof filterSchema>[]): FilterObject[] | undefined {
  return filters as FilterObject[] | undefined;
}

// ---------- tools: discovery ----------

server.registerTool(
  "rybbit_list_sites",
  {
    title: "List Rybbit sites",
    description:
      "List all organizations the authenticated user belongs to, and every site (with its numeric site ID) under each. Call this first if you don't already know a site ID.",
    inputSchema: {},
  },
  async () => {
    try {
      const orgs = await client.listOrganizations();
      return textResult(orgs);
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.registerTool(
  "rybbit_get_site",
  {
    title: "Get Rybbit site details",
    description:
      "Get configuration and details for a single site by ID (name, domain, tracking feature flags, etc.).",
    inputSchema: { site: siteIdParam },
  },
  async ({ site }) => {
    try {
      return textResult(await client.getSite(site));
    } catch (err) {
      return errorResult(err);
    }
  }
);

// ---------- tools: overview ----------

server.registerTool(
  "rybbit_get_overview",
  {
    title: "Get analytics overview",
    description:
      "Get high-level analytics metrics for a site over a time range: sessions, pageviews, unique users, pages per session, bounce rate, and average session duration.",
    inputSchema: {
      site: siteIdParam,
      ...timeParamsShape,
      filters: filtersParam,
    },
  },
  async ({ site, filters, ...time }) => {
    try {
      const data = await client.getOverview(site, { ...time, filters: toFilters(filters) });
      return textResult(data);
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.registerTool(
  "rybbit_get_overview_timeseries",
  {
    title: "Get analytics overview time series",
    description:
      "Get the same metrics as rybbit_get_overview (sessions, pageviews, users, bounce rate, etc.) broken down into time buckets, for charting trends. Choose a bucket size appropriate to the range: 'minute' or 'five_minutes' for the last hour or so, 'hour' for a single day, 'day' for weeks/months, 'week' or 'month' for longer ranges.",
    inputSchema: {
      site: siteIdParam,
      bucket: z
        .enum(["minute", "five_minutes", "hour", "day", "week", "month"])
        .describe("Time bucket size for the series."),
      ...timeParamsShape,
      filters: filtersParam,
    },
  },
  async ({ site, bucket, filters, ...time }) => {
    try {
      const data = await client.getOverviewBucketed(site, {
        ...time,
        bucket,
        filters: toFilters(filters),
      });
      return textResult(data);
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.registerTool(
  "rybbit_get_breakdown",
  {
    title: "Get a dimensional breakdown (top pages, referrers, countries, browsers, etc.)",
    description:
      "Get analytics broken down by a single dimension, ranked by traffic. Use this for questions like " +
      "'what are the top pages', 'where is traffic coming from', 'what countries/browsers/devices do visitors use', " +
      "'what are the top UTM campaigns', etc. Set `parameter` to the dimension to break down by, e.g.: " +
      "pathname, page_title, hostname, referrer, channel, entry_page, exit_page, country, region, city, " +
      "browser, browser_version, operating_system, device_type, language, utm_source, utm_medium, utm_campaign, " +
      "utm_term, utm_content, event_name. Results include visit count, percentage of total, pageviews, and bounce rate per value.",
    inputSchema: {
      site: siteIdParam,
      parameter: z
        .string()
        .describe(
          "Dimension to break down by, e.g. pathname, referrer, country, browser, device_type, utm_source, channel."
        ),
      limit: z.number().optional().describe("Max number of rows to return (default applies if omitted)."),
      page: z.number().optional().describe("Page number for pagination (1-indexed)."),
      ...timeParamsShape,
      filters: filtersParam,
    },
  },
  async ({ site, parameter, limit, page, filters, ...time }) => {
    try {
      const data = await client.getMetric(site, {
        ...time,
        parameter,
        limit,
        page,
        filters: toFilters(filters),
      });
      return textResult(data);
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.registerTool(
  "rybbit_get_live_visitors",
  {
    title: "Get live visitor count",
    description:
      "Get the count of currently active sessions on a site within a recent time window (real-time visitor count).",
    inputSchema: {
      site: siteIdParam,
      minutes: z
        .number()
        .optional()
        .describe(
          "Look-back window in minutes for 'active'. 1 = very active right now, 5 = standard live count (default), 15 = recently active, 30 = short-term engagement."
        ),
    },
  },
  async ({ site, minutes }) => {
    try {
      const data = await client.getLiveUserCount(site, minutes);
      return textResult(data);
    } catch (err) {
      return errorResult(err);
    }
  }
);

// ---------- tools: sessions ----------

server.registerTool(
  "rybbit_list_sessions",
  {
    title: "List sessions",
    description:
      "Get a paginated list of visitor sessions with details: location, browser/OS/device, referrer, entry/exit pages, pageview and event counts, duration, and UTM params.",
    inputSchema: {
      site: siteIdParam,
      page: z.number().optional().describe("Page number, 1-indexed."),
      limit: z.number().optional().describe("Number of sessions per page."),
      user_id: z.string().optional().describe("Filter to sessions for a specific Rybbit user_id."),
      identified_only: z
        .string()
        .optional()
        .describe("Set to restrict to sessions with an identified user (per Rybbit's identify() API)."),
      ...timeParamsShape,
      filters: filtersParam,
    },
  },
  async ({ site, page, limit, user_id, identified_only, filters, ...time }) => {
    try {
      const data = await client.listSessions(site, {
        ...time,
        page,
        limit,
        user_id,
        identified_only,
        filters: toFilters(filters),
      });
      return textResult(data);
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.registerTool(
  "rybbit_get_session",
  {
    title: "Get session detail",
    description:
      "Get full detail for a single session by ID: session metadata plus the ordered list of pageview/custom events within it.",
    inputSchema: {
      site: siteIdParam,
      session_id: z.string().describe("The session_id, as returned by rybbit_list_sessions."),
      limit: z.number().optional().describe("Max number of events to return."),
      offset: z.number().optional().describe("Offset into the events list, for pagination."),
      minutes: z.number().optional(),
    },
  },
  async ({ site, session_id, ...params }) => {
    try {
      const data = await client.getSession(site, session_id, params);
      return textResult(data);
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.registerTool(
  "rybbit_get_session_locations",
  {
    title: "Get session locations",
    description:
      "Get aggregated session counts by geographic coordinates (lat/lon, city, country) for a site, suitable for plotting on a map.",
    inputSchema: {
      site: siteIdParam,
      ...timeParamsShape,
      filters: filtersParam,
    },
  },
  async ({ site, filters, ...time }) => {
    try {
      const data = await client.getSessionLocations(site, { ...time, filters: toFilters(filters) });
      return textResult(data);
    } catch (err) {
      return errorResult(err);
    }
  }
);

// ---------- entrypoint ----------

async function main() {
  const useSse = process.argv.includes("--sse") || process.env.PORT;

  if (useSse) {
    const app = express();
    const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
    
    let transport: SSEServerTransport | null = null;

    app.get("/", (req, res) => {
      res.send(`
        <html>
          <body style="font-family: sans-serif; padding: 2rem; text-align: center;">
            <h1>✅ Rybbit MCP Server is running!</h1>
            <p>Your server is successfully deployed.</p>
            <p>The SSE endpoint for MCP clients is available at: <code>/sse</code></p>
          </body>
        </html>
      `);
    });

    app.get("/sse", async (req, res) => {
      transport = new SSEServerTransport("/messages", res);
      await server.connect(transport);
    });

    app.post("/messages", async (req, res) => {
      if (!transport) {
        res.status(400).send("Session not initialized");
        return;
      }
      await transport.handlePostMessage(req, res);
    });

    app.listen(port, "0.0.0.0", () => {
      console.log(`[rybbit-mcp] Server running on SSE at http://0.0.0.0:${port}/sse`);
    });
  } else {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("[rybbit-mcp] Server running on stdio");
  }
}

main().catch((err) => {
  console.error("[rybbit-mcp] Fatal error:", err);
  process.exit(1);
});
