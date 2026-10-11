/**
 * A small Zod -> JSON Schema (draft 2020-12) translator covering exactly the
 * constructs used by `@hi/contracts`. A general converter is a dependency we do
 * not need; anything unsupported degrades to `{}` rather than emitting a lie.
 */
import { z, type ZodTypeAny } from 'zod';

type Json = Record<string, unknown>;

/* eslint-disable @typescript-eslint/no-explicit-any */
export function zodToJsonSchema(schema: ZodTypeAny): Json {
  const def = (schema as any)._def;
  const typeName: string = def?.typeName ?? '';

  switch (typeName) {
    case 'ZodString': {
      const out: Json = { type: 'string' };
      for (const check of def.checks ?? []) {
        if (check.kind === 'min') out.minLength = check.value;
        if (check.kind === 'max') out.maxLength = check.value;
        if (check.kind === 'regex') out.pattern = String(check.regex).replace(/^\/|\/[a-z]*$/g, '');
        if (check.kind === 'uuid') out.format = 'uuid';
        if (check.kind === 'url') out.format = 'uri';
        if (check.kind === 'datetime') out.format = 'date-time';
      }
      return out;
    }
    case 'ZodNumber': {
      const out: Json = { type: def.checks?.some((c: any) => c.kind === 'int') ? 'integer' : 'number' };
      for (const check of def.checks ?? []) {
        if (check.kind === 'min') out.minimum = check.value;
        if (check.kind === 'max') out.maximum = check.value;
      }
      return out;
    }
    case 'ZodBoolean': return { type: 'boolean' };
    case 'ZodLiteral': return { const: def.value };
    case 'ZodEnum': return { type: 'string', enum: [...def.values] };
    case 'ZodNativeEnum': return { type: 'string', enum: Object.values(def.values) };
    case 'ZodArray': {
      const out: Json = { type: 'array', items: zodToJsonSchema(def.type) };
      if (def.maxLength?.value != null) out.maxItems = def.maxLength.value;
      if (def.minLength?.value != null) out.minItems = def.minLength.value;
      return out;
    }
    case 'ZodObject': {
      const shape = def.shape() as Record<string, ZodTypeAny>;
      const properties: Json = {};
      const required: string[] = [];
      for (const [key, value] of Object.entries(shape)) {
        properties[key] = zodToJsonSchema(value);
        if (!isOptional(value)) required.push(key);
      }
      const out: Json = { type: 'object', properties, additionalProperties: false };
      if (required.length > 0) out.required = required;
      return out;
    }
    case 'ZodOptional': return zodToJsonSchema(def.innerType);
    case 'ZodNullable': {
      const inner = zodToJsonSchema(def.innerType);
      return { anyOf: [inner, { type: 'null' }] };
    }
    case 'ZodDefault': {
      const inner = zodToJsonSchema(def.innerType);
      return { ...inner, default: def.defaultValue() };
    }
    case 'ZodEffects': return zodToJsonSchema(def.schema);
    case 'ZodUnion': return { anyOf: (def.options as ZodTypeAny[]).map(zodToJsonSchema) };
    case 'ZodRecord': return { type: 'object', additionalProperties: zodToJsonSchema(def.valueType) };
    default: return {};
  }
}

function isOptional(schema: ZodTypeAny): boolean {
  return schema.isOptional() || schema instanceof z.ZodDefault;
}
/* eslint-enable @typescript-eslint/no-explicit-any */
