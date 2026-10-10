import type { StandardSchemaWithJSON } from "@modelcontextprotocol/server";
import { z } from "zod";

/**
 * Advertises a JSON schema in `tools/list` but never fails SDK-level
 * validation. Handlers validate themselves and return the structured
 * `INVALID_INPUT` contract instead.
 */
export function advertisedSchema(
  jsonSchema: Record<string, unknown>,
): StandardSchemaWithJSON<unknown, unknown> {
  return {
    "~standard": {
      version: 1,
      vendor: "mcp-server-web-access",
      validate: (value: unknown) => ({ value }),
      jsonSchema: {
        input: () => jsonSchema,
        output: () => jsonSchema,
      },
    },
  };
}

/** Converts a Zod input schema to a draft-2020-12 JSON schema. */
export function inputJsonSchemaOf(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, {
    target: "draft-2020-12",
    io: "input",
  }) as Record<string, unknown>;
  delete json["$schema"];
  return json;
}
