import { applyDecorators } from '@nestjs/common';
import { ApiBody, ApiQuery, ApiResponse } from '@nestjs/swagger';
import { z, type ZodType } from 'zod';
import { ZOD_SCHEMA_KEY } from './zod-validation.pipe';

/**
 * One zod schema drives THREE things: runtime validation, the OpenAPI document,
 * and the TypeScript type shared with the web app.
 *
 * That is the whole point of @eventq/contracts. Documentation cannot drift from
 * validation because neither is written by hand — both are derived.
 */

type OpenApiSchema = Record<string, unknown>;

/**
 * Converts a zod schema to an OpenAPI-compatible schema object.
 *
 * `io` matters and is not cosmetic:
 *   - 'input'  (requests)  a field with a default is NOT required — the client
 *                          may omit it and the server fills it in.
 *   - 'output' (responses) that same field IS always present, because the
 *                          server has applied the default by then.
 *
 * Getting this backwards produces documentation that tells clients to send
 * fields they should not have to send.
 */
export function toOpenApiSchema(schema: ZodType, io: 'input' | 'output'): OpenApiSchema {
  const jsonSchema = z.toJSONSchema(schema, { io }) as OpenApiSchema;

  // OpenAPI 3.1 is JSON Schema 2020-12 compatible, but the $schema key is
  // meaningless inside a components object and some tooling chokes on it.
  const { $schema: _discarded, ...rest } = jsonSchema;
  return rest;
}

/**
 * Builds a class that carries a zod schema, for use as a Nest parameter type.
 *
 * Nest resolves the `metatype` of a decorated parameter and hands it to the
 * pipe; a plain zod object is not a class, so it needs this wrapper to travel
 * through the framework's DI metadata.
 */
export function createZodDto<T extends ZodType>(schema: T): ZodDtoClass<T> {
  class ZodDto {
    static readonly [ZOD_SCHEMA_KEY] = schema;
  }
  return ZodDto as ZodDtoClass<T>;
}

export interface ZodDtoClass<T extends ZodType> {
  new (): z.infer<T>;
  readonly [ZOD_SCHEMA_KEY]: T;
}

/** Documents a JSON request body from its contract schema. */
export function ApiZodBody(schema: ZodType, description?: string) {
  return applyDecorators(
    ApiBody({
      schema: toOpenApiSchema(schema, 'input'),
      ...(description ? { description } : {}),
    }),
  );
}

/** Documents a response from its contract schema. */
export function ApiZodResponse(status: number, schema: ZodType, description?: string) {
  return applyDecorators(
    ApiResponse({
      status,
      schema: toOpenApiSchema(schema, 'output'),
      ...(description ? { description } : {}),
    }),
  );
}

/** Documents query parameters from a contract schema, one entry per key. */
export function ApiZodQuery(schema: ZodType) {
  const openApi = toOpenApiSchema(schema, 'input');
  const properties = (openApi['properties'] ?? {}) as Record<string, OpenApiSchema>;
  const required = (openApi['required'] ?? []) as string[];

  return applyDecorators(
    ...Object.entries(properties).map(([name, property]) =>
      ApiQuery({ name, required: required.includes(name), schema: property }),
    ),
  );
}
