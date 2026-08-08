// ============================================================================
// Zod schema example generator — produces deterministic JSON values from Zod schemas
// ============================================================================

import { z } from 'zod/v3';

/**
 * Generate a deterministic JSON example from a Zod schema.
 * Used to build the JSON template shown to the LLM in the Pass 2 prompt.
 */
export function zodExample(s: z.ZodTypeAny): unknown {
  // Handle refinements, effects, etc. by unwrapping to inner type
  let current: z.ZodTypeAny = s;
  while (
    current instanceof z.ZodEffects ||
    current._def.typeName === z.ZodFirstPartyTypeKind.ZodPipeline
  ) {
    if (current instanceof z.ZodEffects) {
      current = current._def.schema;
    } else if ('type' in current._def && current._def.type instanceof z.ZodType) {
      current = current._def.type;
    } else {
      break;
    }
  }

  // Handle optional by unwrapping
  if (current instanceof z.ZodOptional) {
    return zodExample(current._def.innerType);
  }

  // Handle nullable
  if (current instanceof z.ZodNullable) {
    return null;
  }

  // Handle defaults
  if (current instanceof z.ZodDefault) {
    return zodExample(current._def.innerType);
  }

  if (current instanceof z.ZodString) return 'string';
  if (current instanceof z.ZodNumber) return 0;
  if (current instanceof z.ZodBoolean) return false;
  if (current instanceof z.ZodEnum) return current.options[0];
  if (current instanceof z.ZodLiteral) return current._def.value;

  if (current instanceof z.ZodArray) {
    if (current._def.type) {
      return [zodExample(current._def.type)];
    }
    return [];
  }

  if (current instanceof z.ZodObject) {
    const obj: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(current.shape as Record<string, z.ZodTypeAny>)) {
      obj[k] = zodExample(v);
    }
    return obj;
  }

  if (current instanceof z.ZodUnion) {
    // For unions, use the first option's example
    return zodExample(current._def.options[0]);
  }

  // Fallback for unknown types
  return null;
}
